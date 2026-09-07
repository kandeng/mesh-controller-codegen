// Long-lived kernel host for the Fastify backend. The CLI boots a host per run;
// the server boots ONE host for its whole lifetime and reuses it across requests.
// This facade wraps src/pipeline.mjs so routes stay thin, caches the last
// discovery (glb stats / dump / THREE) so validate+generate don't re-parse the
// 23MB GLB, and keeps the kernel as the system-of-record for work state.
import { mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHost } from '../src/core/host.mjs';
import { loadConfig } from '../src/config.mjs';
import { registerAllPlugins } from '../src/plugins/index.mjs';
import {
  discoverJoints, validateController, generateController, repairWithNotes,
  loadThree, toViewerUrl, refreshView, finalizeRun,
} from '../src/pipeline.mjs';
import { reopenFromRigidity, runDiscoveryLoop, runL2Round, runVisionRound } from '../src/plugins/discovery/loop.mjs';
import { saveManifest } from '../src/plugins/discovery/manifest.mjs';
import { rigidityGate } from '../src/plugins/discovery/tests.mjs';
import { focusFromManifest, planViews, VIEWPORT } from '../src/plugins/discovery/views.mjs';
import {
  MAX_FRAMES_PER_ROUND, framePath, listRounds, loadColorMap,
  savePlan, saveProposals, saveReply,
} from '../src/plugins/discovery/observations.mjs';
import { createVisionProvider } from '../src/plugins/discovery/vision-provider.mjs';
import { createSessionStore } from './session-store.mjs';

const TS = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// The next free observation round. Rounds are DIRECTORIES, so the numbering has
// to come from disk rather than from a counter a server restart would reset —
// otherwise a restart would silently start overwriting the previous run's
// evidence at r0.
function nextObservationRound(runDir) {
  const rounds = listRounds(runDir);
  return rounds.length ? Math.max(...rounds.map((r) => r.round)) + 1 : 0;
}

// Clamp an optional integer, or leave it undefined so the callee's own default
// applies. Passing `undefined` (not `null`) is what lets one object express
// "caller did not ask" for every knob at once.
const whole = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v | 0)) : undefined);

export async function createKernelHost({ configPath = null, verbose = false } = {}) {
  const cfg = loadConfig(configPath);
  const runDir = resolve(cfg.paths.runs, `app-${TS()}`);
  mkdirSync(runDir, { recursive: true });

  const host = createHost({ configPath, runDir, verbose });
  const summary = await registerAllPlugins(host);
  host.diagnostics.note('server kernel boot', { runDir, plugins: Object.values(summary).flat().length });

  // Cached state for the currently-loaded project (single active project in M1).
  const current = {
    glbPath: null,
    glb: null,      // parse stats
    dump: null,     // node dump (for the generator prompt)
    joints: [],
    spec: null,
    THREE: null,
    controller: null,
    lastValidation: null,
    manifest: null, // joint hypothesis records (phase 1 discovery loop)
  };

  const THREE = await loadThree(host);
  current.THREE = THREE;

  // Stable-path conversation/session store (survives server restarts).
  const sessionStore = createSessionStore({ repoRoot: host.repoRoot });
  sessionStore.setSession({ runDir });

  // The DSH agent supervisor is attached after boot (server/index.mjs) — the
  // kernel uses it for L2 proposal rounds; routes use it for the chat WS.
  let agent = null;

  // The browser render farm, attached the same way and for the same reason: the
  // server has no WebGL context by design, so a vision round borrows a tab's.
  let farm = null;

  const kernel = {
    host,
    runDir,
    config: host.config,
    bus: host.bus,
    context: host.context,
    assets: host.assets,
    diagnostics: host.diagnostics,
    registry: host.registry,
    resources: host.resources,
    current,
    sessionStore,
    pluginSummary: summary,

    // Discover joints for a GLB; caches the parsed mesh for later validate/generate.
    async discover(glbPath) {
      const d = await discoverJoints(host, glbPath);
      current.glbPath = d.glbPath;
      current.glb = d.stats;
      current.dump = d.dump;
      current.joints = d.joints;
      current.spec = d.spec;
      current.controller = null;
      current.lastValidation = null;
      sessionStore.setSession({ glb: d.glbPath });
      sessionStore.setWork({ joints: d.joints.map((j) => ({ id: j.id, label: j.label, type: j.type, nodeCount: (j.nodes || []).length })) });
      // Hypothesis loop (phase 1): re-type joints into manifest records, run the
      // deterministic rest-pose battery, derive statuses. On any failure the raw
      // discovery output is served as before (strangler-fig fallback).
      try {
        current.manifest = runDiscoveryLoop(current.glb, current.joints, { runDir }).manifest;
      } catch (e) {
        host.diagnostics.note('discovery loop failed — serving raw joints', { error: e.message });
        current.manifest = null;
      }
      return d;
    },

    attachAgent(a) { agent = a; },
    attachFarm(f) { farm = f; },

    // Phase 2: ONE L2 AI-proposal round over the current manifest. Resume
    // semantics — the manifest is not rebuilt, so reopen state and history
    // survive; proposals merge as candidates. Stub/unavailable agent →
    // graceful refusal, manifest untouched.
    async refineManifest() {
      if (!current.glb || !current.manifest) throw new Error('no project loaded; POST /api/project first');
      if (!agent || agent.mode !== 'live') return { ok: false, error: 'agent unavailable', added: 0 };
      const l2 = async (prompt) => (await agent.send(prompt)).reply;
      const res = await runL2Round(current.glb, current.joints, current.manifest, l2);
      saveManifest(runDir, current.manifest);
      if (res.added) {
        sessionStore.setWork({ joints: current.joints.map((j) => ({ id: j.id, label: j.label, type: j.type, nodeCount: (j.nodes || []).length })) });
      }
      host.diagnostics.note('L2 refine round', { added: res.added, warnings: res.warnings?.length || 0 });
      return { ok: true, ...res };
    },

    // Phase 3: ONE vision round — plan poses, have a browser tab draw them, let
    // a multimodal model read the frames, ground what it claims, merge what
    // survives. Resume semantics are identical to refineManifest: the manifest is
    // not rebuilt, so reopen state and history survive.
    //
    // Every refusal carries a DISTINCT `code` and sentence, because the operator
    // action differs per failure: load a mesh, start the DSH host, or open a
    // viewer tab. Collapsing them into one generic 500 would make the button
    // useless exactly when the user needs it, and phase-2 text refine still works
    // in every one of these cases — vision degrades, it never blocks.
    //
    // opts: { round, mode:'frontier'|'all'|'none', focus:[names], maxViews,
    //         minCoverage, allowGhost, ghostViews, viewport, maxFrames,
    //         maskPairs, ghostFrames, orientation, rendererId, timeoutMs }
    async visionRefine(opts = {}) {
      const refuse = (code, error, extra = {}) => ({
        ok: false, added: 0, code, error, manifestUntouched: true, ...extra,
      });

      // Collect EVERY unmet precondition instead of returning on the first one.
      // Two reasons, and the second is the one that forces it: fixing one thing,
      // re-pressing, and discovering the next is three round trips for the
      // operator — and with a stub agent the renderer guard is UNREACHABLE, so a
      // headless probe could never prove that half of the wiring is checked at
      // all. Reporting both means one probe proves both.
      const unmet = [];
      if (!current.glb || !current.manifest) {
        unmet.push({ code: 'NO_PROJECT', error: 'no project loaded; POST /api/project first' });
      }
      const provider = createVisionProvider(host.config, agent);
      if (!provider.available()) {
        unmet.push({
          code: 'NO_VISION_AGENT',
          error: provider.reason() || 'no live multimodal model is available',
          provider: provider.kind, model: provider.model(),
        });
      }
      const farmStatus = farm ? farm.status() : null;
      if (!farm) {
        unmet.push({ code: 'NO_RENDERER', error: 'the render farm is not available on this server' });
      } else if (!farmStatus.ready) {
        unmet.push({
          code: 'NO_RENDERER',
          error: `no browser renderer with a loaded model is connected (${farmStatus.renderers} attached, ${farmStatus.ready} ready) — open the viewer tab and load the mesh`,
          hint: 'phase-2 text refine (POST /api/manifest/refine) still works without a renderer',
        });
      }
      if (unmet.length) {
        // `code`/`error` name the FIRST unmet precondition, so the route can map
        // one cause to one HTTP status; `unmet` carries the rest.
        const [first] = unmet;
        return refuse(first.code, first.error, { unmet, farm: farmStatus });
      }

      // Pin the WHOLE round to one renderer. A mask and its photo are only
      // comparable if the same browser drew both: two tabs can hold different
      // meshes, and reconcile() would then be comparing a box drawn from one
      // model against the colour ids of another. pick() also guarantees the
      // renderer is idle, so the round cannot interleave with someone else's.
      const rendererId = opts.rendererId ? String(opts.rendererId) : (farm.pick()?.id ?? null);
      if (!rendererId) {
        return refuse('NO_RENDERER', 'every renderer with a loaded model is busy with another capture', { farm: farmStatus });
      }

      const round = whole(opts.round, 0, 999) ?? nextObservationRound(runDir);
      const mode = opts.mode === 'all' || opts.mode === 'none' ? opts.mode : 'frontier';
      const viewport = opts.viewport?.w ? opts.viewport : VIEWPORT;
      // An explicit focus list wins (the UI can aim a round at one joint the user
      // is arguing with); otherwise focus is derived from what discovery already
      // believes and suspects. 'none' plans against the whole model, which is the
      // "what did we miss entirely" question.
      const focusNames = Array.isArray(opts.focus) && opts.focus.length
        ? new Set(opts.focus.map(String))
        : (mode !== 'none' ? focusFromManifest(current.glb, current.manifest, current.joints, { mode }) : null);

      const planSpec = {
        maxViews: whole(opts.maxViews, 1, 64) ?? 12,
        minCoverage: Number.isFinite(opts.minCoverage) ? opts.minCoverage : 0.99,
        viewport,
        focusNames,
        allowGhost: opts.allowGhost !== false,
        ghostViews: whole(opts.ghostViews, 0, 16) ?? 4,
      };
      const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : null;

      // Which frames actually reached the model, collected as they are captured,
      // so the response can point the UI at the exact pixels behind each claim.
      const drawn = [];

      const res = await runVisionRound(current.glb, current.joints, current.manifest, {
        plan: () => planViews(current.glb, planSpec),

        capture: async (view, shotMode, focusNodes) => {
          const r = await farm.capture({
            round, view, mode: shotMode, focusNodes, viewport, rendererId, timeoutMs,
          });
          const entry = r?.frame || null;
          if (!entry) return null;
          // The stored entry carries NO bytes and its `colorMap` is a FILENAME.
          // Read both back off disk rather than keeping them in memory: the
          // prompt is then built from exactly the artefact that was persisted, so
          // the frame the model saw and the frame a human opens later are
          // provably the same file, and a 12-frame round does not hold 24MB of
          // base64 in the kernel for the length of the turn.
          const file = framePath(runDir, round, entry.id);
          if (!file) return null;
          drawn.push({ id: entry.id, mode: entry.mode, viewId: entry.viewId ?? view.id, url: toViewerUrl(host, runDir, file) });
          return {
            ...entry,
            dataBase64: readFileSync(file).toString('base64'),
            colorMap: entry.colorMap ? loadColorMap(runDir, round, entry.id) : null,
          };
        },

        propose: (text, images) => provider.send(text, images),

        viewport,
        maxFrames: whole(opts.maxFrames, 1, MAX_FRAMES_PER_ROUND),
        maskPairs: whole(opts.maskPairs, 0, 12),
        ghostFrames: whole(opts.ghostFrames, 0, 12),
        orientation: whole(opts.orientation, 0, 12),

        persist: {
          // The plan is the round's own evidence: which poses were asked for,
          // what each was expected to buy, and who drew them.
          plan: (p) => savePlan(runDir, round, {
            ...p, mode, focus: focusNames ? [...focusNames] : null, rendererId,
          }),
          // Deliberately a no-op. POST /api/observe/frame writes the bytes BEFORE
          // it resolves the waiting capture, so by the time the loop sees a frame
          // it is already on disk and indexed; re-saving would rewrite the same
          // file and the same entry for nothing.
          frame: () => {},
          reply: (r) => saveReply(runDir, round, r),
          proposals: (p) => saveProposals(runDir, round, p),
        },
      });

      // Only a round that actually merged something may write the manifest: a
      // refused round must leave the on-disk record byte-identical, so a human
      // can trust that a failed button press changed nothing.
      if (res.ok && res.manifestUntouched === false) saveManifest(runDir, current.manifest);
      if (res.added) {
        sessionStore.setWork({ joints: current.joints.map((j) => ({ id: j.id, label: j.label, type: j.type, nodeCount: (j.nodes || []).length })) });
      }
      host.diagnostics.note('vision refine round', {
        round, ok: res.ok, code: res.code || null, added: res.added,
        frames: res.frames ?? 0, views: res.views ?? 0, warnings: res.warnings?.length || 0,
      });

      const frameUrls = drawn;
      if (!res.ok) {
        return { ...res, error: res.reason || res.error || 'the vision round failed', round, rendererId, provider: provider.kind, frameUrls, farm: farm.status() };
      }
      return {
        ...res,
        round,
        rendererId,
        provider: provider.kind,
        model: res.model || provider.model(),
        frameUrls,
        farm: farm.status(),
      };
    },

    // Validate a controller file against the cached mesh.
    async validate(file) {
      if (!current.glb) throw new Error('no project loaded; POST /api/project first');
      const abs = resolve(host.repoRoot, file);
      const r = await validateController(host, abs, { glb: current.glb, THREE });
      // Rigidity gate: drive the candidate controller on a full-TRS scene and
      // verify relative-pose invariance per joint (automated tear-off check).
      let rigidity = null;
      try {
        rigidity = await rigidityGate(current.glb, abs, current.joints, THREE);
      } catch (e) {
        rigidity = { pass: false, error: e.message, results: [] };
      }
      // Reopen edge (phase 2): a failing declared set falsifies the manifest
      // record it maps to — status regresses with the failing evidence.
      let reopened = [];
      if (current.manifest && rigidity && rigidity.pass === false && Array.isArray(rigidity.results)) {
        const rr = reopenFromRigidity(current.manifest, rigidity);
        reopened = rr.reopened;
        if (rr.skipped.length) host.diagnostics.note('rigidity reopen skipped', { skipped: rr.skipped });
        if (reopened.length) {
          saveManifest(runDir, current.manifest);
          host.diagnostics.note('manifest reopened by rigidity gate', { reopened });
        }
      }
      current.controller = abs;
      current.lastValidation = { ...r, rigidity, reopened };
      return { ...r, rigidity, reopened, controller: abs, controllerUrl: toViewerUrl(host, runDir, abs) };
    },

    // Bounded generate->validate loop (DSH). onRound streams to the caller.
    // When `out` is given, the accepted controller is also written to that
    // user-chosen destination (mirrors the CLI's --out) and becomes the active
    // controller, so the viewer + knobs drive the file the user asked for.
    async generate({ lang = 'javascript', model = null, rounds = 1, onRound = null, out = null } = {}) {
      if (!current.glb) throw new Error('no project loaded; POST /api/project first');
      const gen = await generateController(host, {
        glbPath: current.glbPath, glb: current.glb, dump: current.dump,
        runDir, lang, model, rounds, THREE, onRound,
      });
      let controller = gen.controller;
      if (out) {
        const outAbs = resolve(host.repoRoot, out);
        mkdirSync(dirname(outAbs), { recursive: true });
        copyFileSync(gen.controller, outAbs);
        controller = outAbs;
      }
      current.controller = controller;
      current.lastValidation = { pass: gen.failures.length === 0, failures: gen.failures, warnings: gen.warnings, metrics: gen.metrics };
      return { ...gen, controller };
    },

    // One human-note repair round (interactive gate over WS).
    async repair({ humanNotes, model = null, lang = 'javascript' }) {
      if (!current.controller) throw new Error('nothing to repair; generate or validate first');
      const r = await repairWithNotes(host, {
        glbPath: current.glbPath, glb: current.glb, dump: current.dump, runDir,
        controller: current.controller, humanNotes, prevCode: null, model, lang, THREE,
      });
      current.lastValidation = r;
      return r;
    },

    // Refresh controller.view.js + return the viewer URLs for the current project.
    viewerUrls() {
      const out = { glb: current.glbPath ? toViewerUrl(host, runDir, current.glbPath) : null, ctl: null };
      if (current.controller) {
        const viewFile = refreshView(runDir, current.controller);
        out.ctl = toViewerUrl(host, runDir, viewFile);
      }
      return out;
    },

    finalize({ accepted, roundsUsed = 0, lang = 'javascript', model = null, failures = [], warnings = [], metrics = {}, controller = null }) {
      return finalizeRun(host, {
        runDir, accepted, roundsUsed, lang, model, failures, warnings, metrics,
        controller: controller || current.controller, joints: current.joints,
      });
    },

    async shutdown(signal = 'server') { return host.shutdown(signal); },
  };

  return kernel;
}

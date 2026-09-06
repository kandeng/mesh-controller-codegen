// Long-lived kernel host for the Fastify backend. The CLI boots a host per run;
// the server boots ONE host for its whole lifetime and reuses it across requests.
// This facade wraps src/pipeline.mjs so routes stay thin, caches the last
// discovery (glb stats / dump / THREE) so validate+generate don't re-parse the
// 23MB GLB, and keeps the kernel as the system-of-record for work state.
import { mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHost } from '../src/core/host.mjs';
import { loadConfig } from '../src/config.mjs';
import { registerAllPlugins } from '../src/plugins/index.mjs';
import {
  discoverJoints, validateController, generateController, repairWithNotes,
  loadThree, toViewerUrl, refreshView, finalizeRun,
} from '../src/pipeline.mjs';
import { reopenFromRigidity, runDiscoveryLoop, runL2Round } from '../src/plugins/discovery/loop.mjs';
import { saveManifest } from '../src/plugins/discovery/manifest.mjs';
import { rigidityGate } from '../src/plugins/discovery/tests.mjs';
import { createSessionStore } from './session-store.mjs';

const TS = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

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

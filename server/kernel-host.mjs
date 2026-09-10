// Long-lived kernel host for the Fastify backend. The CLI boots a host per run;
// the server boots ONE host for its whole lifetime and reuses it across requests.
// This facade wraps src/pipeline.mjs so routes stay thin, caches the last
// discovery (glb stats / dump / THREE) so validate+generate don't re-parse the
// 23MB GLB, and keeps the kernel as the system-of-record for work state.
import { mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHost } from '../src/core/host.mjs';
import { CATEGORY } from '../src/core/registry.mjs';
import { loadConfig } from '../src/config.mjs';
import { registerAllPlugins } from '../src/plugins/index.mjs';
import {
  discoverJoints, validateController, generateController, repairWithNotes,
  loadThree, toViewerUrl, refreshView, finalizeRun,
} from '../src/pipeline.mjs';
import { reopenFromRigidity, runDiscoveryLoop, runL2Round, runVisionCampaign, runMotionRound, applyJointVerdict, amortizeVerdict, reconcileLanes, admitCandidates, refineJoint, MAX_EXTRA_VIEWS, MAX_VISION_ROUNDS, MOTION_ANGLES } from '../src/plugins/discovery/loop.mjs';
import { saveManifest, saveRevision, listRevisions, loadRevision, latestRevision, diffManifests } from '../src/plugins/discovery/manifest.mjs';
import { rigidityGate } from '../src/plugins/discovery/tests.mjs';
import { focusFromManifest, modelRadius, modelTarget, planViews, VIEWPORT } from '../src/plugins/discovery/views.mjs';
import { AMORTIZABLE, peersOf, symmetryGroups } from '../src/plugins/discovery/symmetry.mjs';
import {
  MAX_FRAMES_PER_ROUND, framePath, listRounds, loadColorMap, loadRound,
  saveExpectation, saveMotion, savePlan, saveProposals, saveReply,
} from '../src/plugins/discovery/observations.mjs';
import { createVisionProvider } from '../src/plugins/discovery/vision-provider.mjs';
import { createSessionStore } from './session-store.mjs';
import { attachmentsDir, readImages } from './attachments.mjs';

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

  // Phase 3 task 19: freeze the manifest as a numbered revision on the TIME axis.
  // Called after EVERY write that changes what we believe — a loop round, a
  // verdict, an amortization, a rigidity reopen — so the graph's history is
  // replayable and diffable with no VCS. `parent` defaults to the trunk (the
  // latest revision); a caller re-running from an earlier state names a parent
  // and gets a branch. A refusal path never reaches here, so a failed write
  // leaves no phantom revision behind.
  const commitRevision = (note, opts = {}) => {
    if (!runDir || !current.manifest) return null;
    return saveRevision(runDir, current.manifest, { note, ...opts });
  };

  // The browser render farm, attached the same way and for the same reason: the
  // server has no WebGL context by design, so a vision round borrows a tab's.
  let farm = null;
  // Single-flight guard for the chained (auto) refinement: a load must not stack
  // a second pair of producer lanes on top of one still looking.
  let autoRunning = false;
  // Load generation. A vision campaign plans, captures and merges against ONE
  // project; a reload swaps current.joints/current.manifest for fresh arrays,
  // so a campaign still in flight would merge into ORPHANED arrays and its save
  // would then persist the new project's manifest while reporting the old
  // campaign's additions — a success message about nothing. Every load bumps
  // this before its first await, and every long-running op compares against the
  // value it started with.
  let loadGen = 0;
  // Human-in-the-loop, staged. The refinement yields at every boundary (after
  // stage 1 and after each joint) so the assistant can serve what queued up; a
  // human STOP rides the same seam and takes effect at the NEXT boundary. Unlike
  // the old one-shot stop it discards nothing: joints refined so far were saved
  // and revised at their own boundary, so "stop" means "no further joints".
  let refineAbort = false;   // a human asked the in-flight refinement to stop
  // How long a boundary waits for the assistant to finish serving the queue. A
  // chatty user must not park discovery forever; the FIFO chain keeps ordering
  // safe if the cap hits mid-turn (the next lane prompt simply chains behind).
  const YIELD_MS = 120_000;
  // Server-originated WS push. The events socket decorates the Fastify app with
  // broadcast(), but the kernel must not reach into the app, so index.mjs hands
  // the decorated function down the same way it hands down the render farm.
  let broadcastFn = () => {};
  const broadcast = (obj) => { try { broadcastFn(obj); } catch { /* a dead socket must never kill a round */ } };

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
      // Bump BEFORE any await: a campaign in flight must notice the new load the
      // moment it starts, not after it has already merged and saved.
      loadGen += 1;
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
        current.manifest = runDiscoveryLoop(current.glb, current.joints, { runDir, score: false }).manifest;
        commitRevision('discovery loop (project load) — candidates, battery deferred to stage 2');
      } catch (e) {
        host.diagnostics.note('discovery loop failed — serving raw joints', { error: e.message });
        current.manifest = null;
      }
      return d;
    },

    attachAgent(a) { agent = a; },
    attachFarm(f) { farm = f; },
    attachBroadcast(f) { if (typeof f === 'function') broadcastFn = f; },

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
      commitRevision('L2 AI-proposal round');
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
      const gen = loadGen;

      // A LANE CALL. The orchestrator (autoRefine) runs this method against a
      // CLONE of the manifest, because two producers that share one array are two
      // producers that read each other's conclusions — and it owns the ONE save +
      // revision that follows both lanes. So a lane call writes where it is told
      // and defers the commit; a direct call (the button, the HTTP route) behaves
      // exactly as it always did.
      const lane = opts.lane || null;
      const defer = !!lane;
      const manifest = Array.isArray(lane?.manifest) ? lane.manifest : current.manifest;
      const joints = Array.isArray(lane?.joints) ? lane.joints : current.joints;

      // Collect EVERY unmet precondition instead of returning on the first one.
      // Two reasons, and the second is the one that forces it: fixing one thing,
      // re-pressing, and discovering the next is three round trips for the
      // operator — and with a stub agent the renderer guard is UNREACHABLE, so a
      // headless probe could never prove that half of the wiring is checked at
      // all. Reporting both means one probe proves both.
      const unmet = [];
      // A failed geometry pass leaves `current.manifest` null. That is a reason the
      // TEXT lane has nothing to refine and NO reason for the vision lane to
      // refuse: an observer that looks at the mesh rather than at another
      // producer's conclusions has everything it needs, and a mesh whose geometry
      // pass threw is precisely the mesh that most needs a second opinion. So the
      // only project precondition is a parsed mesh to render; with no manifest we
      // adopt an empty one and look anyway.
      let adoptedEmptyManifest = false;
      if (!current.glb) {
        unmet.push({ code: 'NO_PROJECT', error: 'no project loaded; POST /api/project first' });
      } else if (!Array.isArray(current.manifest)) {
        current.manifest = [];
        if (!Array.isArray(current.joints)) current.joints = [];
        adoptedEmptyManifest = true;
        host.diagnostics.note('vision refine ran with no geometry baseline', {
          glbPath: current.glbPath,
          reason: 'the discovery loop left no manifest, so the vision lane started from an empty one',
        });
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
      // Phase 3 task 16: the round is now a CAMPAIGN. `round` is the directory the
      // first round writes to, and each further round takes the next one — so a
      // two-round press leaves r0 (the survey) and r1 (the close-ups) side by side
      // and a human can see exactly what the second look was bought for.
      const rounds = whole(opts.rounds, 1, MAX_VISION_ROUNDS) ?? MAX_VISION_ROUNDS;
      const extraViews = whole(opts.extraViews, 0, MAX_EXTRA_VIEWS) ?? MAX_EXTRA_VIEWS;
      // INDEPENDENT LANE. The other producer's conclusions are withheld from the
      // prompt and stop blocking proposals at the gate (see vision-prompt.mjs and
      // propose-core.mjs), so this lane reports what it SEES rather than what the
      // project already believes. Off by default: the manual "refine what is
      // doubtful" button is a follow-up look and legitimately stands on what is
      // already known.
      const independent = opts.independent === true;
      const askedMode = opts.mode === 'all' || opts.mode === 'none' ? opts.mode : null;
      // An independent lane plans against the WHOLE model unless told otherwise:
      // 'frontier' aims the survey at the parts the OTHER producer is unsure
      // about, and "where should I look" is itself a conclusion this lane must not
      // inherit. An explicit opts.mode still wins — a caller that asks for both
      // gets what it asked for rather than a silent override.
      const mode = askedMode || (independent ? 'none' : 'frontier');
      const viewport = opts.viewport?.w ? opts.viewport : VIEWPORT;
      // An explicit focus list wins (the UI can aim a round at one joint the user
      // is arguing with); otherwise focus is derived from what discovery already
      // believes and suspects. 'none' plans against the whole model, which is the
      // "what did we miss entirely" question.
      const focusNames = Array.isArray(opts.focus) && opts.focus.length
        ? new Set(opts.focus.map(String))
        : (mode !== 'none' ? focusFromManifest(current.glb, manifest, joints, { mode }) : null);

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
      // `round` is carried per frame because a campaign spans several directories
      // and the observation browser groups by them.
      const drawn = [];

      const res = await runVisionCampaign(current.glb, joints, manifest, {
        plan: () => planViews(current.glb, planSpec),

        // The campaign passes its own round index as the fourth argument; that is
        // what routes this round's frames to their own directory.
        capture: async (view, shotMode, focusNodes, campaignRound = 0) => {
          const rnd = round + campaignRound;
          const r = await farm.capture({
            round: rnd, view, mode: shotMode, focusNodes, viewport, rendererId, timeoutMs,
          });
          const entry = r?.frame || null;
          if (!entry) return null;
          // The stored entry carries NO bytes and its `colorMap` is a FILENAME.
          // Read both back off disk rather than keeping them in memory: the
          // prompt is then built from exactly the artefact that was persisted, so
          // the frame the model saw and the frame a human opens later are
          // provably the same file, and a 12-frame round does not hold 24MB of
          // base64 in the kernel for the length of the turn.
          const file = framePath(runDir, rnd, entry.id);
          if (!file) return null;
          drawn.push({
            id: entry.id, mode: entry.mode, round: rnd, viewId: entry.viewId ?? view.id,
            url: toViewerUrl(host, runDir, file),
          });
          // Live beat for the 3D theater: the frame is on disk and URL-addressable
          // NOW, so the browser can show the exact pixels the model is about to be
          // handed, at the pose they were drawn from. Emit-only. The full camera
          // rig (eye, look direction, range, FOV) rides along so the chat can
          // annotate the shot with WHERE the virtual camera actually was instead
          // of a bare "I looked at it".
          try {
            const eye = view?.pose?.eye || null;
            const tgt = view?.pose?.target || null;
            const range = Array.isArray(eye) && Array.isArray(tgt)
              ? Math.hypot(eye[0] - tgt[0], eye[1] - tgt[1], eye[2] - tgt[2])
              : null;
            broadcast({
              kind: 'vision:frame', round: rnd, id: entry.id, mode: entry.mode,
              viewId: entry.viewId ?? view.id, url: drawn[drawn.length - 1].url,
              eye, target: tgt,
              distance: Number.isFinite(view?.spec?.distance) ? view.spec.distance : range,
              azimuth: Number.isFinite(view?.spec?.azimuth) ? view.spec.azimuth : null,
              elevation: Number.isFinite(view?.spec?.elevation) ? view.spec.elevation : null,
              fov: Number.isFinite(viewport?.fov) ? viewport.fov : null,
            });
          } catch { /* a dead socket must never kill a capture */ }
          return {
            ...entry,
            dataBase64: readFileSync(file).toString('base64'),
            colorMap: entry.colorMap ? loadColorMap(runDir, rnd, entry.id) : null,
          };
        },

        propose: (text, images) => provider.send(text, images),

        // LIVE progress tap: every observable beat of the campaign is broadcast
        // over the events WS so the 3D view can animate the look-around as it
        // happens. Emit-only — the kernel's decisions are unchanged by it.
        emit: (kind, payload) => { broadcast({ kind, round, ...payload }); },

        // Cancellation, not decoration: a reload mid-campaign orphans the arrays
        // the merge writes into, so the loop stops spending frames the moment the
        // project it was aimed at is gone. A human STOP rides the same predicate —
        // scoped to THIS call via opts.humanAbort, so a standalone vision round is
        // never aborted by a flag that was set for some other refinement.
        abort: () => gen !== loadGen || opts.humanAbort?.() === true,

        // Human steering notes, read at the ask boundary and folded into the prompt.
        humanNotes: typeof opts.humanNotes === 'function' ? opts.humanNotes : null,

        // The pictures behind those notes. Attached AFTER the rendered frames and
        // described to the model as not-frames: a proposal must still cite a frame
        // we drew, because that is the only frame grounding has a camera pose for.
        extraImages: Array.isArray(opts.extraImages) && opts.extraImages.length ? opts.extraImages : null,

        independent,
        stopAfter: opts.stopAfter || null,

        viewport,
        maxFrames: whole(opts.maxFrames, 1, MAX_FRAMES_PER_ROUND),
        maskPairs: whole(opts.maskPairs, 0, 12),
        ghostFrames: whole(opts.ghostFrames, 0, 12),
        orientation: whole(opts.orientation, 0, 12),
        rounds,
        extraViews,
        maxRegions: whole(opts.maxRegions, 1, 8),
        perRegion: whole(opts.perRegion, 1, 4),

        // Which round DIRECTORY each campaign round wrote into, so the records it
        // adds can say where their evidence lives. Without this the observation
        // browser has to scan every campaign for a frame id and cannot always
        // tell two identically-numbered frames apart.
        evidenceRound: (campaignRound = 0) => round + campaignRound,

        // A FACTORY, not an object: round 2 must not write into round 1's
        // directory, or the frames behind the first claim would be overwritten by
        // the ones behind the second and the evidence trail would be a lie.
        persist: (campaignRound = 0) => {
          const rnd = round + campaignRound;
          return {
            // The plan is the round's own evidence: which poses were asked for,
            // what each was expected to buy, and who drew them. A round-2 plan
            // additionally carries the regions it was aimed at and why.
            plan: (p) => savePlan(runDir, rnd, {
              ...p, mode: campaignRound === 0 ? mode : 'close-up',
              // Round 2's focus is its `regions` — recording round 1's focusNames
              // against it would say the close-ups covered the whole frontier.
              focus: campaignRound === 0 && focusNames ? [...focusNames] : null,
              rendererId, baseRound: round,
            }),
            // Deliberately a no-op. POST /api/observe/frame writes the bytes BEFORE
            // it resolves the waiting capture, so by the time the loop sees a frame
            // it is already on disk and indexed; re-saving would rewrite the same
            // file and the same entry for nothing.
            frame: () => {},
            reply: (r) => saveReply(runDir, rnd, r),
            proposals: (p) => saveProposals(runDir, rnd, p),
            // The category prior and its outcome, beside the frames that produced
            // it: a guess is only auditable if the guess is on the record too.
            expectation: (x) => saveExpectation(runDir, rnd, x),
          };
        },
      });

      // The merge wrote into the arrays this campaign was handed. If a load
      // swapped current.* underneath it, those arrays are no longer the served
      // state: saving now would persist the NEW project's manifest while the
      // response claims the OLD campaign's additions. Refuse, and let the new
      // project's own geometry result stand untouched.
      if (gen !== loadGen) {
        return refuse('PROJECT_RELOADED', 'the mesh was reloaded while the vision campaign was running; nothing was merged', {
          rounds: (res.rounds || []).map((x) => ({ round: x.round, ok: x.ok, added: x.added || 0 })),
        });
      }

      // Only a campaign that actually merged something may write the manifest: a
      // refused round must leave the on-disk record byte-identical, so a human
      // can trust that a failed button press changed nothing. A LANE call writes
      // nothing at all here — the orchestrator commits once, after both lanes.
      if (!defer && res.ok && res.manifestUntouched === false) {
        saveManifest(runDir, manifest);
        commitRevision(`vision campaign (${res.roundCount ?? 1} round(s), +${res.added ?? 0} record(s))`);
      }
      if (!defer && res.added) {
        sessionStore.setWork({ joints: current.joints.map((j) => ({ id: j.id, label: j.label, type: j.type, nodeCount: (j.nodes || []).length })) });
      }
      host.diagnostics.note('vision refine campaign', {
        round, rounds: res.roundCount, ok: res.ok, code: res.code || null, added: res.added,
        extraViews: res.extraViews, stop: res.stop || null,
        frames: res.frames ?? 0, views: res.views ?? 0, warnings: res.warnings?.length || 0,
        independent, category: res.expectation?.category || null,
      });

      const frameUrls = drawn;
      // Per-round detail is trimmed to what a response body should carry; the full
      // grounded/admitted/rejected trail for each round is on disk under r<N>/.
      const roundSummary = (res.rounds || []).map((x) => ({
        round: round + x.round, index: x.round, ok: x.ok, added: x.added, confirms: x.confirms,
        views: x.views, shots: x.shots, frames: x.frames, regions: x.regions,
        code: x.code || null, reason: x.reason || null, model: x.model, ms: x.ms,
      }));
      if (!res.ok) {
        return {
          ...res, rounds: roundSummary, error: res.reason || res.error || 'the vision round failed',
          round, rendererId, provider: provider.kind, frameUrls, farm: farm.status(),
          independent, noGeometryBaseline: adoptedEmptyManifest,
        };
      }
      return {
        ...res,
        rounds: roundSummary,
        round,
        rendererId,
        provider: provider.kind,
        model: res.model || provider.model(),
        frameUrls,
        farm: farm.status(),
        independent,
        // Reported rather than hidden: a run with no geometry baseline produced
        // every record it has from pixels alone, which is what a human reading the
        // joint list needs to know before judging one.
        noGeometryBaseline: adoptedEmptyManifest,
      };
    },

    // STAGED discovery, fire-and-forget right after a successful load. It NEVER
    // fails the load: every unmet precondition becomes a skip broadcast for the
    // stage it belongs to, and the geometry candidates stand.
    //
    //   stage 1  the geometry pass (already admitted at load, unscored) unions
    //            with ONE proposals-only vision look through the overlap merge;
    //            every record lands as a `candidate` — listed, dimmed, not
    //            clickable — and the list goes live at once.
    //   boundary the assistant serves whatever queued up while stage 1 looked.
    //   stage 2  one joint at a time: the physics battery plus the vision lane's
    //            grounding over the stage-1 frames; each settled row becomes
    //            clickable at its own save+revision+beat, then the queue is
    //            served again and the LIVE list is re-read — so a request that
    //            was just answered can drop or postpone what is left to do.
    //
    // There is exactly ONE writer of the manifest and one commit per boundary:
    // two producers merging concurrently would interleave the battery, the
    // node-set dedupe and the id allocation, and would leave two revisions
    // describing one change of belief.
    //
    // The agent boots LAZILY (mode flips stub->live inside its first start()), so
    // gating on provider.available() up front would always skip on a cold server;
    // stage 1 therefore awaits the SAME bounded boot and renderer wait the
    // one-shot lane had. A boot failure is a skip carrying the true reason,
    // never a silent no-op — and stage 2 still scores the geometry candidates,
    // so a server with no model at all ends with a clickable, honest list.
    async autoRefine(opts = {}) {
      if (autoRunning) return { ok: false, code: 'ALREADY_RUNNING' };
      autoRunning = true;
      const gen = loadGen;
      // A fresh refinement starts with a clean slate: a stop left over from a
      // PREVIOUS run must never leak into this one.
      refineAbort = false;
      const skip = (code, error) => {
        broadcast({ kind: 'refine:skip', code, error });
        return { ok: false, code, error };
      };
      try {
        if (!current.glb) return skip('NO_PROJECT', 'no project loaded; POST /api/project first');
        // A failed geometry pass leaves the manifest null. That is a reason the
        // TEXT lane has nothing to refine and no reason to stop LOOKING: both
        // lanes get an empty baseline and everything they find arrives as a
        // proposal from pixels or from the node dump alone.
        if (!Array.isArray(current.manifest)) current.manifest = [];
        if (!Array.isArray(current.joints)) current.joints = [];

        const bootMs = Number.isFinite(opts.bootMs) ? opts.bootMs : 35000;
        const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 20000;
        // ONE boot, awaited by both lanes. Racing it against a deadline keeps a
        // hung handshake from parking the refinement forever.
        const boot = Promise.race([
          (async () => { try { if (agent?.ensureSession) await agent.ensureSession(); } catch (e) { return e; } return null; })(),
          new Promise((r) => setTimeout(() => r(new Error(`the assistant host did not boot within ${Math.round(bootMs / 1000)}s`)), bootMs)),
        ]);
        // Awaited ONLY by the vision lane, so the text lane is never held up by a
        // browser tab that is slow to announce itself (or never will).
        const renderer = (async () => {
          if (!farm) return false;
          const deadline = Date.now() + waitMs;
          while (!farm.status()?.ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
          return !!farm.status()?.ready;
        })();

        const wantVision = opts.vision !== false;
        const emit = (kind, payload) => { broadcast({ kind, ...payload }); };
        // Name the remote model on the opening beat so the client's live status
        // line can say WHICH model DSH is waiting on, rather than a generic
        // "please wait". The vision lane may route images to a distinct
        // vision_model override; when it is empty, image turns use `model`.
        emit('refine:start', {
          auto: true,
          lanes: { text: true, vision: wantVision },
          model: host.config.model || null,
          visionModel: host.config.visionModel || host.config.model || null,
          staged: true,
        });

        // A BOUNDARY YIELD. The assistant and the lanes share ONE FIFO turn chain,
        // so a queued user turn always completes before the next lane prompt even
        // without this wait; what the wait buys is a moment where the assistant
        // has the floor to ITSELF — long enough to answer what queued up, and to
        // let a served request reshape the plan — before the next stage reads the
        // plan again. Bounded, because a chatty user must not park discovery
        // forever, and ordering stays safe if the cap hits mid-turn.
        const yieldToQueue = async () => {
          if (!agent?.idle) return;
          await Promise.race([agent.idle(), new Promise((r) => setTimeout(r, YIELD_MS))]);
        };
        const reloaded = () => gen !== loadGen;
        const endReloaded = () => {
          emit('refine:end', {
            ok: false, code: 'PROJECT_RELOADED', added: 0, agreed: 0, staged: true,
            text: { added: 0, ok: false }, vision: { added: 0, ok: false },
          });
          return {
            ok: false, code: 'PROJECT_RELOADED',
            error: 'the mesh was reloaded while the producers were running; nothing was merged',
          };
        };

        // ---- STAGE 1: candidates ----------------------------------------------
        // The geometry pass admitted its records at load with the battery deferred
        // (score:false), so current.manifest already holds unscored candidates —
        // the JSON side's rough answer. The vision lane now looks ONCE and stops
        // at its proposals; the two sets union through the overlap merge so a part
        // both producers found is ONE candidate, and everything lands unscored.
        // The list goes live immediately, dimmed and not clickable.
        //
        // The transcript WATERMARK for a steered second look, taken before stage 1
        // asks anything: "what did the human say while the first look was in
        // flight" is then exactly the user entries whose seq is above this one —
        // no clock, no guessing, and a message sent BEFORE the run is not mistaken
        // for steering of it.
        const guidanceMark = sessionStore.seq();
        let vision = null;
        if (wantVision) {
          // Give the assistant host and a browser renderer the same grace period
          // the one-shot lane had: right after a load the tab may not have
          // announced itself to the farm yet, and a provider check NOW would
          // refuse a lane that would have been live two seconds later.
          await Promise.all([boot, renderer]);
          if (reloaded()) return endReloaded();
          const cloneM = current.manifest.map((r) => ({
            ...r, nodes: [...(r.nodes || [])], evidence: [...(r.evidence || [])],
            tests: [...(r.tests || [])], history: [...(r.history || [])],
          }));
          const cloneJ = current.joints.map((j) => ({ ...j, nodes: [...(j.nodes || [])] }));
          const v = await kernel.visionRefine({
            rounds: 1,
            stopAfter: 'proposals',
            lane: { manifest: cloneM, joints: cloneJ },
            independent: true,
            humanAbort: () => refineAbort,
          });
          if (v?.ok && v.stopped === 'proposals') {
            vision = v;
          } else {
            emit('vision:skip', {
              code: v?.code || 'VISION_FAILED',
              error: v?.error || v?.reason || 'the vision lane could not look',
            });
          }
        }
        if (reloaded()) return endReloaded();
        // A stop before anything was committed commits nothing — there is nothing
        // to keep yet, so the old "discard everything" reading still holds here.
        if (refineAbort) {
          emit('refine:end', {
            ok: false, code: 'HUMAN_STOPPED', added: 0, agreed: 0, stopped: true, staged: true,
            text: { added: 0, ok: false }, vision: { added: 0, ok: false },
          });
          return { ok: false, code: 'HUMAN_STOPPED', stopped: true, error: 'a human stopped the refinement before stage 1 settled; nothing was merged' };
        }

        const reconciled = reconcileLanes(
          current.manifest,
          { records: vision?.proposals || [], confirms: vision?.confirmList || [] },
          { origin: 'L2-vision', tag: 'cross-producer:L2-vision' },
        );
        const admitted = admitCandidates(current.joints, current.manifest, reconciled);
        // The vision grounding per candidate, zipped by node set: a vision record's
        // nodes ARE the names grounding resolved, so the set is the identity.
        // MUTABLE on purpose: a steered second look grounds its own proposals
        // against its own frames, and those entries have to be findable through the
        // same zip or the candidates it adds would reach the battery with no vision
        // evidence behind them at all.
        const visionGrounded = [...(vision?.grounded || [])];
        const groundedFor = (rec) => {
          const key = [...(rec.nodes || [])].sort().join('|');
          const e = visionGrounded.find((x) => [...(x.names || [])].sort().join('|') === key);
          return e ? { ...e.grounding, frameId: e.frameId, uncertainties: e.uncertainties } : null;
        };
        saveManifest(runDir, current.manifest);
        commitRevision(`stage 1: ${current.manifest.length} candidate(s) — vision +${admitted.added}, agreed ${reconciled.agreed.length}`);
        sessionStore.setWork({ joints: current.joints.map((j) => ({ id: j.id, label: j.label, type: j.type, nodeCount: (j.nodes || []).length })) });
        emit('discover:candidates', {
          count: current.manifest.length,
          added: admitted.added,
          agreed: reconciled.agreed.length,
          category: vision?.expectation?.category || null,
          gaps: vision?.gaps || null,
        });

        // ---- STEERED SECOND LOOK — only when the human said something ----------
        // Stage 1 is ONE composed turn: a message that arrives while it is running
        // cannot edit a prompt that was already sent, and stage 2 has no model turn
        // at all — it is the deterministic battery over frames that already exist.
        // Left alone, an instruction sent mid-detection is answered BESIDE the run
        // and never reaches it. This is the one boundary where folding it in is
        // both cheap and honest: the candidate list is committed, but no joint has
        // been measured yet, so a second proposals-only look can only ADD to the
        // list — nothing already promised to the human is invalidated, and nothing
        // already measured has to be re-measured.
        //
        // It runs BEFORE `discover:stage 2` on purpose. That beat is what releases
        // the camera lock, and this look renders frames; and since the assistant and
        // the lanes share ONE FIFO turn chain, the human's queued turn is served
        // first and this prompt chains behind it — the model reads the instruction
        // as guidance while the human is reading its answer.
        //
        // It costs one extra model turn, and only when there is something to fold:
        // an idle run pays nothing and behaves exactly as it did before.
        const guidance = sessionStore.guidanceSince(guidanceMark);
        // What the extra look bought, kept for the closing beat: refine:end reports
        // the whole job, and a candidate that only exists because a human asked for
        // it should be countable as such.
        let steered = null;
        if (guidance.length && wantVision && !refineAbort && !reloaded()) {
          const notes = guidance.map((x) => x.text);
          // The screenshots behind those words, read from the SAME stable path the
          // chat read them from, so the model is shown the picture the human sees.
          const extraImages = readImages(
            attachmentsDir(host.repoRoot),
            guidance.flatMap((x) => x.attachments),
          );
          emit('discover:look', { look: 2, steered: true, notes: notes.length, images: extraImages.length });
          const cloneM2 = current.manifest.map((r) => ({
            ...r, nodes: [...(r.nodes || [])], evidence: [...(r.evidence || [])],
            tests: [...(r.tests || [])], history: [...(r.history || [])],
          }));
          const cloneJ2 = current.joints.map((j) => ({ ...j, nodes: [...(j.nodes || [])] }));
          const v2 = await kernel.visionRefine({
            rounds: 1,
            stopAfter: 'proposals',
            lane: { manifest: cloneM2, joints: cloneJ2 },
            independent: true,
            humanAbort: () => refineAbort,
            humanNotes: () => notes,
            extraImages,
          });
          if (v2?.ok && v2.stopped === 'proposals') {
            const rec2 = reconcileLanes(
              current.manifest,
              { records: v2.proposals || [], confirms: v2.confirmList || [] },
              // A distinct tag: the audit trail should be able to say which
              // candidates arrived because a human asked for a second look.
              { origin: 'L2-vision', tag: 'steered:L2-vision' },
            );
            // The tag reconcileLanes was given only lands on CONFIRMS — a record the
            // lane newly minted keeps the evidence the gate stamped on it — so the
            // steered origin is pushed here, before admission. Without it the audit
            // trail cannot tell a candidate that exists because a human asked for a
            // second look from one the first look found on its own.
            for (const rec of rec2.records) {
              rec.evidence = Array.isArray(rec.evidence) ? rec.evidence : [];
              if (!rec.evidence.includes('steered:L2-vision')) rec.evidence.push('steered:L2-vision');
            }
            const adm2 = admitCandidates(current.joints, current.manifest, rec2);
            visionGrounded.push(...(v2.grounded || []));
            saveManifest(runDir, current.manifest);
            commitRevision(`stage 1b: steered second look — ${current.manifest.length} candidate(s), vision +${adm2.added}, agreed ${rec2.agreed.length}`);
            sessionStore.setWork({ joints: current.joints.map((j) => ({ id: j.id, label: j.label, type: j.type, nodeCount: (j.nodes || []).length })) });
            emit('discover:candidates', {
              count: current.manifest.length,
              added: adm2.added,
              agreed: rec2.agreed.length,
              look: 2,
              steered: true,
              notes: notes.length,
              images: extraImages.length,
              category: v2?.expectation?.category || vision?.expectation?.category || null,
              gaps: v2?.gaps || null,
            });
            host.diagnostics.note('steered second look', {
              notes: notes.length, images: extraImages.length,
              added: adm2.added, agreed: rec2.agreed.length,
            });
            steered = { notes: notes.length, images: extraImages.length, added: adm2.added, agreed: rec2.agreed.length };
          } else {
            // The first look's list stands. A second look that could not run is a
            // missed opportunity, not a failed discovery — the human is told, and
            // stage 2 proceeds over the candidates that do exist.
            emit('vision:skip', {
              look: 2,
              code: v2?.code || 'VISION_FAILED',
              error: v2?.error || v2?.reason || 'the steered second look could not run',
            });
          }
        }
        if (reloaded()) return endReloaded();
        if (refineAbort) {
          // A stop landing HERE is not the pre-commit stop above: the candidate
          // list is real, revised and already on screen, so it stays. What is
          // abandoned is the measuring, which is exactly what "stop" means now.
          emit('refine:end', {
            ok: false, code: 'HUMAN_STOPPED', stopped: true, staged: true,
            added: current.manifest.length, agreed: reconciled.agreed.length,
            text: { added: 0, ok: false }, vision: { added: 0, ok: false },
          });
          return {
            ok: false, code: 'HUMAN_STOPPED', stopped: true,
            error: 'a human stopped the refinement after the candidate list landed; no joint was measured',
          };
        }

        // ---- STAGE 2: per-joint refinement at queue boundaries -----------------
        // One joint at a time: battery + the vision lane's grounding over the
        // stage-1 frames, then a save, a revision and a beat that makes exactly
        // that row clickable — then the queue is served before the next joint.
        // The list is re-read every boundary, so a served request (or a slash
        // command it triggered) can drop or postpone what is left of the plan.
        emit('discover:stage', { stage: 2 });
        await yieldToQueue();
        const refined = [];
        while (!refineAbort && !reloaded()) {
          const next = current.manifest.find((r) => r.status === 'candidate');
          if (!next) break;
          refineJoint(current.glb, current.joints, next, { grounded: groundedFor(next) });
          refined.push(next.id);
          saveManifest(runDir, current.manifest);
          commitRevision(`stage 2: ${next.id} refined to ${next.status}`);
          broadcast({
            kind: 'joint:refined',
            id: next.id, status: next.status, confidence: next.confidence,
            remaining: current.manifest.filter((r) => r.status === 'candidate').length,
          });
          await yieldToQueue();
        }
        if (reloaded()) return endReloaded();

        const remaining = current.manifest.filter((r) => r.status === 'candidate').length;
        sessionStore.setWork({ joints: current.joints.map((j) => ({ id: j.id, label: j.label, type: j.type, nodeCount: (j.nodes || []).length })) });
        host.diagnostics.note('staged refine', {
          candidates: current.manifest.length, refined: refined.length, remaining,
          agreed: reconciled.agreed.length, stopped: refineAbort,
          category: vision?.expectation?.category || null,
          frames: vision?.frames ?? 0,
          steered: steered ? { notes: steered.notes, images: steered.images, added: steered.added } : null,
        });
        emit('refine:end', {
          ok: !refineAbort, staged: true, stopped: refineAbort,
          added: refined.length, agreed: reconciled.agreed.length,
          candidates: current.manifest.length, remaining,
          text: { added: 0, ok: true, code: null },
          vision: vision
            ? { added: admitted.added + (steered?.added || 0), ok: true, code: null }
            : { added: 0, ok: false, code: 'SKIPPED' },
          category: vision?.expectation?.category || null,
          gaps: vision?.gaps || null,
          steered: steered || null,
        });
        return {
          ok: !refineAbort, staged: true, stopped: refineAbort,
          refined, remaining, agreed: reconciled.agreed,
          expectation: vision?.expectation ?? null,
          expectationUsable: vision?.expectation ? true : false,
          gaps: vision?.gaps ?? null,
          steered: steered || null,
        };
      } catch (e) {
        // A crash must not freeze the list: whatever is still a candidate gets its
        // battery now, in one batch, so the rows a human sees are clickable and
        // honest about having been scored in a fallback rather than at a boundary.
        try {
          for (const rec of (current.manifest || []).filter((r) => r.status === 'candidate')) {
            refineJoint(current.glb, current.joints, rec, {});
          }
          if (Array.isArray(current.manifest) && current.manifest.length) {
            saveManifest(runDir, current.manifest);
            commitRevision('stage 2 fallback: batch-scored after a refinement failure');
          }
        } catch { /* the failure below is the one that matters */ }
        broadcast({
          kind: 'refine:end',
          ok: false, added: 0, agreed: 0, code: 'REFINE_FAILED', reason: e.message,
          text: { added: 0, ok: false }, vision: { added: 0, ok: false },
        });
        return { ok: false, code: 'REFINE_FAILED', error: e.message };
      } finally {
        autoRunning = false;
      }
    },

    // Stop the in-flight staged refinement at its NEXT boundary. Joints refined so
    // far stay committed — each was saved and revised at its own boundary — so
    // this is "no further joints", not the old "discard everything".
    abortRefine() {
      if (!autoRunning) return { ok: false, code: 'NOT_RUNNING', error: 'no refinement is in flight to stop' };
      refineAbort = true;
      broadcast({ kind: 'refine:abort', queued: 0 });
      return { ok: true, aborting: true, running: autoRunning };
    },

    // Kill an in-flight controller generation. Generation is the ONE job that does
    // not ride the supervisor's turn chain — the bridge spawns its own headless dsh
    // child — so cancelling a model turn cannot reach it; this is the only handle a
    // Stop has on it. The bridge SIGTERMs the child and turns that into an explicit
    // "aborted by user" failure, so POST /api/generate returns promptly instead of
    // idling until the timeout killer fires.
    abortGenerate() {
      const bridge = host.registry.get(CATEGORY.BRIDGE, 'dsh');
      const r = bridge?.api?.abort?.();
      if (!r) return { ok: false, code: 'NO_BRIDGE', error: 'the dsh bridge exposes no abort hook' };
      return r;
    },

    // Plan mutation from the queue: a served user request may reshape what is LEFT
    // of the stage-2 plan. The loop re-reads current.manifest at every boundary, so
    // dropping or postponing a candidate here takes effect at the next one, without
    // ever touching a record mid-measurement. A refined joint is not plan any more
    // — it is belief — so it refuses both and points at the edit/verdict surfaces.
    dropCandidate(id) {
      const rec = (current.manifest || []).find((r) => r.id === id || r.label === id);
      if (!rec) return { ok: false, code: 'NO_SUCH_JOINT', error: `no joint named "${id}"` };
      if (rec.status !== 'candidate') return { ok: false, code: 'ALREADY_REFINED', error: `${rec.id} is already refined — edit or verdict it instead` };
      current.manifest = current.manifest.filter((r) => r !== rec);
      current.joints = current.joints.filter((j) => j.id !== rec.id);
      saveManifest(runDir, current.manifest);
      commitRevision(`stage 2: candidate ${rec.id} dropped from the plan`);
      broadcast({
        kind: 'discover:candidates',
        count: current.manifest.length, dropped: rec.id,
        remaining: current.manifest.filter((r) => r.status === 'candidate').length,
      });
      return { ok: true, dropped: rec.id, remaining: current.manifest.filter((r) => r.status === 'candidate').length };
    },

    postponeCandidate(id) {
      const rec = (current.manifest || []).find((r) => r.id === id || r.label === id);
      if (!rec) return { ok: false, code: 'NO_SUCH_JOINT', error: `no joint named "${id}"` };
      if (rec.status !== 'candidate') return { ok: false, code: 'ALREADY_REFINED', error: `${rec.id} is already refined` };
      const jn = current.joints.find((j) => j.id === rec.id);
      current.manifest = [...current.manifest.filter((r) => r !== rec), rec];
      current.joints = [...current.joints.filter((j) => j !== jn), ...(jn ? [jn] : [])];
      broadcast({ kind: 'discover:candidates', count: current.manifest.length, postponed: rec.id });
      return { ok: true, postponed: rec.id };
    },

    // Phase 3 task 17: the symmetry peers of one joint, i.e. the joints a verdict
    // on it may be OFFERED to. Read-only, so the panel can render the checkboxes
    // before the human has decided anything.
    //
    // `canAmortize` is answered here rather than left for the caller to work out,
    // because the rule is not obvious: an `edit` verdict cannot travel, since it is
    // written in this joint's own node names and a mirror's nodes are different
    // nodes. Letting the panel guess that would mean it offering a button that the
    // write path then refuses.
    jointPeers(id) {
      if (!current.glb || !current.manifest) {
        return { ok: false, code: 'NO_PROJECT', error: 'no project loaded; POST /api/project first' };
      }
      const rec = (current.manifest || []).find((r) => r.id === id);
      if (!rec) return { ok: false, code: 'NO_RECORD', error: `no manifest record with id "${id}"` };
      const geom = { center: modelTarget(current.glb), radius: modelRadius(current.glb) };
      return {
        ok: true,
        id,
        status: rec.status,
        verdict: rec.verdict || null,
        canAmortize: AMORTIZABLE.has(rec.verdict?.decision),
        peers: peersOf(current.manifest, id, geom),
        // The whole symmetric family this joint belongs to, so the panel can say
        // "4 rotors, 1 mirror, 2 same-family" without doing graph work itself.
        group: symmetryGroups(current.manifest, geom).find((grp) => grp.includes(id)) || [id],
      };
    },

    // Phase 3 task 17: the frames behind ONE claim — what a human looks at before
    // pressing accept or reject.
    //
    // A record carries `frame:v3.photo` and, when the loop stamped it, the round
    // directory that frame lives in. The stamp is what makes this exact: a frame
    // id is unique WITHIN a round but not across campaigns, and every campaign
    // starts its own r0. For an unstamped record (a run persisted before task 17,
    // or a phase-1 geometry joint that never had a frame at all) the rounds are
    // scanned NEWEST FIRST and EVERY match is returned with an `ambiguous` flag,
    // because a confident thumbnail of the wrong campaign's frame is the one
    // failure this panel must not have — it is the thing a human judges by.
    //
    // Two match tiers, reported per frame because they are not the same claim:
    //   'frameId' the record names this exact frame — the model was looking at it
    //   'focus'   this frame was drawn with the record's own nodes in focus, i.e.
    //             the mask behind the claim. Only consulted when the record names
    //             no frame at all, so the weaker tier can never displace the
    //             stronger one.
    jointEvidence(id) {
      if (!current.glb || !current.manifest) {
        return { ok: false, code: 'NO_PROJECT', error: 'no project loaded; POST /api/project first' };
      }
      const rec = (current.manifest || []).find((r) => r.id === id);
      if (!rec) return { ok: false, code: 'NO_RECORD', error: `no manifest record with id "${id}"` };

      const wanted = new Set();
      for (const tag of rec.evidence || []) {
        const m = /^frame:(.+)$/.exec(String(tag));
        if (m) wanted.add(m[1]);
      }
      if (rec.frameId) wanted.add(String(rec.frameId));
      if (rec.grounding?.frameId) wanted.add(String(rec.grounding.frameId));
      const names = new Set(rec.nodes || []);
      const stamped = Number.isFinite(rec.frameRound) ? rec.frameRound : null;

      const all = listRounds(runDir);
      const order = [...all].reverse().filter((r) => stamped == null || r.round === stamped);
      const frames = [];
      for (const meta of order) {
        const data = loadRound(runDir, meta.round);
        if (!data) continue;
        for (const f of data.frames) {
          const byId = wanted.has(f.id);
          const byFocus = !byId && wanted.size === 0 && names.size > 0
            && Array.isArray(f.focus) && f.focus.some((n) => names.has(n));
          if (!byId && !byFocus) continue;
          const file = framePath(runDir, meta.round, f.id);
          const grounded = (data.proposals?.grounded || []).find((x) => x.frameId === f.id) || null;
          frames.push({
            round: meta.round,
            id: f.id,
            mode: f.mode,
            matchedBy: byId ? 'frameId' : 'focus',
            url: file ? toViewerUrl(host, runDir, file) : null,
            bytes: f.bytes ?? null,
            width: f.width ?? null,
            height: f.height ?? null,
            spec: f.spec ?? null,
            pose: f.pose ?? null,
            focus: f.focus ?? null,
            // The colour map is ground truth and can be thousands of entries, so
            // it is flagged rather than inlined — the panel fetches it on demand
            // from /api/observations/:round/colors/:id.
            hasColors: !!f.colorMap,
            model: data.reply?.model ?? null,
            // What THIS round concluded about this frame: which names the box
            // resolved to and how the two grounding channels agreed. Shown beside
            // the pixels because a thumbnail alone cannot say why it is evidence.
            grounded: grounded ? {
              names: grounded.names || [],
              source: grounded.grounding?.source ?? null,
              agreement: grounded.grounding?.agreement ?? null,
              score: grounded.grounding?.score ?? null,
              uncertainties: grounded.uncertainties || [],
            } : null,
          });
        }
      }

      const perId = new Map();
      for (const f of frames) perId.set(f.id, (perId.get(f.id) || 0) + 1);
      return {
        ok: true,
        joint: {
          id, label: rec.label, type: rec.type, status: rec.status,
          confidence: rec.confidence ?? null, origin: rec.origin ?? null,
          nodes: rec.nodes || [],
          // Carried because an `edit` verdict may change them: a panel that cannot
          // show the current anchor cannot offer a corrected one, and asking the
          // human to read it off the rig report instead would be a second place
          // for the two to disagree.
          anchor: rec.anchor ?? null,
          axis: rec.axis ?? null,
          reasoning: rec.reasoning ?? null,
          uncertainties: rec.uncertainties || [],
          suggestView: rec.suggestView ?? null,
          grounding: rec.grounding ?? null,
          verdict: rec.verdict || null,
          tests: rec.tests || [],
          history: rec.history || [],
        },
        frames,
        // True only for an UNSTAMPED record whose frame id exists in more than one
        // campaign. A stamped one cannot be ambiguous — it names its directory.
        ambiguous: stamped == null && [...perId.values()].some((n) => n > 1),
        frameRound: stamped,
        // The whole observation history, so the panel can offer "browse every
        // round" without a second request. `dir` is server-internal and dropped.
        rounds: all.map(({ dir, ...r }) => ({ ...r, url: toViewerUrl(host, runDir, dir) })),
        peers: this.jointPeers(id),
      };
    },

    // Phase 3 task 17: the human verdict edge — the only route to `confirmed` or
    // `rejected`, and the counterpart to reopenFromRigidity (reality contradicting
    // a record) rather than a variant of it.
    //
    // opts: { id, decision:'accept'|'reject'|'edit', edits, note, actor,
    //         amortizeTo:[ids] }
    //
    // The verdict and its amortization are two separate writes with two separate
    // outcomes, and the response keeps them separate: a human who accepted a joint
    // and asked to pass it to three mirrors has SUCCEEDED even if one mirror
    // already carried a direct verdict. Collapsing that into one `ok:false` would
    // tell them their accept did not happen, and they would press it again.
    setVerdict({ id, decision, edits = null, note = null, actor = 'human', amortizeTo = null } = {}) {
      if (!current.glb || !current.manifest) {
        return { ok: false, code: 'NO_PROJECT', error: 'no project loaded; POST /api/project first', manifestUntouched: true };
      }
      const r = applyJointVerdict(current.glb, current.joints, current.manifest, {
        id, decision, edits, note, actor,
      });
      // A refusal means applyVerdict validated and declined BEFORE writing, so the
      // on-disk manifest is still byte-identical and nothing is saved. Saying so
      // explicitly is what makes the button safe to press twice.
      if (!r.ok) return { ...r, manifestUntouched: true };

      let amortized = null;
      if (Array.isArray(amortizeTo) && amortizeTo.length) {
        amortized = amortizeVerdict(current.glb, current.joints, current.manifest, {
          fromId: id, toIds: amortizeTo, note, actor,
        });
      }
      // One decision, one snapshot: the verdict and any amortization it triggered
      // are a single point on the time axis, so they persist and revise together
      // rather than as two revisions a reader would have to diff to see one act.
      saveManifest(runDir, current.manifest);
      commitRevision(`verdict ${decision} on ${id}${amortized?.applied?.length ? ` (+${amortized.applied.length} amortized)` : ''}`);

      // The joint list the UI reads is mutated in place by applyManifest, so the
      // resumable work state has to be refreshed too — otherwise a restart would
      // hand back the pre-verdict joints.
      sessionStore.setWork({ joints: current.joints.map((j) => ({ id: j.id, label: j.label, type: j.type, nodeCount: (j.nodes || []).length })) });
      host.diagnostics.note('joint verdict', {
        id, decision, status: r.status, edited: r.applied.length,
        amortizedTo: amortized?.applied?.length ?? 0,
        amortizeRefused: (amortized ? [...amortized.refused, ...amortized.skipped].length : 0),
      });
      return { ok: true, ...r, amortized, peers: this.jointPeers(id) };
    },

    // Phase 3 task 18: drive ONE joint through a fan of poses and ask a model what
    // the moving thing is and whether its motion is sensible. The semantic half of
    // "go and look": the geometry half (which nodes move, by how much) was already
    // measured exactly, so this round annotates the record rather than mutating it.
    //
    // Same precondition discipline as visionRefine, for the same reasons: EVERY
    // unmet guard is collected so one headless probe proves the whole wiring, the
    // round is pinned to one renderer so the fan cannot be drawn by two tabs, and
    // each pose's bytes are read back OFF DISK rather than held in memory.
    //
    // opts: { jointId, angles:[deg], mode:'photo'|'solo', round, viewport,
    //         rendererId, timeoutMs }
    async motionRefine(opts = {}) {
      const refuse = (code, error, extra = {}) => ({
        ok: false, code, error, manifestUntouched: true, ...extra,
      });

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
          hint: 'a motion fan needs a live browser to drive the preview pivot',
        });
      }
      const jointId = opts.jointId != null ? String(opts.jointId) : null;
      if (!jointId) {
        unmet.push({ code: 'NO_RECORD', error: 'no jointId was given; a motion round drives exactly one joint' });
      } else if (current.manifest && !current.manifest.some((r) => r.id === jointId)) {
        unmet.push({ code: 'NO_RECORD', error: `no manifest record with id "${jointId}"` });
      }
      if (unmet.length) {
        const [first] = unmet;
        return refuse(first.code, first.error, { unmet, farm: farmStatus });
      }

      const rendererId = opts.rendererId ? String(opts.rendererId) : (farm.pick()?.id ?? null);
      if (!rendererId) {
        return refuse('NO_RENDERER', 'every renderer with a loaded model is busy with another capture', { farm: farmStatus });
      }

      const round = whole(opts.round, 0, 999) ?? nextObservationRound(runDir);
      const viewport = opts.viewport?.w ? opts.viewport : VIEWPORT;
      const mode = ['photo', 'solo'].includes(opts.mode) ? opts.mode : 'photo';
      const angles = Array.isArray(opts.angles) && opts.angles.length
        ? opts.angles.map(Number).filter(Number.isFinite)
        : MOTION_ANGLES;
      const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : null;
      const drawn = [];

      const res = await runMotionRound(current.glb, current.joints, current.manifest, {
        jointId, mode, angles, viewport, evidenceRound: round,

        // The fan is ONE logical capture that resolves once, but it lands as N+1
        // stored frames. Read each pose's bytes back off disk (exactly as the
        // vision capture does) so the prompt is built from the persisted artefact
        // and the kernel never holds a whole fan of base64 for the length of a turn.
        capture: async (rec, view, fanAngles, fanMode, focusNodes) => {
          const r = await farm.captureMotion({
            round, joint: rec, view, angles: fanAngles, mode: fanMode, focusNodes, viewport, rendererId, timeoutMs,
          });
          const raw = r?.frames || [];
          if (raw.length < 2) return null;
          const withBytes = [];
          for (const f of raw) {
            const file = framePath(runDir, round, f.id);
            if (!file) continue;
            drawn.push({ id: f.id, mode: fanMode, round, index: f.index, angle: f.angle, url: toViewerUrl(host, runDir, file) });
            withBytes.push({ index: f.index, angle: f.angle, tag: f.tag, id: f.id, mediaType: 'image/png', dataBase64: readFileSync(file).toString('base64') });
          }
          let composite = null;
          if (r.composite?.id) {
            const file = framePath(runDir, round, r.composite.id);
            if (file) {
              drawn.push({ id: r.composite.id, mode: fanMode, round, kind: 'sweep', url: toViewerUrl(host, runDir, file) });
              composite = { id: r.composite.id, kind: r.composite.kind || 'sweep', mediaType: 'image/png', dataBase64: readFileSync(file).toString('base64') };
            }
          }
          // Two poses is the floor for an arc; a fan that lost frames on the way
          // back is refused rather than assessed as if it were complete.
          if (withBytes.length < 2) return null;
          return { frames: withBytes, composite, angles: r.angles || withBytes.map((f) => f.angle) };
        },

        propose: (text, images) => provider.send(text, images),

        persist: { motion: (m) => saveMotion(runDir, round, m) },
      });

      // Only a round that annotated the record may write the manifest; a refused
      // round leaves the on-disk record byte-identical, so a failed press is safe.
      if (res.ok && res.manifestUntouched === false) {
        saveManifest(runDir, current.manifest);
        commitRevision(`motion round on ${jointId}`);
      }
      host.diagnostics.note('motion refine', {
        jointId, round, ok: res.ok, code: res.code || null,
        sensible: res.motionSensible ?? null, observedType: res.observedType ?? null,
        agrees: res.agreesWithType ?? null, frames: res.frames ?? 0, warnings: res.warnings?.length || 0,
      });

      const frameUrls = drawn;
      if (!res.ok) {
        return {
          ...res, error: res.reason || res.error || 'the motion round failed',
          round, rendererId, provider: provider.kind, frameUrls, farm: farm.status(),
        };
      }
      return {
        ...res, round, rendererId, provider: provider.kind,
        model: res.model || provider.model(), frameUrls, farm: farm.status(),
      };
    },

    // Phase 3 task 19: the TIME axis, read back. Every belief-changing write froze
    // a revision; these expose the chain and the structural diff between two of
    // them. Read-only — nothing here mutates the manifest, so the observation
    // browser can poll them freely.
    revisions() {
      return { ok: true, revisions: listRevisions(runDir), latest: latestRevision(runDir) };
    },

    revision(n = null) {
      const rev = loadRevision(runDir, n);
      if (!rev) return { ok: false, code: 'NO_REVISION', error: `no revision ${n ?? '(latest)'}` };
      return { ok: true, ...rev };
    },

    // Default compare is against the snapshot's OWN parent — "what did THIS
    // revision change" — which is the question the time axis exists to answer.
    // `against` names a different base to diff across a branch or a gap; a base
    // with no snapshot (or a root revision) diffs against the empty graph, so
    // every record reads as added rather than the call failing.
    revisionDiff(n = null, against = null) {
      const after = loadRevision(runDir, n);
      if (!after) return { ok: false, code: 'NO_REVISION', error: `no revision ${n ?? '(latest)'}` };
      const baseId = Number.isFinite(against) ? against : after.parent;
      const before = baseId == null ? [] : (loadRevision(runDir, baseId)?.joints || []);
      const diff = diffManifests(before, after.joints || []);
      return { ok: true, revision: after.revision, against: baseId ?? null, ...diff };
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
          commitRevision(`rigidity reopen: ${reopened.join(', ')}`);
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

// Discovery loop — the hypothesis-testing + human-verdict + graph-based-loop
// architecture. Per the strangler-fig decision, the existing geometry
// heuristics are the L1 producer; this loop wraps them in the manifest state
// machine and runs the deterministic test battery.
//
// Phase 1 (runDiscoveryLoop): L1 hypotheses → manifest → rest-pose tests →
// deriveStatus → persist. Phase 2 (runL2Round): ONE bounded AI-proposal round
// over the needs-verdict frontier, on the EXISTING manifest — reopen state
// and history survive. Phase 3 (runVisionRound): ONE bounded round whose producer
// LOOKS at rendered frames instead of reading a node table, so it can find parts
// the geometry heuristics never suspected.
//
// Both producers merge through mergeProposals(). The split/confirm/confidence
// rules live there and nowhere else: they are the trust boundary between a model
// and the manifest, so a producer-specific copy would be a producer-specific hole.
import {
  AUTO_ACCEPT_CONFIDENCE, applyManifest, applyVerdict, buildManifest, deriveStatus,
  reopen, retireStaleEdit, saveManifest,
} from './manifest.mjs';
import { attachmentSanity, discCoherence, isolation } from './tests.mjs';
import { buildProposalPrompt } from './context.mjs';
import { aiPropose } from './ai-propose.mjs';
import { MAX_VISION_FRAMES, buildVisionPrompt } from './vision-prompt.mjs';
import { visionPropose } from './vision-propose.mjs';
import { buildMotionPrompt, MAX_MOTION_FRAMES } from './motion-prompt.mjs';
import { motionAssess } from './motion-propose.mjs';
import { VIEWPORT, modelRadius, modelTarget, namedIndex, nodeBox, planCloseUps, regionsFromSuggestViews, renderTargets } from './views.mjs';
import { AMORTIZABLE, peersOf } from './symmetry.mjs';

// The names the rest-pose battery produces. Kept as a set so a re-run can REPLACE
// its own previous results instead of appending to them: a record re-tested twice
// would otherwise carry two disc-coherence entries, one passing and one failing,
// and a reader could not tell which described the current membership. Evidence
// from anywhere else — a rigidity-gate failure attached by reopen() — is
// deliberately not in this set and survives every re-run.
const BATTERY_TESTS = new Set(['disc-coherence', 'anchor-sphere', 'isolation', 'attachment-sanity']);

// Exported because task 17's edit verdict has to re-score a record against its
// corrected membership, and the battery is the only thing in this codebase
// allowed to decide a status.
export function runBattery(g, joints, recs) {
  const iso = isolation(joints); // cross-joint test — same verdict for all
  for (const rec of recs) {
    // A manifest record is joint-shaped enough for the battery (id/type/nodes/
    // anchor/axis), so falling back to it means a record with no entry in the
    // served joint list is still testable rather than silently skipped.
    const joint = joints.find((j) => j.id === rec.id) || rec;
    rec.tests.push(discCoherence(g, joint));
    rec.tests.push({ ...iso });
    rec.tests.push(attachmentSanity(g, joint));
  }
}

export function runDiscoveryLoop(g, joints, { runDir = null } = {}) {
  const manifest = buildManifest(joints);
  const frontier = [...manifest]; // BFS frontier — phase 1: depth 0 only
  const producers = { L2: [], L3: [] }; // filled by runL2Round / phase 3

  runBattery(g, joints, frontier);
  for (const rec of frontier) rec.status = deriveStatus(rec);

  applyManifest(joints, manifest);
  const file = saveManifest(runDir, manifest);
  return { manifest, frontier, producers, file };
}

// Merge validated candidates into the manifest + joints, then let PHYSICS dispose
// the confidence. Shared by the text and vision producers.
//
// Three rules, all load-bearing:
//   - a confirm is EVIDENCE, capped just below the auto-accept threshold, so no
//     number of model corroborations can flip a record by themselves
//   - a split SUBTRACTS its nodes from the target in the manifest AND the joint,
//     or the isolation test would see the same node in two joints forever
//   - confidence after the battery is set by the test results alone (0.80 clean,
//     0.75 with warnings, 0.70 with a hard failure). The model's own number, if
//     it reported one, is nowhere in this function.
function mergeProposals(g, joints, manifest, { records, confirms, confirmTag = 'l2-confirm' }) {
  for (const c of confirms || []) {
    const t = manifest.find((r) => r.id === c.targetId);
    if (!t) continue;
    t.evidence.push(confirmTag);
    t.confidence = Math.min(AUTO_ACCEPT_CONFIDENCE - 0.01, t.confidence + 0.05);
    t.status = deriveStatus(t);
  }

  // Splits subtract the claimed subset from the target (manifest AND joint),
  // keeping the isolation test meaningful for the new candidate.
  const affected = new Set();
  for (const rec of records || []) {
    if (rec.splitFrom) {
      const t = manifest.find((r) => r.id === rec.splitFrom);
      const tj = joints.find((j) => j.id === rec.splitFrom);
      if (t) {
        t.nodes = t.nodes.filter((n) => !rec.nodes.includes(n));
        t.history.push({ at: new Date().toISOString(), event: 'split-off', note: `${rec.nodes.length} nodes → ${rec.id}` });
        affected.add(t.id);
      }
      if (tj) tj.nodes = tj.nodes.filter((n) => !rec.nodes.includes(n));
    }
    joints.push({ ...rec }); // joint-shaped view for the battery + UI
    manifest.push(rec);
  }

  const retest = [...(records || []), ...manifest.filter((r) => affected.has(r.id))];
  if (retest.length) {
    runBattery(g, joints, retest);
    for (const rec of records || []) {
      const fails = rec.tests.some((t) => t.level !== 'warn' && !t.pass);
      const warns = rec.tests.some((t) => t.level === 'warn' && !t.pass);
      rec.confidence = fails ? 0.7 : warns ? 0.75 : 0.8; // physics disposes
    }
    for (const rec of retest) rec.status = deriveStatus(rec);
  }

  applyManifest(joints, manifest);
  return { added: (records || []).length, proposals: (records || []).map((r) => r.id), retested: retest.length };
}

// Phase 2: one L2 round. `l2` is an injected async (prompt) => reply callable
// (kernel wires the DSH supervisor; tests inject canned replies). Proposals
// merge as candidates; only deterministic corroboration lifts a proposal to
// auto-accept (0.80, zero warnings) — never the model's own say-so.
export async function runL2Round(g, joints, manifest, l2) {
  const warnings = [];
  const uncertain = manifest.filter((r) => r.status === 'needs-verdict');
  if (!uncertain.length) return { added: 0, reason: 'frontier empty', warnings };

  let parsed;
  try {
    const focusIds = new Set(uncertain.flatMap((r) => r.nodes));
    const prompt = buildProposalPrompt({ g, manifest, focusIds });
    parsed = aiPropose({ reply: await l2(prompt), g, manifest });
  } catch (e) {
    return { added: 0, warnings: [`L2 round failed (manifest untouched): ${e.message}`] };
  }
  warnings.push(...parsed.warnings);

  const merged = mergeProposals(g, joints, manifest, {
    records: parsed.records, confirms: parsed.confirms,
  });
  return { added: merged.added, proposals: merged.proposals, warnings };
}

// Reopen edge, controller stage: map each failing declared motion set to the
// ONE manifest record it best overlaps (unambiguous max only — ambiguity is
// reported, never guessed) and regress that record with the failing evidence.
export function reopenFromRigidity(manifest, rigidity) {
  const reopened = [];
  const skipped = [];
  for (const res of (rigidity?.results || []).filter((x) => !x.pass)) {
    const names = new Set(res.names || []);
    if (!names.size) { skipped.push(`${res.set}: no member names`); continue; }
    let best = null; let second = 0;
    for (const rec of manifest) {
      const hit = (rec.nodes || []).filter((n) => names.has(n)).length;
      if (hit > (best?.hit || 0)) { second = best?.hit || 0; best = { rec, hit }; }
      else if (hit > second) second = hit;
    }
    if (!best || best.hit === 0 || best.hit === second) { skipped.push(`${res.set}: ambiguous/unmapped`); continue; }
    if (best.rec.tests.some((t) => t.name === 'rigidity-gate' && !t.pass)) { skipped.push(`${res.set}: already reopened`); continue; }
    reopen(best.rec, {
      name: 'rigidity-gate',
      detail: `set "${res.set}": ${(res.offenders || []).map((o) => o.name).slice(0, 4).join(', ') || 'relative-pose invariance failed'}`,
    }, `controller set "${res.set}" cracked under motion`);
    reopened.push(best.rec.id);
  }
  return { reopened, skipped };
}

// ---- phase 3: one vision round ------------------------------------------------

// Which frames to actually shoot, from a plan that usually offers more.
//
// A plan view carries `sees` (the NAMES visible from that pose) and `covers` (how
// many of them were new). Only `sees` is a list, so it is what a focused frame is
// aimed with.
//
// Four allocations, in order of what a frame is worth:
//
//  1. ORIENTATION — whole-model photos first. A cropped region is uninterpretable
//     without one; the model has to know where in the machine it is looking.
//  2. MASK PAIRS on the TIGHTEST views. A colorId mask is the only channel that
//     grounds EXACTLY, so it earns half the budget — but only where it is usable:
//     a cell view frames ~12-20 parts, so its legend is readable and every colour
//     resolves. A whole-model ring would paint all ~345 named parts and the legend
//     would be noise. Tightest-first, because readability is what makes the exact
//     channel actually exact in practice.
//     THE PAIRING IS THE POINT: the mask and the photo share ONE pose, because
//     reconcile() compares the box a model draws against the colours it reads, and
//     that comparison means nothing across two different cameras.
//  3. GHOSTS — the only route to interior-only parts, which no opaque pose can
//     ever show. A ghost with no focus list draws everything opaque, which is an
//     ordinary photo and not a ghost at all, so `sees` is mandatory here and a
//     ghost that sees nothing is skipped rather than shot.
//  4. FILL — whatever budget remains buys plain photos in the planner's own
//     marginal-gain order, skipping poses already shot.
export const SHOT_BUDGET = { maskPairs: 3, ghostFrames: 2, orientation: 2 };

// A pose fitted to a PART-SIZED region rather than to the whole model: the kd cell
// pass of round 1, and the close-ups round 2 aims at a suggestView. Only these can
// carry a mask, because only these frame few enough parts for a legend to be
// readable — and readability is what makes the exact channel actually exact.
const TIGHT_KINDS = new Set(['cell', 'close-up']);

export function selectShots(views, {
  maxFrames = MAX_VISION_FRAMES, ...budget
} = {}) {
  const { maskPairs, ghostFrames, orientation } = { ...SHOT_BUDGET, ...budget };
  const all = (views || []).filter((v) => v && Array.isArray(v.pose?.eye));
  const ghosts = all.filter((v) => v.mode === 'ghost');
  const photos = all.filter((v) => v.mode !== 'ghost');
  const cells = photos.filter((v) => TIGHT_KINDS.has(v.spec?.kind));
  const rings = photos.filter((v) => !TIGHT_KINDS.has(v.spec?.kind));
  const cap = Math.max(1, maxFrames | 0);
  const sees = (v) => (Array.isArray(v.sees) && v.sees.length ? v.sees.map(String) : null);

  const shots = [];
  const photographed = new Set();
  const push = (view, mode, focusNodes) => {
    if (!view || shots.length >= cap) return false;
    if (mode === 'photo') {
      if (photographed.has(view.id)) return false;
      photographed.add(view.id);
    }
    shots.push({ viewId: view.id, view, mode, focusNodes });
    return true;
  };

  for (const v of rings.slice(0, Math.max(0, orientation | 0))) push(v, 'photo', null);

  // Tightest first; ties keep the planner's marginal-gain order.
  const maskable = (cells.length ? cells : photos)
    .map((v, i) => ({ v, i, n: sees(v)?.length ?? Infinity }))
    .sort((a, b) => (a.n - b.n) || (a.i - b.i))
    .slice(0, Math.max(0, maskPairs | 0));
  for (const { v } of maskable) {
    push(v, 'photo', null);
    // Same rule as ghosts, for the same reason: an unfocused colorId paints EVERY
    // named part in the model, so its legend is a wall of ~345 colours and the
    // exact channel resolves nothing. A view with no predicted visibility gets a
    // photo only.
    const focus = sees(v);
    if (focus) push(v, 'colorId', focus);
  }

  for (const v of ghosts.slice(0, Math.max(0, ghostFrames | 0))) {
    const focus = sees(v);
    if (focus) push(v, 'ghost', focus);
  }

  for (const v of photos) push(v, 'photo', null);
  return shots.slice(0, cap);
}

// Phase 3: ONE vision round. Exactly one — the bounded-auto decision. Round 2 is
// a separate call driven by the suggestViews this one returns.
//
// All three effects are injected, which is what makes this testable with no
// browser and no model:
//   plan     () => planObject            pure math, no GPU
//   capture  (view, mode, focusNodes) => frame|null   kernel wires the render farm
//   propose  (text, images) => {reply, model, ms}     kernel wires the provider
// A captured frame must carry `dataBase64`, `id`, `pose` and — for a mask — a
// RESOLVED `colorMap` object (loadColorMap, not the stored filename).
//
// `frames` bypasses capture entirely: a round can be replayed from the frames
// already on disk, which is how a persisted run stays resumable.
//
// Resume semantics match runL2Round: the manifest is NOT rebuilt, so reopen state
// and history survive. Every failure path returns before mergeProposals, so the
// manifest is untouched and the reason is in `warnings`.
export async function runVisionRound(g, joints, manifest, effects = {}) {
  const warnings = [];
  const {
    plan: planEffect = null, capture = null, propose = null,
    frames: preset = null, persist = null,
    maxFrames = MAX_VISION_FRAMES, viewport = VIEWPORT,
    maskPairs = SHOT_BUDGET.maskPairs, ghostFrames = SHOT_BUDGET.ghostFrames,
    orientation = SHOT_BUDGET.orientation,
    // The ABSOLUTE round directory this round's frames were written to. Stamped
    // onto the records it adds, because a frame id is unique within a round but
    // not across campaigns: without it the observation browser cannot tell which
    // r<N>/ holds the pixels behind a claim. Null (the default) leaves the
    // records unstamped and the browser falls back to a scan.
    evidenceRound = null,
  } = effects || {};

  // One shape for every failure, always carrying the reason and always stating
  // that nothing was mutated — the caller must never have to guess.
  const bail = (reason, code = null) => ({
    ok: false, added: 0, reason, code, warnings, proposals: [], manifestUntouched: true,
  });

  if (!g?.nodes?.length) return bail('no parse table to ground against', 'NO_PROJECT');
  if (!Array.isArray(manifest)) return bail('no manifest to merge into', 'NO_MANIFEST');

  // 1. PLAN ---------------------------------------------------------------
  let plan = null;
  try {
    plan = typeof planEffect === 'function' ? await planEffect({ manifest, joints }) : planEffect;
  } catch (e) {
    warnings.push(`the planner failed: ${e.message}`);
    return bail('planning failed', 'PLAN_FAILED');
  }
  if (!plan?.views?.length) {
    warnings.push('the planner produced no views');
    return bail('no views planned', 'NO_VIEWS');
  }
  persist?.plan?.(plan);

  // 2. CAPTURE ------------------------------------------------------------
  const shots = selectShots(plan.views, { maxFrames, maskPairs, ghostFrames, orientation });
  let captured = [];
  if (Array.isArray(preset) && preset.length) {
    captured = preset.filter((f) => f?.dataBase64);
    warnings.push(`replayed ${captured.length} frame(s) supplied by the caller; nothing was captured`);
  } else {
    if (typeof capture !== 'function') {
      // Every bail must leave its reason in `warnings` — that is the contract a
      // caller reads when it decides whether to retry or to surface the failure.
      warnings.push('no capture effect was supplied, so nothing could be rendered; the kernel must wire the render farm');
      return bail('no capture effect is wired — a browser renderer must be connected', 'NO_RENDERER');
    }
    for (const shot of shots) {
      let f = null;
      try {
        f = await capture(shot.view, shot.mode, shot.focusNodes);
      } catch (e) {
        // These two would fail identically for every remaining shot, so bail now
        // rather than burning one timeout per frame.
        if (e.code === 'NO_RENDERER' || e.code === 'NO_MODEL') {
          warnings.push(`capture aborted at ${shot.viewId}/${shot.mode}: ${e.message}`);
          return bail(e.code === 'NO_RENDERER' ? 'no renderer is connected' : 'the renderer has no model loaded', e.code);
        }
        warnings.push(`capture ${shot.viewId}/${shot.mode} failed: ${e.message}`);
        continue;
      }
      // One dead frame does not kill the round — the rest are still evidence.
      if (!f?.dataBase64) { warnings.push(`capture ${shot.viewId}/${shot.mode} returned no image bytes`); continue; }
      captured.push(f);
      persist?.frame?.(f);
    }
  }
  if (!captured.length) return bail('no frames were captured', 'NO_FRAMES');

  // 3. PROMPT + TURN ------------------------------------------------------
  const t0 = Date.now();
  const prompt = buildVisionPrompt({ manifest, frames: captured, plan, maxFrames });
  warnings.push(...prompt.warnings);

  if (typeof propose !== 'function') {
    warnings.push('no propose effect was supplied, so no model was asked; the kernel must wire a live vision provider');
    return bail('no vision provider is wired', 'NO_VISION_AGENT');
  }
  let turn = null;
  try {
    turn = await propose(prompt.text, prompt.images);
  } catch (e) {
    // Persist the failed exchange too: "we asked and got nothing" is evidence,
    // and without it a round that died here leaves no trace of the prompt sent.
    warnings.push(`the vision turn failed: ${e.message}`);
    persist?.reply?.({
      prompt: { text: prompt.text, frames: prompt.frames, images: prompt.images.length },
      reply: null, model: null, ms: Date.now() - t0, warnings,
    });
    return bail(e.code === 'NO_VISION_AGENT' ? 'no live multimodal model is available'
      : e.code === 'VISION_DEGRADED' ? 'the model degraded mid-turn, so its reply is a stub'
        : 'the vision model call failed', e.code || 'VISION_FAILED');
  }

  const replyRecord = {
    prompt: { text: prompt.text, frames: prompt.frames, images: prompt.images.length },
    reply: turn?.reply ?? null,
    model: turn?.model ?? null,
    ms: turn?.ms ?? (Date.now() - t0),
    warnings,
  };
  persist?.reply?.(replyRecord);

  // 4. GROUND + VALIDATE --------------------------------------------------
  const parsed = visionPropose({
    reply: turn?.reply || '', g, manifest, frames: captured, plan, viewport,
  });
  warnings.push(...parsed.warnings);

  const survivors = new Set(parsed.admitted.map((a) => a.index));
  const rejected = parsed.grounded
    .filter((e) => !survivors.has(e.index))
    .map((e) => ({ index: e.index, frameId: e.frameId, names: e.names, grounding: e.grounding, uncertainties: e.uncertainties }));

  // 5. MERGE + BATTERY ----------------------------------------------------
  const merged = mergeProposals(g, joints, manifest, {
    records: parsed.records, confirms: parsed.confirms, confirmTag: 'l2-vision-confirm',
  });

  // Stamp the evidence round onto exactly the records this round added. Written
  // here rather than by the producer for the reason propose-core protects the
  // field: only the caller that owns the round directories knows which one it
  // wrote into, and a producer that guessed would point a human at a different
  // campaign's frame that happens to share an id.
  if (Number.isFinite(evidenceRound)) {
    for (const rid of merged.proposals) {
      const rec = manifest.find((r) => r.id === rid);
      if (rec) rec.frameRound = evidenceRound;
    }
  }

  persist?.proposals?.({
    records: parsed.records, confirms: parsed.confirms,
    warnings: parsed.warnings, rejected,
    grounded: parsed.grounded, suggestViews: parsed.suggestViews,
  });

  return {
    ok: true,
    added: merged.added,
    proposals: merged.proposals,
    confirms: parsed.confirms.length,
    retested: merged.retested,
    // An empty answer is a valid answer — the prompt says so explicitly, and
    // pretending otherwise would push the model toward invention.
    reason: merged.added || parsed.confirms.length ? null : 'the model proposed nothing',
    views: plan.views.length,
    shots: shots.length,
    frames: captured.length,
    coverage: plan.coverage ?? null,
    interiorOnly: plan.interiorOnly ?? null,
    grounded: parsed.grounded,
    admitted: parsed.admitted,
    rejected,
    // What round 2 should aim at. Persisted as well, so the active loop can be
    // resumed from disk with no model and no browser attached.
    suggestViews: parsed.suggestViews,
    model: turn?.model ?? null,
    ms: Date.now() - t0,
    manifestUntouched: false,
    warnings,
  };
}

// ---- phase 3, task 16: the bounded ACTIVE loop -------------------------------
//
// Round 1 proposes and, in the same breath, says where it was unsure. Round 2
// goes and LOOKS there. That is the edge `hypothesis --suggestView-->
// observation --> hypothesis` becoming executable instead of being a string in a
// JSON reply that nothing ever reads.
//
// Bounded, and the bounds are HARD:
//   MAX_VISION_ROUNDS = 2   a caller asking for more gets 2 and a warning
//   MAX_EXTRA_VIEWS   = 6   frames round 2 may buy ON TOP of round 1
// `rounds`/`extraViews` may only ever LOWER these. The point of the bounded-auto
// decision is that the machine cannot talk itself into a longer look than a
// human authorised, so a knob that could raise the ceiling would undo it.
//
// It also stops early, whenever another look would repeat a question:
//   - the round asked for nothing (no suggestView)
//   - the round declared no NEW uncertainty — the same doubts verbatim mean the
//     extra frame taught it nothing, and a third would teach it nothing either
//   - nothing it asked for resolved to a place to aim (reported, never guessed)
//   - the extra-view budget is gone
//
// Effects are exactly runVisionRound's, plus `rounds`, `extraViews`,
// `maxRegions`, `perRegion`, `knownDoubts` and `evidenceRound`. `persist`,
// `frames` and `evidenceRound` may be given per round (as `(round) => …`) so a
// whole campaign, not just its last step, is replayable from disk with no browser
// and no model attached.
export const MAX_VISION_ROUNDS = 2;
export const MAX_EXTRA_VIEWS = 6;

// What a round said it was unsure about, as comparable strings. Two rounds
// producing the same set are two rounds that learned nothing.
const declaredDoubts = (round) => [
  ...(round.grounded || []).flatMap((e) => (e.uncertainties || []).map((u) => `u:${u}`)),
  ...(round.suggestViews || []).map((s) => `s:${s.target ?? ''}|${s.reason ?? ''}`),
];

export async function runVisionCampaign(g, joints, manifest, effects = {}) {
  const e = effects || {};
  const warnings = [];

  const askedRounds = Number.isFinite(e.rounds) ? Math.max(1, Math.floor(e.rounds)) : MAX_VISION_ROUNDS;
  const maxRounds = Math.min(MAX_VISION_ROUNDS, askedRounds);
  if (askedRounds > MAX_VISION_ROUNDS) warnings.push(`rounds=${askedRounds} was capped to MAX_VISION_ROUNDS=${MAX_VISION_ROUNDS}`);
  const askedExtra = Number.isFinite(e.extraViews) ? Math.max(0, Math.floor(e.extraViews)) : MAX_EXTRA_VIEWS;
  const extraBudget = Math.min(MAX_EXTRA_VIEWS, askedExtra);
  if (askedExtra > MAX_EXTRA_VIEWS) warnings.push(`extraViews=${askedExtra} was capped to MAX_EXTRA_VIEWS=${MAX_EXTRA_VIEWS}`);

  const maxRegions = Number.isFinite(e.maxRegions) ? Math.max(1, Math.floor(e.maxRegions)) : 3;
  const perRegion = Number.isFinite(e.perRegion) ? Math.max(1, Math.floor(e.perRegion)) : 2;
  const allowGhost = e.allowGhost !== false;
  const viewport = e.viewport || VIEWPORT;

  // An object-shaped persist/preset belongs to round 1 only. Writing a second
  // round's evidence into the first round's directory would overwrite the frames
  // a human may already be looking at, so it is dropped rather than reused.
  const persistFor = (r) => (typeof e.persist === 'function' ? e.persist(r) : (r === 0 ? e.persist || null : null));
  const presetFor = (r) => (typeof e.frames === 'function' ? e.frames(r) : (r === 0 ? e.frames : null));
  // A number is read as the ABSOLUTE first round and offset by the campaign
  // index; a function is asked. Undefined leaves records unstamped.
  const evidenceRoundFor = (r) => (typeof e.evidenceRound === 'function'
    ? e.evidenceRound(r)
    : (Number.isFinite(e.evidenceRound) ? e.evidenceRound + r : null));

  const rounds = [];
  const seen = new Set();
  // Seed "already known" from the manifest BEFORE round 1 looks. A record carries
  // the uncertainties and the suggestView that produced it, so a campaign run a
  // second time does not re-chase a doubt that is already on the books — without
  // this, every button press would spend the extra-view budget photographing the
  // same hidden hub and reporting the same inconclusive answer.
  //
  // This is also what makes the no-NEW-uncertainty stop reachable at all: with a
  // two-round ceiling and an empty seed, round 1's doubts are trivially fresh.
  for (const rec of manifest || []) {
    for (const u of rec?.uncertainties || []) seen.add(`u:${u}`);
    const sv = rec?.suggestView;
    if (sv) seen.add(`s:${sv.target ?? ''}|${sv.reason ?? ''}`);
  }
  for (const d of e.knownDoubts || []) seen.add(String(d));
  let extraSpent = 0;
  let prev = null;
  let prevPlan = null;
  let prevFrames = [];
  let stop = null;

  for (let r = 0; r < maxRounds; r += 1) {
    let resolution = null;
    let basePlan = e.plan;
    const room = extraBudget - extraSpent;

    if (r > 0) {
      if (room <= 0) { stop = `the ${extraBudget}-extra-view budget was already spent`; break; }
      // THE ACTIVE EDGE. Round 1's doubts become a place to aim, resolved
      // against the manifest round 1 just mutated — so a part it admitted in the
      // meantime is not re-examined as if nothing had happened.
      resolution = regionsFromSuggestViews(g, prev.suggestViews, {
        grounded: prev.grounded, plan: prevPlan, frames: prevFrames, manifest,
        maxRegions, viewport,
      });
      for (const u of resolution.unresolved) warnings.push(`round ${r + 1}: could not aim at "${u.target}" — ${u.why}`);
      for (const s of resolution.skipped) warnings.push(`round ${r + 1}: ${s.id} not aimed at — ${s.why}`);
      if (!resolution.regions.length) { stop = 'nothing round 1 asked for resolved to a place to look'; break; }
      basePlan = () => planCloseUps(g, resolution.regions, { perRegion, maxViews: room, allowGhost, viewport });
    }

    // Keep the plan object this round actually used. runVisionRound reports only
    // a view count, and round 2 needs the poses to map a frame id back to an aim
    // point — re-planning to recover them would not be the same plan.
    let planObj = null;
    const planEffect = async (ctx) => {
      planObj = typeof basePlan === 'function' ? await basePlan(ctx) : basePlan;
      return planObj;
    };

    // Same reason for the frames, but only their REFERENCES: a campaign result
    // is an HTTP response body, and the bytes are already on disk.
    //
    // The capture effect gets the round index as a FOURTH argument. runVisionRound
    // itself only ever passes three, and the kernel needs the fourth to write each
    // round's frames into its own directory — inferring it from call order would
    // be an invisible coupling between two modules.
    const capturedRefs = [];
    const preset = presetFor(r);
    const replay = Array.isArray(preset) && preset.length ? preset : null;
    const capture = typeof e.capture === 'function'
      ? async (view, shotMode, focusNodes) => {
        const f = await e.capture(view, shotMode, focusNodes, r);
        if (f?.dataBase64) capturedRefs.push({ id: f.id, viewId: f.viewId ?? view?.id ?? null, mode: f.mode || shotMode });
        return f;
      }
      : e.capture;

    const res = await runVisionRound(g, joints, manifest, {
      plan: planEffect,
      capture,
      propose: e.propose || null,
      frames: replay,
      persist: persistFor(r),
      // Resolved per round for the same reason `persist` is a factory: the caller
      // owns the directory numbering, this loop only owns the campaign index.
      evidenceRound: evidenceRoundFor(r),
      // Round 2 spends the EXTRA budget, so its frame ceiling is what is left of
      // it. A close-up round needs no orientation frames either: every view in a
      // close-up plan is fitted to a part, and there is no whole-model ring to
      // orient against.
      maxFrames: r === 0 ? e.maxFrames : Math.min(e.maxFrames ?? MAX_VISION_FRAMES, room),
      viewport,
      maskPairs: e.maskPairs, ghostFrames: e.ghostFrames,
      orientation: r === 0 ? e.orientation : 0,
    });

    prevPlan = planObj;
    prevFrames = replay
      ? replay.map((f) => ({ id: f.id, viewId: f.viewId ?? null, mode: f.mode }))
      : capturedRefs;

    rounds.push({
      round: r,
      ...res,
      // Which regions round 2 aimed at and HOW each was resolved, without the
      // member list — that is in plan.json, and this is a response body.
      regions: resolution ? resolution.regions.map(({ names, ...x }) => ({ ...x, names: names.length })) : null,
    });

    if (!res.ok) { stop = res.reason || 'the round failed'; break; }
    if (r > 0) extraSpent += res.frames || 0;
    if (r + 1 >= maxRounds) break;

    const doubts = declaredDoubts(res);
    const fresh = doubts.filter((d) => !seen.has(d));
    for (const d of doubts) seen.add(d);
    if (!(res.suggestViews || []).length) { stop = 'the round asked for nothing further'; break; }
    if (!fresh.length) { stop = 'the round declared no NEW uncertainty, so another look would repeat the question'; break; }
    prev = res;
  }

  const okRounds = rounds.filter((x) => x.ok);
  const last = okRounds[okRounds.length - 1] || rounds[rounds.length - 1] || null;
  const failed = rounds.find((x) => !x.ok) || null;
  const added = okRounds.reduce((n, x) => n + (x.added || 0), 0);
  const confirms = okRounds.reduce((n, x) => n + (x.confirms || 0), 0);
  const sum = (k) => rounds.reduce((n, x) => n + (x[k] || 0), 0);
  // `index` is per round, so a flat concat would be ambiguous. Tagging keeps the
  // audit trail readable without making the caller zip two arrays.
  const tagged = (k) => rounds.flatMap((x) => (x[k] || []).map((v) => ({ ...v, round: x.round })));

  return {
    ok: okRounds.length > 0,
    added,
    confirms,
    proposals: okRounds.flatMap((x) => x.proposals || []),
    retested: sum('retested'),
    roundCount: rounds.length,
    rounds,
    stop,
    extraViews: extraSpent,
    maxRounds,
    extraBudget,
    views: sum('views'),
    shots: sum('shots'),
    frames: sum('frames'),
    coverage: last?.coverage ?? null,
    interiorOnly: last?.interiorOnly ?? null,
    grounded: tagged('grounded'),
    admitted: tagged('admitted'),
    rejected: tagged('rejected'),
    // What a hypothetical round 3 would aim at. Reported, never acted on — the
    // ceiling is two rounds and that is not a knob the model can turn.
    suggestViews: last?.suggestViews || [],
    model: last?.model ?? null,
    ms: sum('ms'),
    reason: added || confirms ? null : (stop || last?.reason || 'the model proposed nothing'),
    code: failed?.code ?? null,
    manifestUntouched: !rounds.some((x) => x.manifestUntouched === false),
    warnings: [...warnings, ...rounds.flatMap((x) => (x.warnings || []).map((w) => `round ${x.round + 1}: ${w}`))],
  };
}

// ---- phase 3, task 17: the human verdict edge --------------------------------
//
// The counterpart to reopen(). reopen() is reality contradicting a record; this
// is a person disposing of one, and it is the ONLY route to `confirmed` or
// `rejected` — no producer can write a verdict (propose-core pins the field), and
// no route writes one directly. Everything comes through here so the served joint
// object, the manifest record and the persisted file cannot disagree about what
// the human said.
//
// opts: { id, decision:'accept'|'reject'|'edit', edits, note, actor, amortizedFrom }
// `amortizedFrom` is set by the caller only when this verdict was inherited
// laterally from a symmetry peer (see symmetry.mjs); it is provenance, not a knob.
export function applyJointVerdict(g, joints, manifest, {
  id, decision, edits = null, note = null, actor = 'human', amortizedFrom = null,
} = {}) {
  const rec = (manifest || []).find((r) => r.id === id);
  if (!rec) return { ok: false, code: 'NO_RECORD', error: `no manifest record with id "${id}"` };

  const r = applyVerdict(rec, { decision, edits, note, actor, amortizedFrom });
  // A refusal from applyVerdict already left the record untouched, so there is
  // nothing to roll back — that is the whole reason the validation lives there.
  if (!r.ok) return r;

  if (decision === 'edit') {
    // The battery measures the JOINT object, not the record, so an edit has to
    // land on both before it re-runs — otherwise it re-scores the old membership
    // and reports the result as if it described the new one.
    const joint = (joints || []).find((j) => j.id === id);
    if (joint) {
      for (const f of r.applied) {
        joint[f] = Array.isArray(rec[f]) ? [...rec[f]]
          : (rec[f] && typeof rec[f] === 'object' ? { ...rec[f] } : rec[f]);
      }
    }
    // `isolation` is a property of the WHOLE manifest, so an edit that moves nodes
    // can falsify a DIFFERENT record — the sibling whose part was just claimed.
    // Re-scoring only the edited record would leave that sibling showing a green
    // isolation test over nodes it no longer has. Widening to the full manifest
    // costs nothing (rest-pose, a handful of records) and only happens when nodes
    // actually moved.
    const scope = r.applied.includes('nodes') ? manifest : [rec];
    for (const t of scope) t.tests = t.tests.filter((x) => !BATTERY_TESTS.has(x.name));
    runBattery(g, joints, scope);
    retireStaleEdit(rec);
    // Confidence is deliberately NOT rewritten. It is the producer's prior and an
    // edit is a correction to membership, not a new measurement; quietly moving a
    // number the panel displays would make the button do something the human never
    // asked for. The re-run battery still decides the STATUS, which is the field
    // that actually gates generation.
  }

  applyManifest(joints, manifest);
  return {
    ok: true, id, decision: r.decision, status: rec.status,
    applied: r.applied, refused: r.refused, verdict: rec.verdict,
  };
}

// ---- phase 3, task 17: amortizing one verdict across a symmetric family -------
//
// The lateral edge, executed. A human verdict on rotor_fl is OFFERED to its
// symmetry peers so the same judgement is not demanded four times over.
//
// Two things this function refuses to be:
//
//   - a bulk write. The decision is not a parameter — it is whatever the source
//     record's verdict already says. A caller cannot use this endpoint to set an
//     arbitrary verdict on an arbitrary list of joints with a symmetry costume on.
//   - an automatic one. `toIds` is required and explicit. Amortizing to every
//     mirror by default would turn "you may offer this" into "this happened", and
//     the reason symmetry.mjs computes an offer rather than applying it is that a
//     quad with one bent arm still has four rotor ids.
//
// opts: { fromId, toIds:[ids], note, actor, center, radius }
export function amortizeVerdict(g, joints, manifest, {
  fromId, toIds, note = null, actor = 'human', center = null, radius = null,
} = {}) {
  const src = (manifest || []).find((r) => r.id === fromId);
  if (!src) return { ok: false, code: 'NO_RECORD', error: `no manifest record with id "${fromId}"` };

  const v = src.verdict;
  if (!v) {
    return { ok: false, code: 'NO_VERDICT', error: `${fromId} has no verdict to amortize — decide that joint first` };
  }
  if (!AMORTIZABLE.has(v.decision)) {
    return {
      ok: false, code: 'NOT_AMORTIZABLE',
      error: `a "${v.decision}" verdict cannot be amortized — an edit is written in ${fromId}'s own node names, and a mirror's nodes are different nodes`,
    };
  }

  const want = [...new Set((Array.isArray(toIds) ? toIds : []).filter((x) => x != null).map(String))];
  if (!want.length) {
    return { ok: false, code: 'NO_PEERS', error: 'no peers were selected — a verdict is never amortized to every mirror by default' };
  }

  // The mirror test is only meaningful against the real model centre and scale, so
  // both come from the parsed GLB unless the caller overrides them — and through
  // modelTarget/modelRadius rather than g.center/g.radius directly, because
  // `g.center` is the centroid of node ORIGINS and is XY-ONLY. Feeding a
  // two-element centre into a three-axis reflection test would silently fall back
  // to the unit sphere, and the mirror would then be computed about a point that
  // has nothing to do with the model. `g.radius` has the same problem from the
  // other side: it spreads origins only, so it under-scales a model whose geometry
  // sits far from them, and every tolerance derived from it would be too tight.
  const peers = peersOf(manifest, fromId, {
    center: Array.isArray(center) && center.length === 3 ? center : modelTarget(g),
    radius: Number.isFinite(radius) && radius > 0 ? radius : modelRadius(g),
  });
  const byPeer = new Map(peers.map((p) => [p.id, p]));

  const applied = [];
  const skipped = [];
  // A non-peer is refused rather than skipped, and the distinction is reported:
  // "this one already had a verdict" is a normal outcome, while "this one is not a
  // mirror of anything" means the caller asked for something the geometry does not
  // support and should be told instead of getting a silent partial success.
  const refused = [];
  for (const id of want) {
    const peer = byPeer.get(id);
    if (!peer) { refused.push({ id, why: `not a symmetry peer of ${fromId}` }); continue; }

    const target = manifest.find((r) => r.id === id);
    const had = target?.verdict?.decision || null;
    // A DIRECT human verdict outranks an inference drawn from a mirror. Overwriting
    // it would be the machine outvoting the person who actually looked at this
    // joint, which is the exact inversion of what the human gate is there for. An
    // inherited verdict may be replaced: it is not direct evidence, and the newer
    // family decision is at least as good.
    if (had && !target.verdict.amortizedFrom) {
      skipped.push({ id, why: `already carries a direct human verdict ("${had}")` });
      continue;
    }

    const r = applyJointVerdict(g, joints, manifest, {
      id, decision: v.decision, actor, amortizedFrom: fromId,
      note: note || `amortized from ${fromId}: ${peer.gloss}`,
    });
    if (r.ok) applied.push({ id, status: r.status, replaced: had, basis: peer.basis, gap: peer.gap, flip: peer.flip });
    else skipped.push({ id, why: r.error });
  }

  applyManifest(joints, manifest);
  return {
    ok: applied.length > 0,
    ...(applied.length ? {} : {
      code: 'NOTHING_APPLIED',
      error: 'no peer took the verdict',
    }),
    from: fromId,
    decision: v.decision,
    applied, skipped, refused,
    // The full offer, not just the part that was taken — so the panel can keep
    // showing the peers that were skipped and why, instead of only the wins.
    // `basis` goes with it, because "this is the same part reflected" and "this is
    // the same kind of part at the same reach" are different strengths of evidence
    // and the human is entitled to see which one they were shown.
    peers: peers.map((p) => ({
      id: p.id, label: p.label, basis: p.basis, flip: p.flip, gloss: p.gloss, gap: p.gap,
      nodeCount: p.nodeCount, sameNodeCount: p.sameNodeCount,
      status: p.status, verdict: p.verdict, separation: p.separation,
    })),
  };
}

// ---- phase 3, task 18: motion semantics via an annotated frame fan -----------
//
// Drive ONE already-discovered joint through a fan of angles about its own axis
// and ask a model a SEMANTIC question: what is this moving thing, and is the
// motion sensible? Nothing here is a measurement — which nodes move, and by how
// much, was settled exactly by the rigidity gate and is what built the pivot that
// draws the fan. So the round creates no records, grounds no regions and moves no
// confidence: it attaches an ASSESSMENT to the record the human is about to judge.
//
// The default fan is 0/30/60 degrees. Three poses are enough to show an arc and
// few enough that the turn stays small; a denser fan would answer a question nobody
// is asking, because the angle is known exactly and only the MEANING is in doubt.
export const MOTION_ANGLES = [0, 30, 60];

// The region a motion fan frames: the joint's own moving group. Anchored on the
// rotation centre the record already carries, so the arc stays centred as the pivot
// sweeps it, and sized to the FARTHEST extent of the group from that centre — a
// radius that only reached the group's centroid would frame the hub and crop the
// blade tips at exactly the extreme pose the fan exists to show. Used only to aim a
// fixed camera; the fan's focus list is the record's nodes verbatim, not this
// region's sphere-AABB membership, because membership is already measured.
function regionForJoint(g, rec) {
  const named = namedIndex(g);
  const label = (n) => named.get(n.i) || n.name;
  const want = new Set((rec.nodes || []).map(String));
  const bs = [];
  for (const n of renderTargets(g)) {
    if (want.has(label(n))) { const b = nodeBox(n); if (b) bs.push(b); }
  }
  const a = rec.anchor;
  const hasAnchor = a && [a.x, a.y, a.z].every(Number.isFinite);
  if (!bs.length && !hasAnchor) return null;

  let anchor = hasAnchor ? [a.x, a.y, a.z] : null;
  let radius;
  if (bs.length) {
    if (!anchor) {
      const lo = [Infinity, Infinity, Infinity]; const hi = [-Infinity, -Infinity, -Infinity];
      for (const b of bs) for (let k = 0; k < 3; k += 1) {
        lo[k] = Math.min(lo[k], b.c[k] - b.h[k]); hi[k] = Math.max(hi[k], b.c[k] + b.h[k]);
      }
      anchor = lo.map((l, k) => (l + hi[k]) / 2);
    }
    radius = bs.reduce((m, b) => Math.max(m,
      Math.hypot(b.c[0] - anchor[0], b.c[1] - anchor[1], b.c[2] - anchor[2])
      + Math.hypot(b.h[0], b.h[1], b.h[2])), 0);
  } else {
    // An anchor with no resolvable geometry (a hand-declared joint): frame a modest
    // sphere about it rather than refusing, since the pivot can still be driven.
    radius = modelRadius(g) * 0.15;
  }
  return {
    id: `motion_${rec.id}`, anchor, radius: Math.max(1e-3, radius * 1.15),
    members: [...want], reason: `drive ${rec.id} through its motion`,
  };
}

// Phase 3 task 18: ONE motion round for ONE joint. Effects are injected exactly as
// runVisionRound's are, which is what makes this testable with no browser and no
// model:
//   capture  (rec, view, angles, mode, focusNodes) => fan|null   kernel wires the
//            render farm's captureMotion + a disk readback of each pose's bytes
//   propose  (text, images) => {reply, model, ms}                kernel wires the
//            provider — the SAME multimodal transport vision uses
// A captured `fan` must carry `frames: [{index, angle, tag, id, dataBase64,
// mediaType}]` (at least two) and optionally `composite: {id, kind, dataBase64}`.
//
// `fan` bypasses capture entirely, so a round can be replayed from frames already
// on disk — the same resumability a vision round has.
export async function runMotionRound(g, joints, manifest, effects = {}) {
  const warnings = [];
  const {
    jointId = null, view: viewOverride = null, angles = MOTION_ANGLES,
    mode = 'photo', capture = null, propose = null, fan: preset = null,
    persist = null, viewport = VIEWPORT, evidenceRound = null,
  } = effects || {};

  const bail = (reason, code = null) => ({
    ok: false, jointId, reason, code, warnings, assessment: null, manifestUntouched: true,
  });

  if (!g?.nodes?.length) return bail('no parse table to aim against', 'NO_PROJECT');
  if (!Array.isArray(manifest)) return bail('no manifest to read the joint from', 'NO_MANIFEST');
  const rec = manifest.find((r) => r.id === jointId);
  if (!rec) return bail(`no manifest record with id "${jointId}"`, 'NO_RECORD');
  if (!Array.isArray(rec.nodes) || !rec.nodes.length) return bail(`${jointId} has no nodes to drive`, 'NO_NODES');

  // 1. AIM — one fixed camera framing the joint's own moving group.
  let view = viewOverride;
  if (!view) {
    const region = regionForJoint(g, rec);
    if (!region) return bail(`could not frame ${jointId}: no geometry for its nodes`, 'NO_REGION');
    // legendBudget:0 disables the mask tightening loop — a motion fan carries no
    // colour legend, so tightening would zoom in for a readability that is not
    // here. allowGhost:false — the fan is opaque poses of the moving group; a
    // see-through would hide the very intersections "is it sensible" looks for.
    const plan = planCloseUps(g, [region], { perRegion: 1, allowGhost: false, legendBudget: 0, viewport, maxViews: 1 });
    view = plan.views[0] || null;
  }
  if (!view?.pose) return bail(`no pose could be computed to frame ${jointId}`, 'NO_VIEWS');

  // 2. CAPTURE the fan.
  const focusNodes = rec.nodes.map(String);
  let fan = null;
  if (preset && Array.isArray(preset.frames) && preset.frames.length) {
    fan = preset;
    warnings.push('replayed a motion fan supplied by the caller; nothing was driven');
  } else {
    if (typeof capture !== 'function') {
      warnings.push('no capture effect was supplied, so the joint was never driven; the kernel must wire the render farm');
      return bail('no capture effect is wired — a browser renderer must be connected', 'NO_RENDERER');
    }
    try {
      fan = await capture(rec, view, angles, mode, focusNodes);
    } catch (e) {
      if (e.code === 'NO_RENDERER' || e.code === 'NO_MODEL') {
        warnings.push(`motion capture aborted: ${e.message}`);
        return bail(e.code === 'NO_RENDERER' ? 'no renderer is connected' : 'the renderer has no model loaded', e.code);
      }
      warnings.push(`motion capture failed: ${e.message}`);
      return bail('the motion fan could not be captured', e.code || 'CAPTURE_FAILED');
    }
  }
  const frames = (fan?.frames || []).filter((f) => f?.dataBase64).slice(0, MAX_MOTION_FRAMES);
  if (frames.length < 2) {
    warnings.push(`the motion fan carried ${frames.length} usable frame(s); at least 2 are needed to show an arc`);
    return bail('no usable motion fan was captured', 'NO_FRAMES');
  }

  // 3. PROMPT + TURN.
  const t0 = Date.now();
  const prompt = buildMotionPrompt({ joint: rec, frames, composite: fan.composite || null, mode });
  warnings.push(...prompt.warnings);
  if (typeof propose !== 'function') {
    warnings.push('no propose effect was supplied, so no model was asked; the kernel must wire a live vision provider');
    return bail('no vision provider is wired', 'NO_VISION_AGENT');
  }
  let turn = null;
  try {
    turn = await propose(prompt.text, prompt.images);
  } catch (e) {
    // Persist the failed exchange too: "we drove it and asked, and got nothing" is
    // evidence, and the frames are already on disk either way.
    warnings.push(`the motion turn failed: ${e.message}`);
    persist?.motion?.({
      jointId, angles: fan.angles || frames.map((f) => f.angle), mode, view, focusNodes,
      frames: frames.map((f) => ({ index: f.index, angle: f.angle, id: f.id })),
      composite: fan.composite ? { id: fan.composite.id, kind: fan.composite.kind || 'sweep' } : null,
      prompt: { text: prompt.text, images: prompt.images.length },
      reply: null, assessment: null, model: null, ms: Date.now() - t0, warnings,
    });
    return bail(e.code === 'NO_VISION_AGENT' ? 'no live multimodal model is available'
      : e.code === 'VISION_DEGRADED' ? 'the model degraded mid-turn, so its reply is a stub'
        : 'the motion model call failed', e.code || 'MOTION_FAILED');
  }

  // 4. ASSESS.
  const { assessment, warnings: assessWarnings } = motionAssess({ reply: turn?.reply || '', joint: rec });
  warnings.push(...assessWarnings);

  // 5. ANNOTATE the record. Motion is EVIDENCE for a human verdict, not a
  //    measurement, so it never touches confidence or status — the battery owns
  //    status and the human owns the verdict (task 17). It is attached as
  //    `rec.motion` and surfaced through the observation browser beside the frames.
  const motion = {
    ...(assessment || {}),
    angles: fan.angles || frames.map((f) => f.angle),
    mode, viewId: view.id ?? null,
    round: Number.isFinite(evidenceRound) ? evidenceRound : null,
    frames: frames.map((f) => ({ index: f.index, angle: f.angle, id: f.id })),
    composite: fan.composite ? { id: fan.composite.id, kind: fan.composite.kind || 'sweep' } : null,
    model: turn?.model ?? null, ms: turn?.ms ?? (Date.now() - t0),
    ts: new Date().toISOString(),
  };
  rec.motion = motion;

  persist?.motion?.({
    jointId, angles: motion.angles, mode, view, focusNodes,
    frames: motion.frames, composite: motion.composite,
    prompt: { text: prompt.text, images: prompt.images.length },
    reply: turn?.reply ?? null, assessment, model: turn?.model ?? null,
    ms: motion.ms, warnings,
  });

  return {
    ok: true, jointId, assessment,
    concerns: assessment?.concerns || [],
    label: assessment?.label ?? null,
    observedType: assessment?.observedType ?? null,
    agreesWithType: assessment?.agreesWithType ?? null,
    motionSensible: assessment?.motionSensible ?? null,
    frames: frames.length, angles: motion.angles, mode, viewId: view.id ?? null,
    model: turn?.model ?? null, ms: motion.ms,
    // The record WAS written to (rec.motion), so this is not "untouched" — but no
    // status or confidence moved, which is the distinction a caller cares about.
    manifestUntouched: false, annotated: true, warnings,
  };
}

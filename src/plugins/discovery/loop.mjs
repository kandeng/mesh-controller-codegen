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
  AUTO_ACCEPT_CONFIDENCE, applyManifest, buildManifest, deriveStatus, reopen, saveManifest,
} from './manifest.mjs';
import { attachmentSanity, discCoherence, isolation } from './tests.mjs';
import { buildProposalPrompt } from './context.mjs';
import { aiPropose } from './ai-propose.mjs';
import { MAX_VISION_FRAMES, buildVisionPrompt } from './vision-prompt.mjs';
import { visionPropose } from './vision-propose.mjs';
import { VIEWPORT } from './views.mjs';

function runBattery(g, joints, recs) {
  const iso = isolation(joints); // cross-joint test — same verdict for all
  for (const rec of recs) {
    const joint = joints.find((j) => j.id === rec.id);
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

export function selectShots(views, {
  maxFrames = MAX_VISION_FRAMES, ...budget
} = {}) {
  const { maskPairs, ghostFrames, orientation } = { ...SHOT_BUDGET, ...budget };
  const all = (views || []).filter((v) => v && Array.isArray(v.pose?.eye));
  const ghosts = all.filter((v) => v.mode === 'ghost');
  const photos = all.filter((v) => v.mode !== 'ghost');
  const cells = photos.filter((v) => v.spec?.kind === 'cell');
  const rings = photos.filter((v) => v.spec?.kind !== 'cell');
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
    push(v, 'colorId', sees(v));
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

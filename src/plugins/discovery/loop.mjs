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
import { attachmentSanity, discCoherence, isolation, scopeSpread } from './tests.mjs';
import { buildProposalPrompt } from './context.mjs';
import { aiPropose } from './ai-propose.mjs';
import { MAX_VISION_FRAMES, buildVisionPrompt, strictSchemaReminder } from './vision-prompt.mjs';
import { HINT_GATE_PROFILE, visionPropose } from './vision-propose.mjs';
import { buildLocalizationPrompt } from './localize.mjs';
import {
  buildExpectationPrompt, expectationBrief, expectationGap, expectationIsUsable,
  parseExpectation, verifiedInstances,
} from './expectation.mjs';
import { regionsFromExpectations } from './grounding.mjs';
import { applyRecognitionGate, lookupDictionary, reconcileExpectation } from './actuator-dictionary.mjs';
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
const BATTERY_TESTS = new Set(['disc-coherence', 'anchor-sphere', 'isolation', 'attachment-sanity', 'scope-spread']);

// The localization turn's grounded/admitted entries are re-indexed by this
// offset before they join the discovery turn's lists, because both parses
// number their items from 0 and the lists join by index. The actual value is
// arbitrary — it only has to be larger than any reply either turn may hold.
const HINT_INDEX_BASE = 1000;

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
    rec.tests.push(scopeSpread(g, joint));
    rec.tests.push({ ...iso });
    rec.tests.push(attachmentSanity(g, joint));
  }
}

export function runDiscoveryLoop(g, joints, { runDir = null, score = true } = {}) {
  const manifest = buildManifest(joints);
  const frontier = [...manifest]; // BFS frontier — phase 1: depth 0 only
  const producers = { L2: [], L3: [] }; // filled by runL2Round / phase 3

  // score:false is the staged-discovery seam: the geometry pass ADMITS its records
  // as candidates and defers the battery to stage 2, where it runs per joint at a
  // queue boundary. A record the battery has not scored yet stays `candidate`,
  // which is exactly the status the UI reads as "listed but not clickable".
  if (score) {
    runBattery(g, joints, frontier);
    for (const rec of frontier) rec.status = deriveStatus(rec);
  }

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
    // A confirm may name its OWN tag, because corroboration has a provenance a
    // reader needs: 'l2-vision-confirm' says the vision producer agreed with the
    // project, 'cross-producer:L2-vision' says it agreed with the TEXT producer.
    // Both go through this one path, so both are capped identically.
    t.evidence.push(c.tag || confirmTag);
    // A confirm that names what the target IS hands the recognition gate a
    // vocabulary word the record's own producer may never have been able to
    // give (the geometry lane names nothing). First name wins: a later confirm
    // corroborates, it does not rename.
    if (typeof c.part === 'string' && c.part && !t.part) t.part = c.part;
    // A corroboration may only ever LIFT. The cap keeps confirms below the
    // auto-accept threshold (physics alone crosses it), but applying min() to a
    // record physics already lifted would DEMOTE an auto-accepted joint to
    // needs-verdict — the model saying "yes, that one is real" must never cost
    // the record the status the battery earned it.
    if (t.confidence < AUTO_ACCEPT_CONFIDENCE) {
      t.confidence = Math.min(AUTO_ACCEPT_CONFIDENCE - 0.01, t.confidence + 0.05);
    }
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

// Stage-1 admission: merge a producer's delta into the manifest WITHOUT scoring
// it. mergeProposals' battery + confidence dispose is stage 2's per-joint job in
// the staged pipeline, so here a record lands exactly as the gate minted it
// (status 'candidate') and a confirm only adds its evidence tag — no confidence
// lift, no deriveStatus, because both would score a joint before its boundary.
// The split bookkeeping is kept verbatim: a candidate that claims a subset of an
// existing record must subtract it now, or `isolation` sees one node in two joints
// for the whole of stage 1.
export function admitCandidates(joints, manifest, { records = [], confirms = [] } = {}) {
  for (const c of confirms || []) {
    const t = manifest.find((r) => r.id === c.targetId);
    if (!t) continue;
    t.evidence.push(c.tag || 'cross-producer');
    // Same first-name-wins stamping as mergeProposals (see the note there).
    if (typeof c.part === 'string' && c.part && !t.part) t.part = c.part;
  }
  for (const rec of records || []) {
    if (rec.splitFrom) {
      const t = manifest.find((r) => r.id === rec.splitFrom);
      const tj = joints.find((j) => j.id === rec.splitFrom);
      if (t) {
        t.nodes = t.nodes.filter((n) => !rec.nodes.includes(n));
        t.history.push({ at: new Date().toISOString(), event: 'split-off', note: `${rec.nodes.length} nodes → ${rec.id}` });
      }
      if (tj) tj.nodes = tj.nodes.filter((n) => !rec.nodes.includes(n));
    }
    joints.push({ ...rec }); // joint-shaped view for the battery + UI
    manifest.push(rec);
  }
  applyManifest(joints, manifest);
  return { added: (records || []).length, proposals: (records || []).map((r) => r.id) };
}

// Stage-2 refinement of ONE joint: the rest-pose battery over this record alone,
// then the status the battery earned. Everything else about the record (nodes,
// evidence, provenance) is untouched — this is a measurement, not an edit.
//
// `grounded` is the vision lane's grounding of this record over the stage-1
// frames, computed in memory at round time over both channels (painted colour ids
// and the projected box). It is re-used rather than re-run from disk because the
// pre-dilation box and the raw colour ids are not persisted: groundRegion over a
// saved round would ground against the DILATED box, a lossy imitation of the real
// measurement. Re-using the round's own grounding IS re-using its frames.
//
// The measurement is also copied onto the SERVED joint object. applyManifest cannot
// do this job here: it guards confidence and evidence with `== null` / `if (!...)`,
// which is right for a first admission and wrong for a re-score — a candidate
// already carries the admission's base confidence, so the guard would leave the
// stale number on the wire and the row's tooltip would contradict its own status.
export function refineJoint(g, joints, rec, { grounded = null, emit = null } = {}) {
  const say = typeof emit === 'function' ? emit : () => {};
  if (!rec) return { ok: false, reason: 'no such record' };
  // Replace, never append: a re-run must not stack a second isolation entry next
  // to the first (same rule as the edit-verdict re-score).
  rec.tests = (rec.tests || []).filter((t) => !BATTERY_TESTS.has(t.name));
  runBattery(g, joints, [rec]);
  const fails = rec.tests.some((t) => t.level !== 'warn' && !t.pass);
  const warns = rec.tests.some((t) => t.level === 'warn' && !t.pass);
  rec.confidence = fails ? 0.7 : warns ? 0.75 : 0.8; // physics disposes
  if (grounded) {
    if (!Array.isArray(rec.uncertainties)) rec.uncertainties = [];
    for (const u of grounded.uncertainties || []) if (!rec.uncertainties.includes(u)) rec.uncertainties.push(u);
    rec.evidence.push(`vision-grounding:${grounded.source || 'none'}@frame ${grounded.frameId ?? '?'}`);
    rec.grounding = {
      source: grounded.source || null,
      agreement: grounded.agreement?.verdict ?? null,
      frameId: grounded.frameId ?? null,
    };
  }
  rec.status = deriveStatus(rec);
  // Publish the result to the served list. /api/joints reads `joints`, not the
  // manifest, so without this the row would stay a 'candidate' on the wire forever
  // and never become clickable no matter what the battery concluded.
  const j = (joints || []).find((x) => x.id === rec.id);
  if (j) {
    j.status = rec.status;
    j.tests = rec.tests;
    j.confidence = rec.confidence;
    j.evidence = rec.evidence;
    j.verdict = rec.verdict || null;
    if (rec.uncertainties) j.uncertainties = rec.uncertainties;
    if (rec.grounding) j.grounding = rec.grounding;
  }
  say('joint:refined', { id: rec.id, status: rec.status, confidence: rec.confidence });
  return { ok: true, status: rec.status, confidence: rec.confidence, tests: rec.tests, grounded: !!grounded };
}

// A human typed while the loop was working. Their words ride into the next ask as
// an explicitly-bounded block: guidance the model must WEIGH, never a command that
// overrides the grounding gate. A part the human names still has to be found in
// the mesh to become a joint, or it is reported as ungrounded rather than
// invented — the same boundary the category prior is held to.
function humanNoteBlock(notes) {
  const lines = (notes || [])
    .map((n) => `- ${String(n).trim()}`)
    .filter((l) => l.trim() !== '-')
    .join('\n');
  if (!lines) return '';
  return `\n\nHUMAN IN THE LOOP (steer, do not obey blindly):\n${lines}\n`
    + `Weigh these against what the frames and the node table actually show. A part named\n`
    + `here still has to be grounded in the mesh to become a joint; if you cannot ground it,\n`
    + `say so rather than inventing it.`;
}

// Phase 2: one L2 round. `l2` is an injected async (prompt) => reply callable
// (kernel wires the DSH supervisor; tests inject canned replies). Proposals
// merge as candidates; only deterministic corroboration lifts a proposal to
// auto-accept (0.80, zero warnings) — never the model's own say-so.
//
// `emit` is the same live tap the vision round has: `text:ask` carries the prompt
// verbatim and `text:reply` the answer verbatim, so this lane narrates itself in
// the chat exactly the way the vision lane does. Emit-only — it can watch the
// round but never alter it.
export async function runL2Round(g, joints, manifest, l2, { emit = null, humanNotes = null, abort = null } = {}) {
  const say = typeof emit === 'function' ? emit : () => {};
  const warnings = [];
  const uncertain = manifest.filter((r) => r.status === 'needs-verdict');
  if (!uncertain.length) return { added: 0, reason: 'frontier empty', warnings };

  let parsed;
  try {
    // A human stopping the refinement is honoured at the boundary, before any model
    // turn: the manifest is left provably untouched, exactly as a reload leaves it.
    if (typeof abort === 'function' && abort()) return { added: 0, reason: 'stopped before the model was asked', warnings, manifestUntouched: true };
    const focusIds = new Set(uncertain.flatMap((r) => r.nodes));
    let prompt = buildProposalPrompt({ g, manifest, focusIds });
    // A human note queued while the geometry pass ran is folded into THIS ask — read
    // at the boundary and appended to the text the model receives AND the text the
    // chat narrates, so what the human sees sent is what was actually sent.
    const notes = typeof humanNotes === 'function' ? humanNotes() : null;
    if (Array.isArray(notes) && notes.length) {
      prompt += humanNoteBlock(notes);
      say('text:note', { notes: notes.map((n) => String(n)) });
    }
    say('text:ask', { frontier: uncertain.length, prompt });
    const reply = await l2(prompt);
    say('text:reply', { reply: reply ?? null });
    parsed = aiPropose({ reply, g, manifest });
  } catch (e) {
    return { added: 0, warnings: [`L2 round failed (manifest untouched): ${e.message}`] };
  }
  warnings.push(...parsed.warnings);
  say('text:propose', {
    entries: (parsed.records || []).map((r) => ({ id: r.id, type: r.type, nodes: (r.nodes || []).slice(0, 12) })),
  });

  const merged = mergeProposals(g, joints, manifest, {
    records: parsed.records, confirms: parsed.confirms,
  });
  say('text:verdict', { added: merged.added ?? 0, proposals: merged.proposals || [] });
  return {
    added: merged.added, proposals: merged.proposals, confirms: parsed.confirms.length,
    manifestUntouched: false, warnings,
  };
}

// ---- parallel producer lanes -------------------------------------------------
//
// Two producers that do not read each other's conclusions, and ONE writer. Both
// halves matter and they pull in opposite directions:
//
//   INDEPENDENCE  a producer shown the other's output agrees with it. That is how
//                 the air3 round produced four `confirm`s of ids another pass had
//                 invented and one observation of its own: the prompt told the
//                 model those ids existed and were accepted, so it spent its
//                 proposal budget nodding. Two producers that can see each other
//                 are one producer with an echo.
//   ONE WRITER    two lanes merging into one array concurrently would interleave
//                 the battery, the node-set dedupe and the id allocation — all
//                 three of which are stateful across a whole batch.
//
// So each lane runs against a CLONE and the clones are diffed afterwards; the
// deltas are applied to the real arrays SERIALLY, through mergeProposals, which
// stays the only code in the system that writes a record. Both lanes are I/O bound
// (one text turn against a render plus two vision turns), so they overlap; only
// the merge is serial, and the merge is milliseconds.
//
// What a delta can express, and why that is enough:
//   - a record the clone has and the baseline does not  → add it
//   - a confirm tag the clone added to a PRE-EXISTING record → re-apply it through
//     the confirm path, so the only-ever-LIFTS rule stays in one place
//   - a split: the target's nodes shrank in the clone, but the split RECORD that
//     caused it carries `splitFrom`, so re-applying the record reproduces the
//     subtraction exactly once against the real target
// Everything else (confidence, status, tests) is deliberately NOT carried over:
// mergeProposals re-runs the battery on the real merged state, and `isolation` is
// a cross-joint test — a score computed inside one lane's private copy would be
// about a world that no longer exists.
function laneDelta(base, after) {
  const baseById = new Map((base || []).map((r) => [r.id, r]));
  const records = [];
  const confirms = [];
  const ignored = [];
  for (const rec of after || []) {
    const b = baseById.get(rec?.id);
    if (!b) { if (rec) records.push(rec); continue; }
    const had = new Set(b.evidence || []);
    for (const tag of (rec.evidence || []).filter((t) => !had.has(t))) {
      if (/confirm/.test(String(tag))) confirms.push({ targetId: rec.id, tag: String(tag) });
      else ignored.push(`${rec.id}: evidence "${tag}" was not carried across lanes`);
    }
  }
  return { records, confirms, ignored };
}

// Reconcile ONE lane's delta against what the manifest says NOW — which, for the
// second lane, includes what the first lane just added.
//
// Identity is the NODE SET up to substantial OVERLAP, not the id and not the type.
// Exact-set alone was too strict for the commonest kind of agreement: the geometry
// lane clusters the whole rigid unit (blade + hub + mount — 15 nodes on the air3)
// while the vision lane grounds only what its frames resolve (8 of those 15). Those
// are one part seen twice, but exact identity admitted them as TWO records — and
// because the sets share nodes, `isolation` then failed both forever: a permanent
// amber pair no human can dispose of without deleting one by hand.
//
// So a claim whose nodes are (mostly) inside an existing record's nodes is the SAME
// part: containment = shared / min(|a|,|b|), i.e. 1.0 when one claim contains the
// other. At or above OVERLAP_MERGE it becomes CORROBORATION of the best-matching
// record, routed through the confirm path with a `cross-producer:` tag; that path
// only ever LIFTS confidence and can never cross the auto-accept threshold on its
// own. Below the floor the claims merely brush (a shared mount bolt) and stay
// separate for a human to adjudicate. The kept record's node set is left UNCHANGED
// — it is the physics-validated rigid unit — and the nodes only the lane claimed are
// reported on the agreed entry, never silently absorbed.
export const OVERLAP_MERGE = 0.5;

function overlapWith(recordNodes, nodes) {
  const have = new Set(recordNodes || []);
  let shared = 0;
  for (const n of nodes || []) if (have.has(n)) shared += 1;
  const min = Math.min((recordNodes || []).length, (nodes || []).length);
  return { shared, containment: min ? shared / min : 0 };
}

// What makes a record an expectation hint, wherever the question is asked:
// the union in runVisionRound stamps `hinted`, and the gate profile stamps
// the origin — either alone suffices, because a stamp on the RECORD survives
// paths gate metadata would not (a reconcile option, a persisted round).
export const isHintRecord = (r) => r?.hinted === true || r?.origin === 'expectation-hint';

// `prefer` marks the incoming records the overlap rule should be INVERTED
// for. Default null: an incoming record that overlaps a live one corroborates
// it, exactly as below. When the predicate holds (the expectation hints),
// the incoming record SUPERSEDES instead: it lands as the record of the part
// and the overlapped live record leaves the live set, reported on
// `superseded` for the caller to retire and to move its evidence onto the
// hint. That is Task 4's demotion rule — for a dictionary-covered part the
// geometry lane corroborates the hint; unknown categories mint no hints, so
// nothing there changes.
export function reconcileLanes(manifest, delta, { origin = null, tag = null, overlap = OVERLAP_MERGE, prefer = null } = {}) {
  const key = (nodes) => [...(nodes || [])].sort().join('|');
  const bySet = new Map();
  const live = [];
  for (const r of manifest || []) if (r?.id) { bySet.set(key(r.nodes), r); live.push(r); }
  const records = [];
  const confirms = [...(delta?.confirms || [])];
  const agreed = [];
  const superseded = [];
  for (const rec of delta?.records || []) {
    if (!rec?.nodes?.length) continue;
    const exact = bySet.get(key(rec.nodes));
    let hit = exact || null;
    let stats = exact ? { shared: rec.nodes.length, containment: 1 } : null;
    if (!hit) {
      let best = 0;
      for (const r of live) {
        const s = overlapWith(r.nodes, rec.nodes);
        if (s.shared > 0 && s.containment >= overlap && s.containment > best) { hit = r; best = s.containment; stats = s; }
      }
    }
    if (hit) {
      // SUPERSEDE. Three guards keep the rule narrow: a record carrying ANY
      // human verdict is off-limits in both directions (a person's "no" ranks
      // exactly as high as a person's "yes"); a hint never supersedes another
      // hint (same-turn duplicates were absorbed at the union, older ones are
      // settled work); and the hint must not be LARGER than the record it
      // replaces — a sloppy hint box around a truthful geometry scope
      // corroborates instead of replacing, which is exactly the pre-hint
      // behaviour for that case.
      if (typeof prefer === 'function' && prefer(rec) && !prefer(hit) && hit.verdict == null
        && rec.nodes.length <= (hit.nodes || []).length) {
        bySet.delete(key(hit.nodes));
        live.splice(live.indexOf(hit), 1);
        records.push(rec);
        bySet.set(key(rec.nodes), rec);
        live.push(rec);
        superseded.push({
          id: hit.id, by: rec.id, origin: hit.origin || null,
          match: exact ? 'exact' : 'overlap',
          shared: stats.shared,
          containment: Number(stats.containment.toFixed(2)),
          // What the superseded record claimed that the hint does not — the
          // monster's extra, reported so a human can see what was given up.
          laneOnly: exact ? [] : (hit.nodes || []).filter((n) => !rec.nodes.includes(n)),
        });
        continue;
      }
      confirms.push({
        targetId: hit.id,
        tag: tag || `cross-producer:${origin || 'unknown'}`,
        // The lane's recognition of the shared parts rides onto the existing
        // record through the confirm-stamping path — agreement is exactly the
        // moment a geometry record earns the name it could not give itself.
        ...(typeof rec.part === 'string' && rec.part ? { part: rec.part } : {}),
      });
      agreed.push({
        id: hit.id, nodes: (rec.nodes || []).length, from: origin || null,
        discardedId: rec.id,
        // Reported, never reconciled away: a type disagreement between producers
        // is exactly the kind of thing a human should see, and picking one
        // silently would be a third producer with no evidence.
        typeMismatch: hit.type !== rec.type ? { kept: hit.type, lane: rec.type } : null,
        // HOW the two claims matched, so a reader can tell a perfect agreement from
        // a near-one: 'exact' = identical node sets, 'overlap' = one claim is
        // (mostly) inside the other, with the shared count and the nodes only the
        // lane claimed carried alongside for transparency.
        match: exact ? 'exact' : 'overlap',
        shared: stats.shared,
        containment: Number(stats.containment.toFixed(2)),
        laneOnly: exact ? [] : (rec.nodes || []).filter((n) => !(hit.nodes || []).includes(n)),
      });
      continue;
    }
    records.push(rec);
    bySet.set(key(rec.nodes), rec);
    live.push(rec);
  }
  return { records, confirms, agreed, superseded };
}

// Run both lanes. `text` and `vision` are async callables handed the CLONES they
// may write into — `(manifest, joints) => result` — and either may be omitted, so
// a server with no renderer connected still runs the text lane and reports.
//
// A lane that THROWS does not take the other down with it (Promise.allSettled):
// one producer being unavailable is the normal case, not an error, and the whole
// design premise is that each stands alone.
export async function runProducerLanes(g, joints, manifest, { text = null, vision = null, emit = null } = {}) {
  const say = typeof emit === 'function' ? emit : () => {};
  const warnings = [];
  const lanes = [
    { name: 'text', origin: 'L2-ai', run: text },
    { name: 'vision', origin: 'L2-vision', run: vision },
  ].filter((l) => typeof l.run === 'function');
  if (!Array.isArray(manifest)) return { ok: false, code: 'NO_MANIFEST', error: 'no manifest to merge into', lanes: {}, added: 0, agreed: [] };

  const snapshot = () => ({
    manifest: structuredClone(manifest),
    joints: structuredClone(Array.isArray(joints) ? joints : []),
  });
  // The baseline every delta is measured against. Taken ONCE, before any lane
  // runs: a lane must be diffed against the state it was handed, not against the
  // state the other lane left behind.
  const base = snapshot();

  const settled = await Promise.allSettled(lanes.map(async (lane) => {
    const copy = snapshot();
    const res = await lane.run(copy.manifest, copy.joints);
    return { lane, res, copy };
  }));

  const perLane = {};
  const agreed = [];
  let added = 0;
  settled.forEach((s, i) => {
    const lane = lanes[i];
    if (s.status !== 'fulfilled') {
      perLane[lane.name] = { ok: false, added: 0, error: s.reason?.message || String(s.reason) };
      warnings.push(`the ${lane.name} lane failed: ${perLane[lane.name].error}`);
      return;
    }
    const res = s.value?.res ?? null;
    const delta = laneDelta(base.manifest, s.value.copy.manifest);
    warnings.push(...delta.ignored.map((w) => `${lane.name} lane: ${w}`));
    // Applied SERIALLY, in lane order, against the real arrays — so the second
    // lane is reconciled against what the first one actually added.
    const recon = reconcileLanes(manifest, delta, { origin: lane.origin });
    const merged = mergeProposals(g, joints, manifest, {
      records: recon.records, confirms: recon.confirms,
    });
    agreed.push(...recon.agreed);
    added += merged.added || 0;
    perLane[lane.name] = {
      ok: res?.ok !== false,
      added: (delta.records?.length || 0),
      merged: merged.added || 0,
      corroborated: recon.agreed.length,
      confirms: (delta.confirms?.length || 0) + recon.agreed.length,
      code: res?.code || null,
      reason: res?.reason || null,
      frames: res?.frames ?? null,
      expectation: res?.expectation ?? null,
      gaps: res?.gaps ?? null,
    };
    say('lane:merged', { lane: lane.name, origin: lane.origin, ...perLane[lane.name] });
  });

  return {
    ok: added > 0 || agreed.length > 0 || Object.values(perLane).some((l) => l.ok),
    added,
    agreed,
    lanes: perLane,
    proposals: (manifest || []).slice(base.manifest.length).map((r) => r.id),
    manifestUntouched: added === 0 && agreed.length === 0,
    warnings,
  };
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
// Five allocations, in order of what a frame is worth:
//
//  1. SURVEY — the omni tier the planner FORCED (front/right/back/left at 25°,
//     plus a true top-down and a true bottom-up). It goes first and it is
//     guaranteed inside the cap, because it is the only allocation that answers
//     "what machine is this" rather than "which node have we not seen yet": the
//     category turn reads exactly these frames, and a machine nobody has looked at
//     from underneath has not been surveyed whatever its coverage number says.
//  2. ORIENTATION — further whole-model photos. A cropped region is
//     uninterpretable without one; the model has to know where in the machine it is
//     looking. The survey tier usually satisfies this already, so whatever the cap
//     has left is what this buys.
//  3. MASK PAIRS on the TIGHTEST views. A colorId mask is the only channel that
//     grounds EXACTLY, so it earns a share of the budget — but only where it is
//     usable: a cell view frames ~12-20 parts, so its legend is readable and every
//     colour resolves. A whole-model survey would paint all ~345 named parts and
//     the legend would be noise. Tightest-first, because readability is what makes
//     the exact channel actually exact in practice.
//     THE PAIRING IS THE POINT: the mask and the clay frame share ONE pose,
//     because reconcile() compares the box a model draws against the colours it
//     reads, and that comparison means nothing across two different cameras.
//     The visual half of the pair is CLAY, not a photo: a tight view answers
//     scoping questions ("how far does this part extend, what is it made of")
//     and those are shape questions. Clay strips colour and texture — on a
//     dark hull the difference between a readable frame and a silhouette —
//     while the survey and orientation photos still carry the real colours.
//  4. GHOSTS — the only route to interior-only parts, which no opaque pose can
//     ever show. A ghost with no focus list draws everything opaque, which is an
//     ordinary photo and not a ghost at all, so `sees` is mandatory here and a
//     ghost that sees nothing is skipped rather than shot.
//  5. FILL — whatever budget remains buys plain photos in the planner's own
//     marginal-gain order, skipping poses already shot.
//
// The budget is over-allocated by design (6 + 2x2 + 1 + 2 = 13 against a 12-frame
// cap) and the cap resolves it from the bottom: the survey tier is never what gets
// dropped, the second orientation frame is. Trading mask pairs 3→2 and ghosts 2→1
// for a coherent whole-machine view set is the deliberate part of that bargain —
// exact-colour grounding loses a little coverage and the round gains a machine it
// can actually recognise.
export const SHOT_BUDGET = { survey: 6, maskPairs: 2, ghostFrames: 1, orientation: 2 };

// A pose fitted to a PART-SIZED region rather than to the whole model: the kd cell
// pass of round 1, and the close-ups round 2 aims at a suggestView. Only these can
// carry a mask, because only these frame few enough parts for a legend to be
// readable — and readability is what makes the exact channel actually exact.
// 'survey' is deliberately NOT here: a whole-machine mask legend is unreadable.
const TIGHT_KINDS = new Set(['cell', 'close-up']);

// Whole-machine tiers: the fitted six-direction survey AND the panel-framed
// twelve (kind 'panel', the human's own distance/FOV). Both are the "what
// machine is this" allocation in selectShots and neither may carry a mask — a
// whole-machine legend is unreadable at either framing.
const SURVEY_KINDS = new Set(['survey', 'panel']);

export function selectShots(views, {
  maxFrames = MAX_VISION_FRAMES, ...budget
} = {}) {
  const { survey, maskPairs, ghostFrames, orientation } = { ...SHOT_BUDGET, ...budget };
  const all = (views || []).filter((v) => v && Array.isArray(v.pose?.eye));
  const ghosts = all.filter((v) => v.mode === 'ghost');
  const photos = all.filter((v) => v.mode !== 'ghost');
  const cells = photos.filter((v) => TIGHT_KINDS.has(v.spec?.kind));
  const surveys = photos.filter((v) => SURVEY_KINDS.has(v.spec?.kind));
  const rings = photos.filter((v) => !SURVEY_KINDS.has(v.spec?.kind) && !TIGHT_KINDS.has(v.spec?.kind));
  const cap = Math.max(1, maxFrames | 0);
  const sees = (v) => (Array.isArray(v.sees) && v.sees.length ? v.sees.map(String) : null);

  const shots = [];
  const photographed = new Set();
  const push = (view, mode, focusNodes) => {
    if (!view || shots.length >= cap) return false;
    // A pose with a full-context visual in EITHER skin is spent: the fill below
    // must not re-shoot a clay-scoped pose as a photo and call it new evidence.
    if (mode === 'photo' || mode === 'clay') {
      if (photographed.has(view.id)) return false;
      photographed.add(view.id);
    }
    shots.push({ viewId: view.id, view, mode, focusNodes });
    return true;
  };

  for (const v of surveys.slice(0, Math.max(0, survey | 0))) push(v, 'photo', null);
  for (const v of rings.slice(0, Math.max(0, orientation | 0))) push(v, 'photo', null);

  // Tightest first; ties keep the planner's marginal-gain order. When a plan has
  // NO tight view (a panel-framed survey is all whole-machine poses), no mask is
  // bought at all: the `photos` fallback would paint every named part in the
  // model and the legend would be the very wall of colour this rule exists to
  // avoid — the fallback only ever made sense for plans that mix tiers.
  const maskable = (cells.length ? cells : [])
    .map((v, i) => ({ v, i, n: sees(v)?.length ?? Infinity }))
    .sort((a, b) => (a.n - b.n) || (a.i - b.i))
    .slice(0, Math.max(0, maskPairs | 0));
  for (const { v } of maskable) {
    push(v, 'clay', null);
    // Same rule as ghosts, for the same reason: an unfocused colorId paints EVERY
    // named part in the model, so its legend is a wall of ~345 colours and the
    // exact channel resolves nothing. A view with no predicted visibility gets
    // the clay frame only.
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
    survey = SHOT_BUDGET.survey,
    maskPairs = SHOT_BUDGET.maskPairs, ghostFrames = SHOT_BUDGET.ghostFrames,
    orientation = SHOT_BUDGET.orientation,
    // The ABSOLUTE round directory this round's frames were written to. Stamped
    // onto the records it adds, because a frame id is unique within a round but
    // not across campaigns: without it the observation browser cannot tell which
    // r<N>/ holds the pixels behind a claim. Null (the default) leaves the
    // records unstamped and the browser falls back to a scan.
    evidenceRound = null,
    // Optional LIVE progress tap: emit(kind, payload) at each observable beat
    // (plan / frame / ask / reply / propose / verdict). Emit-only — it can watch
    // the round but never alter it, so a caller that streams progress to a browser
    // and a caller that runs headless exercise identical logic.
    emit = null,
    // Optional cancellation predicate. A vision round plans and captures against
    // ONE project; if the caller's project changed underneath it (a reload),
    // every further frame and every merge would be about a mesh nobody asked
    // about. Checked at each phase boundary, never mid-await.
    abort = null,
    // Optional human-in-the-loop hook: a function returning the steering notes a
    // human typed while the frames were rendering. Read at the ask boundary and
    // folded into the discovery prompt — guidance the model weighs, never a command
    // that bypasses the grounding gate.
    humanNotes = null,
    // Optional HUMAN REFERENCE IMAGES: the pictures behind a steering note, in
    // the same [{ mediaType, dataBase64, name }] shape agent.send() uses. They
    // are attached AFTER the rendered frames and are guidance, never evidence —
    // a proposal still has to cite a frame we drew, because that is the only
    // frame grounding has a camera pose for.
    extraImages = null,
    // Ask WHAT KIND OF MACHINE this is before asking what moves on it, over the
    // same frames (see expectation.mjs). Off by default so a single manual round
    // stays one turn; the campaign switches it on for round 1, which is the only
    // round with a survey tier to read a category from.
    expectation: wantExpectation = false,
    // Ask WHERE EACH EXPECTED PART is (turn A′, localize.mjs) once the prior
    // named a dictionary category: the reference list becomes pointed per-part
    // hints that join the discovery proposals below. On by default because it
    // can only fire when a usable dictionary prior already exists; a caller may
    // switch it off to get the exact two-turn round this lane predates.
    localize: wantLocalize = true,
    // Run this lane as an INDEPENDENT observer: the prompt withholds the other
    // producer's conclusions and the gate stops treating a geometry or text guess
    // as a claim on the parts. Two producers agreeing then reconciles into one
    // record instead of one dropped proposal.
    independent = false,
    // STAGED DISCOVERY seam: stop after step 5 and hand back the round's
    // PROPOSALS — grounded, but not yet judged. The orchestrator lists them as
    // candidates immediately and lets the battery score each joint later, at a
    // queue boundary; merging here would score them in one batch and hide the
    // list until every joint settled, which is the one-shot behaviour this seam
    // exists to split. `proposals` on this path carries RECORD OBJECTS, not the
    // merged ids the default path returns.
    stopAfter = null,
  } = effects || {};
  const say = typeof emit === 'function' ? emit : () => {};

  // One shape for every failure, always carrying the reason and always stating
  // that nothing was mutated — the caller must never have to guess.
  const bail = (reason, code = null) => ({
    ok: false, added: 0, reason, code, warnings, proposals: [], manifestUntouched: true,
  });

  if (!g?.nodes?.length) return bail('no parse table to ground against', 'NO_PROJECT');
  if (!Array.isArray(manifest)) return bail('no manifest to merge into', 'NO_MANIFEST');
  if (typeof abort === 'function' && abort()) return bail('the project changed while this round was starting', 'PROJECT_RELOADED');

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
  say('vision:plan', {
    views: (plan.views || []).map((v) => ({
      id: v.id, mode: v.mode || null, eye: v.pose?.eye || null, target: v.pose?.target || null,
    })),
  });

  // 2. CAPTURE ------------------------------------------------------------
  const shots = selectShots(plan.views, { maxFrames, survey, maskPairs, ghostFrames, orientation });
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
      if (typeof abort === 'function' && abort()) return bail('the project changed while this round was capturing', 'PROJECT_RELOADED');
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
  if (typeof abort === 'function' && abort()) return bail('the project changed before the model was asked', 'PROJECT_RELOADED');

  // 3. CATEGORY PRIOR — turn A ---------------------------------------------
  //
  // Two turns, one round, ONE set of frames: the prior is read from the survey
  // photos the discovery turn is about to be shown, so nothing extra is rendered
  // for it. This turn asks what kind of machine this is and what a machine of
  // that kind usually moves; the next asks for the joints themselves, with this
  // answer attached as a hypothesis to FALSIFY.
  //
  // It may fail, and when it does the round carries on exactly as it did before
  // this lane existed — no hypothesis block, no expectation-aimed round 2. A
  // prior is an optimisation, never a dependency: bailing out here would make a
  // guess load-bearing, which is the one thing this module is designed not to be.
  //
  // The boundary is structural, not disciplinary. Nothing parsed here is ever
  // handed to mergeProposals; it reaches turn B as TEXT and round 2 as a PLACE
  // TO AIM, and that is all.
  let expectation = null;
  let gapsAtAsk = [];
  if (wantExpectation) {
    if (typeof propose !== 'function') {
      warnings.push('category turn: asked for, but no vision provider is wired — the round carries on with no prior');
    } else {
      const ep = buildExpectationPrompt({ frames: captured, g, viewport });
      const expWarnings = ep.warnings.map((w) => `category turn: ${w}`);
      let expReply = null;
      let expModel = null;
      if (!ep.text) {
        expWarnings.push('category turn: no whole-machine photo to read a category from, so no prior was asked for');
      } else {
        const e0 = Date.now();
        try {
          const et = await propose(ep.text, ep.images);
          expReply = et?.reply ?? null;
          expModel = et?.model ?? null;
          // The SAME viewport the prompt was built with, so a regionBox the model
          // drew in pixels is divided by the frame it was actually drawn on.
          const parsedExp = parseExpectation(expReply, { frameIds: (ep.frames || []).map((f) => f.id), viewport });
          expWarnings.push(...parsedExp.warnings.map((w) => `category turn: ${w}`));
          expectation = parsedExp.expectation;
          // parseExpectation hands back an empty sentinel for a reply it could not
          // read at all. Reported as null rather than as a blank object, so a
          // caller cannot mistake "the model said nothing usable" for "the model
          // described a machine with no moving parts".
          if (!expectation.category && !(expectation.instances || []).length) expectation = null;
          // The actuator dictionary's verdict on the category: a hit pins the
          // expected counts to the table's deterministic values (and hands the
          // discovery turn the reference list as a hypothesis); a miss leaves
          // the model's own counts in charge, exactly as before the table.
          if (expectation) {
            const rec0 = reconcileExpectation(expectation);
            expWarnings.push(...rec0.warnings.map((w) => `category turn: ${w}`));
          }
          // Gaps AT ASK TIME: the prior against what the project already believes
          // BEFORE this round adds anything. That is the comparison turn B can act
          // on ("3 of the 4 rotors it expects are already on the books — find the
          // missing one"), and it is deliberately not the number reported at the
          // end of the round.
          gapsAtAsk = expectationGap(expectation, manifest);
        } catch (err) {
          expectation = null;
          gapsAtAsk = [];
          expWarnings.push(`category turn: the model call failed (${err.message}) — the round carries on with no prior`);
        }
        // Persisted even when it failed or was refused: "we guessed X and the
        // guess was unusable" is part of the audit trail, and a round whose prior
        // left no file is indistinguishable from a round that never asked.
        persist?.expectation?.({
          prompt: { text: ep.text, frames: ep.frames, images: ep.images.length },
          reply: expReply, expectation, gaps: gapsAtAsk,
          model: expModel, ms: Date.now() - e0, warnings: expWarnings,
        });
      }
      warnings.push(...expWarnings);
      say('vision:expect', {
        usable: expectationIsUsable(expectation),
        category: expectation?.category || null,
        confidence: expectation?.confidence ?? null,
        summary: expectation?.summary || null,
        instances: (expectation?.instances || []).map((ins) => ({
          type: ins.type, count: ins.count, frameId: ins.frameId,
          regionBox: ins.regionBox, symmetry: ins.symmetry || null, note: ins.note || null,
        })),
        dictKey: expectation?.dictKey || null,
        dictCounts: expectation?.dictCounts || null,
        gaps: gapsAtAsk,
        doubts: expectation?.doubts || [],
        alternatives: expectation?.alternatives || [],
        // The verbatim exchange rides along so the chat can narrate this turn the
        // way it narrates the discovery one: a guess the loop is about to test is
        // only auditable if a human can read what was asked and what came back.
        prompt: ep.text, reply: expReply, model: expModel,
        warnings: expWarnings,
      });
    }
  }

  // 3b. PER-PART LOCALIZATION — turn A′ --------------------------------------
  //
  // The category turn said WHAT this machine is; the dictionary entry that
  // matched it says WHICH parts such a machine carries. This turn closes the
  // gap: the model points at EVERY expected part individually (four wheels are
  // four entries, where the category turn's were one entry with count 4), the
  // reply parses through the SAME visionPropose channel as the discovery turn
  // under the hint gate profile, and what survives unions into turn B's lists
  // below. Grounding resolves the node sets and the battery disposes of them,
  // exactly as for a free proposal — the only difference is provenance
  // (`hinted: true`, origin 'expectation-hint'), and provenance is what the
  // supersede rule in reconcileLanes reads.
  //
  // Same failure contract as the category turn: it may fail, and when it does
  // the round carries on with no hints. A prior is an optimisation, never a
  // dependency.
  let hints = [];
  let hintGrounded = [];
  let hintAdmitted = [];
  let hintConfirms = [];
  if (wantExpectation && wantLocalize && expectation?.dictKey && expectationIsUsable(expectation)) {
    const dictHit = lookupDictionary(expectation.category);
    if (!dictHit?.entry) {
      warnings.push('localization turn: the prior named a dictionary key whose entry is gone — no hints were asked for');
    } else if (typeof propose !== 'function') {
      warnings.push('localization turn: asked for, but no vision provider is wired — the round carries on with no hints');
    } else if (typeof abort === 'function' && abort()) {
      return bail('the project changed while the localization turn was starting', 'PROJECT_RELOADED');
    } else {
      const lp = buildLocalizationPrompt({
        frames: captured, g, viewport,
        dictKey: dictHit.key, entry: dictHit.entry, gaps: gapsAtAsk,
      });
      const locWarnings = lp.warnings.map((w) => `localization turn: ${w}`);
      let locReply = null;
      let locModel = null;
      if (!lp.text) {
        locWarnings.push('localization turn: there was no whole-machine photo to point at parts in, so no hints were asked for');
      } else {
        const l0 = Date.now();
        try {
          const lt = await propose(lp.text, lp.images);
          locReply = lt?.reply ?? null;
          locModel = lt?.model ?? null;
          const hp = visionPropose({
            reply: locReply || '', g, manifest, frames: captured, plan, viewport,
            // Always an INDEPENDENT observer, whatever the round's own flag: a
            // hint is a second producer's reading of the reference list, so an
            // exact overlap with a settled record must corroborate that record,
            // never be silently absorbed by it.
            independent: true,
            // The prompt asked for lp.asked items (one per dictionary part), so
            // the parse cap is the same number — the shared proposal cap would
            // silently cut a 16-part reply to 6.
            maxProposals: lp.asked,
            profile: HINT_GATE_PROFILE,
          });
          locWarnings.push(...hp.warnings.map((w) => `localization turn: ${w}`));
          hints = hp.records;
          hintConfirms = hp.confirms;
          // The gate cannot know the record came from a reference list, so the
          // provenance stamp goes on here — on the RECORD ITSELF, not on gate
          // metadata a later merge could override.
          for (const r of hints) {
            r.hinted = true;
            r.evidence = [...(r.evidence || []), `dictionary:${dictHit.key}`];
          }
          // Both turns number their reply items from 0 and the survivors/
          // rejected join below works by index, so the hint half is shifted out
          // of the discovery turn's numbering before the lists union.
          hintGrounded = hp.grounded.map((e) => ({ ...e, index: e.index + HINT_INDEX_BASE }));
          hintAdmitted = hp.admitted.map((a) => ({ ...a, index: a.index + HINT_INDEX_BASE }));
        } catch (err) {
          locWarnings.push(`localization turn: the model call failed (${err.message}) — the round carries on with no hints`);
        }
        // Persisted even when it failed, for the same reason the category turn
        // is: a round whose hints left no file is indistinguishable from one
        // that never asked.
        persist?.localization?.({
          prompt: { text: lp.text, frames: lp.frames, images: lp.images.length },
          reply: locReply, model: locModel, ms: Date.now() - l0,
          dictKey: dictHit.key, asked: lp.asked,
          records: hints, confirms: hintConfirms, grounded: hintGrounded,
          warnings: locWarnings,
        });
      }
      warnings.push(...locWarnings);
      say('vision:localize', {
        dictKey: dictHit.key,
        asked: lp.asked,
        hints: hints.map((r) => ({ id: r.id, label: r.label || null, nodes: (r.nodes || []).slice(0, 12) })),
        prompt: lp.text, reply: locReply, model: locModel,
        warnings: locWarnings,
      });
    }
  }

  // 4. PROMPT + TURN — turn B, the discovery turn ---------------------------
  const t0 = Date.now();
  const prompt = buildVisionPrompt({
    manifest, frames: captured, plan, maxFrames, g, viewport,
    // The prior as TEXT to falsify, never as records to agree with. Empty when
    // the category turn did not run, failed, or was not usable — which leaves the
    // prompt exactly as this round built it before the lane existed.
    hypothesis: expectationBrief(expectation, gapsAtAsk),
    independent,
    extraImages: Array.isArray(extraImages) ? extraImages : [],
  });
  warnings.push(...prompt.warnings);
  // A human note arriving while the frames were rendering is folded into THIS ask —
  // read at the boundary, appended to the text the model receives and the text the
  // chat narrates, so what the human sees sent is exactly what was sent.
  const vNotes = typeof humanNotes === 'function' ? humanNotes() : null;
  if (Array.isArray(vNotes) && vNotes.length) {
    prompt.text += humanNoteBlock(vNotes);
    say('vision:note', { notes: vNotes.map((n) => String(n)), references: prompt.references.length });
  }
  say('vision:ask', { frames: captured.length, prompt: prompt.text });

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
  say('vision:reply', { model: turn?.model ?? null, reply: turn?.reply ?? null });

  // 5. GROUND + VALIDATE --------------------------------------------------
  let parsed = visionPropose({
    reply: turn?.reply || '', g, manifest, frames: captured, plan, viewport, independent,
  });
  // STRICT-SCHEMA RETRY — one shot, format failures only. A reply that carried
  // no extractable proposal items at all (a prose essay about the machine, an
  // empty text, broken JSON) is not the model's JUDGEMENT that nothing moves;
  // it is the model answering the wrong question. Measured on a real Porsche
  // run: the category turn read "sports car / coupe" perfectly and the
  // discovery turn answered in prose, so a machine with obvious moving parts
  // landed zero candidates and the chat could only say "the model proposed
  // nothing". The retry re-asks over the SAME frames with the schema restated
  // and the offending reply quoted back. A reply that parsed but was rejected
  // downstream (grounding, the gate, the battery) never comes here — that is a
  // judgement, and round 2's close-ups are its remedy, not a re-ask.
  let formatFailure = null;
  let retry = null;
  const PARSE_FAIL = /no JSON array found in reply|parsed value is not an array|JSON parse failed/;
  if (!parsed.records.length && !parsed.confirms.length && parsed.warnings.some((w) => PARSE_FAIL.test(w))
    && !(typeof abort === 'function' && abort())) {
    const why = parsed.warnings.find((w) => PARSE_FAIL.test(w));
    formatFailure = `the model answered in a format the grounding gate cannot read (${why}), so no proposal was extractable`;
    warnings.push(`${formatFailure} — asking once more with the schema restated`);
    say('vision:retry', { reason: why, replyExcerpt: String(turn?.reply || '').slice(0, 400) });
    const retryText = prompt.text + strictSchemaReminder(turn?.reply);
    const t1r = Date.now();
    try {
      const turn2 = await propose(retryText, prompt.images);
      retry = {
        prompt: { text: retryText, frames: prompt.frames, images: prompt.images.length },
        reply: turn2?.reply ?? null, model: turn2?.model ?? null, ms: Date.now() - t1r,
      };
      const parsed2 = visionPropose({ reply: turn2?.reply || '', g, manifest, frames: captured, plan, viewport, independent });
      if (parsed2.records.length || parsed2.confirms.length) {
        parsed = parsed2;
        retry.recovered = true;
        formatFailure = null; // recovered: the round reads as if the first reply had behaved
        warnings.push('the strict-schema retry recovered the round — its proposals replace the unparseable first reply');
      } else {
        retry.recovered = false;
        warnings.push(...parsed2.warnings.map((w) => `retry: ${w}`));
        warnings.push('the strict-schema retry also produced nothing parseable — the round keeps the first attempt\'s empty result');
      }
    } catch (e) {
      retry = { error: e.message, ms: Date.now() - t1r };
      warnings.push(`the strict-schema retry itself failed: ${e.message}`);
    }
    // Both turns persist into the one reply.json — the prose and the retry sit
    // beside each other in the audit trail instead of one overwriting the other.
    persist?.reply?.({ ...replyRecord, retry });
    if (retry && retry.reply != null) say('vision:reply', { model: retry.model ?? null, reply: retry.reply, retry: true });
  }
  // The hints union in AFTER the strict-schema retry, never before it: the
  // retry replaces `parsed` wholesale, so hints unioned earlier would be lost.
  if (hints.length || hintConfirms.length) {
    // A part pointed at TWICE is ONE part — whether the duplicate is turn B
    // finding on its own what the reference list asked for, or the
    // localization reply pointing two entries at the same place against its
    // instructions. mergeProposals appends every record it is handed, and its
    // confirms can only target records ALREADY on the books, so the absorption
    // happens here, where both parses are in hand: under the same containment
    // rule reconcileLanes applies between lanes, the later copy drops to an
    // EVIDENCE TAG on the earlier one. Hints union first so the record that
    // survives is the one carrying the dictionary's per-part provenance, and
    // every absorption is announced, never silent.
    const kept = [];
    const incoming = [
      ...hints.map((rec) => ({ rec, tag: 'expectation-hint-corroboration' })),
      ...parsed.records.map((rec) => ({ rec, tag: 'l2-vision-confirm' })),
    ];
    for (const { rec, tag } of incoming) {
      const twin = (rec.nodes || []).length
        ? kept.find((k) => {
          const s = overlapWith(k.nodes, rec.nodes);
          return s.shared > 0 && s.containment >= OVERLAP_MERGE;
        })
        : null;
      if (twin) {
        twin.evidence = [...(twin.evidence || []), tag];
        // The duplicate's recognition still counts: a name the twin lacks
        // rides across under the same first-name-wins rule a confirm uses.
        if (typeof rec.part === 'string' && rec.part && !twin.part) twin.part = rec.part;
        warnings.push(`${rec.id} is the same part as ${twin.id} — it corroborates it instead of landing twice`);
      } else {
        kept.push(rec);
      }
    }
    parsed = {
      ...parsed,
      records: kept,
      confirms: [...hintConfirms, ...parsed.confirms],
      grounded: [...hintGrounded, ...parsed.grounded],
      admitted: [...hintAdmitted, ...parsed.admitted],
    };
  }
  warnings.push(...parsed.warnings);
  say('vision:propose', {
    entries: (parsed.records || []).map((r) => ({
      id: r.id, label: r.label || null, anchor: r.anchor || null, axis: r.axis || null,
      nodes: (r.nodes || []).slice(0, 12),
    })),
  });

  const survivors = new Set(parsed.admitted.map((a) => a.index));
  const rejected = parsed.grounded
    .filter((e) => !survivors.has(e.index))
    .map((e) => ({ index: e.index, frameId: e.frameId, names: e.names, grounding: e.grounding, uncertainties: e.uncertainties }));

  if (stopAfter === 'proposals') {
    // THE RECOGNITION GATE, proposals-only flavour: the records are not in the
    // manifest yet (the orchestrator admits them), so the gate marks the
    // proposal objects themselves and the marks ride along with them.
    const recognition = applyRecognitionGate(parsed.records, { category: expectation?.category || null });
    for (const n of recognition.notes) warnings.push(`recognition gate: ${n}`);
    say('vision:recognition', recognition);
    // The audit trail is written exactly as the merging path would write it, so a
    // staged round is replayable from disk like any other; the evidence-round
    // stamp goes onto the records here because there is no post-merge step to do
    // it later, and only this caller knows which directory the frames went to.
    if (Number.isFinite(evidenceRound)) {
      for (const r of parsed.records) r.frameRound = evidenceRound;
    }
    persist?.proposals?.({
      records: parsed.records, confirms: parsed.confirms,
      warnings: parsed.warnings, rejected,
      grounded: parsed.grounded, suggestViews: parsed.suggestViews,
    });
    return {
      ok: true,
      stopped: 'proposals',
      added: 0,
      proposals: parsed.records,
      confirms: parsed.confirms.length,
      confirmList: parsed.confirms,
      retested: 0,
      reason: parsed.records.length ? null : (formatFailure || 'the model proposed nothing'),
      retried: !!retry,
      formatFailure,
      views: plan.views.length,
      shots: shots.length,
      frames: captured.length,
      coverage: plan.coverage ?? null,
      interiorOnly: plan.interiorOnly ?? null,
      grounded: parsed.grounded,
      admitted: parsed.admitted,
      rejected,
      suggestViews: parsed.suggestViews,
      expectation,
      expectationUsable: expectationIsUsable(expectation),
      gaps: expectation ? expectationGap(expectation, manifest) : null,
      expectationVerified: expectation ? verifiedInstances(expectation, parsed.grounded) : null,
      recognition,
      // How many of the surviving proposals came from the localization turn's
      // reference list rather than the model's own search. Provenance per
      // record is on the record (`hinted`); this count is the one-glance
      // version. Counted AFTER the union's absorption, so a hint a duplicate
      // folded into is not double-counted.
      hinted: parsed.records.filter((r) => r.hinted).length,
      model: turn?.model ?? null,
      ms: Date.now() - t0,
      manifestUntouched: true,
      warnings,
    };
  }

  // 6. MERGE + BATTERY ----------------------------------------------------
  //
  // GEOMETRY DEMOTION, campaign flavour: the same supersede rule the staged
  // pipeline applies through reconcileLanes(prefer: isHintRecord), applied
  // here against the manifest this round merges into, because mergeProposals
  // only ever APPENDS. A hint that overlaps a non-verdicted geometry record
  // REPLACES it — the geometry record retires from the manifest and the joint
  // list, and its corroboration rides on the hint — so the battery's
  // isolation test is never handed one part in two joints. Runs at merge
  // time, never on the proposals-only path: stopping after step 5 must leave
  // the manifest provably untouched (the caller's reconcileLanes owns the
  // rule there).
  const superseded = [];
  if (parsed.records.some(isHintRecord)) {
    for (const hint of parsed.records.filter((r) => isHintRecord(r) && r.nodes?.length)) {
      let best = null;
      let bestStats = null;
      for (const m of manifest) {
        if (!m?.id || isHintRecord(m) || m.verdict != null) continue;
        if (hint.nodes.length > (m.nodes || []).length) continue;
        const s = overlapWith(m.nodes, hint.nodes);
        if (s.shared > 0 && s.containment >= OVERLAP_MERGE
          && (!bestStats || s.containment > bestStats.containment)) {
          best = m;
          bestStats = s;
        }
      }
      if (!best) continue;
      manifest.splice(manifest.indexOf(best), 1);
      const bj = (joints || []).findIndex((x) => x.id === best.id);
      if (bj >= 0) joints.splice(bj, 1);
      hint.evidence = [...(hint.evidence || []), `supersedes:${best.id}`, `cross-producer:${best.origin || 'unknown'}`];
      hint.history = [...(hint.history || []), {
        at: new Date().toISOString(), event: 'superseded',
        note: `${best.id} (${(best.nodes || []).length} nodes) demoted to corroboration — the dictionary hint's scope wins for a known-category part`,
      }];
      superseded.push({
        id: best.id, by: hint.id, origin: best.origin || null,
        shared: bestStats.shared,
        containment: Number(bestStats.containment.toFixed(2)),
      });
      warnings.push(`${hint.id} supersedes ${best.id} — the geometry record's ${(best.nodes || []).length} nodes move under the dictionary hint, whose per-part scope the battery re-measures below`);
    }
  }
  const merged = mergeProposals(g, joints, manifest, {
    records: parsed.records, confirms: parsed.confirms, confirmTag: 'l2-vision-confirm',
  });

  // THE RECOGNITION GATE (the user's dual-gate rule: listed = physics-grounded
  // AND visually named). Runs over the WHOLE manifest, not just this round's
  // additions: a confirm this round may have named an older geometry record,
  // and the gate is idempotent, so re-judging the settled records costs nothing
  // and keeps every mark consistent with the category now known.
  const recognition = applyRecognitionGate(manifest, { category: expectation?.category || null });
  for (const n of recognition.notes) warnings.push(`recognition gate: ${n}`);
  say('vision:recognition', recognition);

  say('vision:verdict', {
    added: merged.added ?? 0,
    proposals: merged.proposals || [],
    rejected: rejected.map((r) => ({ index: r.index, names: r.names })),
    superseded: superseded.map((s) => ({ id: s.id, by: s.by })),
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
    // pretending otherwise would push the model toward invention. A FORMAT
    // failure is different: it is reported as what it was, even after the retry.
    reason: merged.added || parsed.confirms.length ? null : (formatFailure || 'the model proposed nothing'),
    retried: !!retry,
    formatFailure,
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
    // The category prior and what came of it. `gaps` is recomputed AFTER the
    // merge, so it compares the guess against what the project now believes —
    // including anything geometry found before vision ever looked — while
    // `gapsAtAsk` (the beat, the persisted file) is what turn B was shown.
    // `expectationVerified` lists the instances the discovery turn already
    // pointed at, so round 2 does not spend a close-up re-answering a settled
    // question.
    expectation,
    expectationUsable: expectationIsUsable(expectation),
    gaps: expectation ? expectationGap(expectation, manifest) : null,
    expectationVerified: expectation ? verifiedInstances(expectation, parsed.grounded) : null,
    recognition,
    hinted: parsed.records.filter((r) => r.hinted).length,
    // The geometry records dictionary hints replaced at merge time, in the
    // same shape reconcileLanes reports for the staged pipeline.
    superseded,
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
  const say = typeof e.emit === 'function' ? e.emit : () => {};

  const askedRounds = Number.isFinite(e.rounds) ? Math.max(1, Math.floor(e.rounds)) : MAX_VISION_ROUNDS;
  let maxRounds = Math.min(MAX_VISION_ROUNDS, askedRounds);
  if (askedRounds > MAX_VISION_ROUNDS) warnings.push(`rounds=${askedRounds} was capped to MAX_VISION_ROUNDS=${MAX_VISION_ROUNDS}`);
  // A proposals-only campaign is ONE look by definition: round 2 exists to chase
  // round 1's doubts through the merge it just performed, and there is no merge.
  if (e.stopAfter === 'proposals') maxRounds = 1;
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
  // Round 1's category prior, kept for round 2's aim list only. It is NOT part of
  // `prev` because `prev` is a round result and this is a hypothesis about a
  // category: the two have different lifetimes and different consumers.
  let prevExpectation = null;
  let stop = null;
  let aborted = false;

  for (let r = 0; r < maxRounds; r += 1) {
    // A campaign is about ONE project. If the mesh was reloaded while it ran,
    // stop spending frames immediately: the merge at the end would write into
    // arrays that are no longer the served state, and the save would then
    // persist the NEW project's manifest while reporting the OLD campaign's
    // additions — a success message about nothing.
    if (typeof e.abort === 'function' && e.abort()) {
      stop = 'the project was reloaded while the campaign was running';
      aborted = true;
      break;
    }
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

      // THE OTHER HALF OF THE AIM LIST. The prior's UNVERIFIED places join the
      // suggestView regions, and they are added second so a place the model itself
      // asked to see again always wins the budget over a place a category says
      // should exist. Both are resolved by the same grounding channel, deduped by
      // the PARTS they resolved to rather than by box: two regions over the same
      // nodes are one close-up, and buying both would photograph the same
      // ambiguity from two nearby bearings.
      if (prevExpectation?.expectation) {
        const room2 = maxRegions - resolution.regions.length;
        if (room2 > 0) {
          const ex = regionsFromExpectations(g, prevExpectation.expectation, {
            plan: prevPlan, frames: prevFrames,
            verified: prevExpectation.verified, gaps: prevExpectation.gaps,
            maxRegions: room2, viewport,
          });
          for (const u of ex.unresolved) {
            warnings.push(`round ${r + 1}: could not aim at the ${u.type ?? 'expected'} place the category prior named — ${u.why}`);
          }
          for (const s of ex.skipped) {
            warnings.push(`round ${r + 1}: category prior region ${s.index ?? '?'} (${s.type ?? '?'}) not aimed at — ${s.why}`);
          }
          const have = new Set(resolution.regions.map((rg) => [...(rg.names || [])].sort().join('|')));
          for (const rg of ex.regions) {
            const key = [...(rg.names || [])].sort().join('|');
            if (have.has(key)) {
              warnings.push(`round ${r + 1}: the category prior pointed at the same parts as "${rg.id}" — one close-up covers both`);
              continue;
            }
            if (resolution.regions.length >= maxRegions) {
              warnings.push(`round ${r + 1}: ${rg.id} not aimed at — the ${maxRegions}-region cap was already full`);
              break;
            }
            have.add(key);
            resolution.regions.push(rg);
          }
        }
      }
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

    say('vision:round', { round: r, maxRounds });
    const res = await runVisionRound(g, joints, manifest, {
      plan: planEffect,
      capture,
      propose: e.propose || null,
      emit: e.emit || null,
      abort: e.abort || null,
      humanNotes: typeof e.humanNotes === 'function' ? e.humanNotes : null,
      // The same pictures go to every round of the campaign: a steering note that
      // arrived once is still true in round 2, and a round that dropped it would
      // be reasoning from less than the round before it.
      extraImages: Array.isArray(e.extraImages) && e.extraImages.length ? e.extraImages : null,
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
      // Round 2 aims at REGIONS, so it has no survey tier and no orientation
      // frames: every view in a close-up plan is fitted to a part, and there is no
      // whole-model pose to survey or to orient against.
      survey: r === 0 ? e.survey : 0,
      maskPairs: e.maskPairs, ghostFrames: e.ghostFrames,
      orientation: r === 0 ? e.orientation : 0,
      // Round 1 only: the prior is read from the survey tier, and round 2 has no
      // survey tier — every view in a close-up plan is fitted to one part, so
      // there is no whole-machine frame left to name a category from. `e.expectation`
      // defaults ON because a campaign is the automatic lane, where aiming is the
      // whole point; a caller may switch it off to get the single-turn round.
      expectation: r === 0 ? e.expectation !== false : false,
      // The localization turn obeys the same round-1-only rule: it reads the
      // same survey photos the prior was read from, and round 2 has none.
      localize: r === 0 ? e.localize !== false : false,
      independent: e.independent === true,
      stopAfter: e.stopAfter || null,
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
    // Only a USABLE prior aims round 2. A low-confidence or malformed guess is
    // reported and then ignored, which is what "the campaign behaves exactly as it
    // did before this lane existed" has to mean in practice: aiming a scarce
    // close-up budget at a coin flip is worse than leaving coverage to decide.
    prevExpectation = res.expectationUsable
      ? { expectation: res.expectation, verified: res.expectationVerified, gaps: res.gaps }
      : null;
  }

  const okRounds = rounds.filter((x) => x.ok);
  // A proposals-only campaign ends because it was TOLD to, not because it ran out
  // of questions. Saying so in `stop` is what keeps the diagnostics honest: without
  // it a stage-1 look reports a null stop and reads as a campaign that finished.
  if (e.stopAfter === 'proposals' && !stop) {
    stop = 'stopped after the proposals of round 1 — the caller owns the merge (stage 1 of staged discovery)';
  }
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
    // TWO meanings, told apart by `stopped`. A merged round reports the IDS it
    // added; a proposals-only round (stage 1 of staged discovery) reports the
    // RECORD OBJECTS it parsed, because the merge that would have admitted them
    // never ran and the caller owns it. Reading this field without checking
    // `stopped` first is the one mistake this shape permits.
    proposals: okRounds.flatMap((x) => x.proposals || []),
    // The proposals-only seam stops BEFORE the merge, so its corroboration is a
    // DELTA THE CALLER OWNS: `confirms` alone is a count, and a count cannot be
    // routed through reconcileLanes. `stopped` travels for the same reason — it is
    // how a caller tells "looked and merged nothing" from "looked and was told not
    // to merge", which are opposite instructions for what to do next.
    confirmList: okRounds.flatMap((x) => x.confirmList || []),
    stopped: last?.stopped ?? null,
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
    // The category prior from round 1 and what became of it. `gaps` is recomputed
    // here, after EVERY round merged, so the readout compares the guess against
    // the project's final belief rather than against its belief mid-campaign —
    // which is the only comparison a human can act on. Null when the lane was off,
    // the model declined to answer, or the campaign never reached round 1.
    expectation: rounds[0]?.expectation ?? null,
    expectationUsable: rounds[0]?.expectationUsable ?? false,
    gaps: rounds[0]?.expectation ? expectationGap(rounds[0].expectation, manifest) : null,
    model: last?.model ?? null,
    ms: sum('ms'),
    reason: added || confirms ? null : (stop || last?.reason || 'the model proposed nothing'),
    code: aborted ? 'PROJECT_RELOADED' : (failed?.code ?? null),
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

  // The parsed mesh is the only authority on which node names exist. Handing
  // its name set to applyVerdict is what turns a typo (or a hallucinated name)
  // in an edit into a refusal instead of a silently empty drive set.
  const knownNodes = g && g.names instanceof Set ? g.names
    : (Array.isArray(g?.nodes) ? new Set(g.nodes.map((n) => n.name)) : null);
  const r = applyVerdict(rec, { decision, edits, note, actor, amortizedFrom, knownNodes });
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

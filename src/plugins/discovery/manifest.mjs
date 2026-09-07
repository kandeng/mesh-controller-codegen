// Manifest — the explicit per-joint state record for the discovery loop.
// A joint stops being a transient function return and becomes a RECORD with
// evidence, confidence, test results, and a lifecycle status. The manifest is
// persisted into the run dir so a run is resumable after restart.
//
// Status lifecycle (extends motion-spec's candidate|confirmed|generated|verified):
//   candidate       — produced by an L-producer, not yet tested
//   auto-accepted   — deterministic tests passed AND confidence >= 0.8
//   needs-verdict   — tests failed/warned, or confidence too low to auto-accept
//   confirmed       — a HUMAN accepted it (phase 3, task 17)
//   rejected        — a HUMAN rejected it; its nodes are freed for re-proposal
// Immutability means "the LLM can't mutate records", not "reality can't
// falsify them": a later hard test (rigidity gate) reopens a record via
// reopen() and the status regresses with the failing evidence attached.
//
// The two human statuses are terminal against the MACHINE and not terminal
// against REALITY. deriveStatus() will not walk `confirmed` back down to
// `needs-verdict` because some later battery run scored the confidence lower —
// that would make the verdict button a no-op the moment anything else touched
// the record, and the human would have no way to tell. reopen() is the one thing
// that can clear a verdict, because it means a physical test contradicted it.
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const AUTO_ACCEPT_CONFIDENCE = 0.8;

// The three things a human may do to a record. `edit` counts as a verdict rather
// than being a separate endpoint because it is one: "your membership was wrong,
// here is the right one" is a judgement about the claim, not a new claim, and it
// belongs in the same audit trail as accept/reject.
export const VERDICTS = new Set(['accept', 'reject', 'edit']);

// What an `edit` verdict may change. A whitelist rather than an object spread,
// because the alternative lets a verdict rewrite `status`, `confidence`, `tests`
// or `history` — precisely the fields that make a record auditable. Anything off
// the list is REFUSED and reported, never silently dropped: a human who asked
// for a change and got none has to be told, or the panel shows an edit that did
// not happen.
const EDITABLE = new Set(['label', 'type', 'nodes', 'anchor', 'axis']);
const JOINT_TYPES = new Set(['rotor', 'gimbal', 'hinge']);

// The warn-level marker an edit leaves behind, and the flag that goes with it.
// Both exist because they answer different questions: the test entry is what the
// UI shows when a record sits at needs-verdict for no test-related reason, while
// `retestNeeded` is the one bit of state deriveStatus reads. Deriving the flag
// from the presence of the test entry would mean a re-run battery that merely
// APPENDS (runBattery pushes, it never replaces) could never clear it.
export const STALE_BATTERY = 'verdict-edit-stale';

const vec3ish = (v) => !!v && typeof v === 'object' && ['x', 'y', 'z'].every((k) => Number.isFinite(v[k]));

// Returns null when the edit is acceptable, else the reason it is not. Kept as a
// function of one field so `applyVerdict` can report every refusal at once
// instead of stopping at the first — same shape as the kernel's `unmet` list.
function checkEdit(field, value) {
  if (!EDITABLE.has(field)) return `not an editable field (allowed: ${[...EDITABLE].join(', ')})`;
  if (field === 'label') return typeof value === 'string' && value.trim() ? null : 'must be a non-empty string';
  if (field === 'type') return JOINT_TYPES.has(value) ? null : `must be one of ${[...JOINT_TYPES].join(' / ')}`;
  if (field === 'nodes') {
    if (!Array.isArray(value) || !value.length) return 'must be a non-empty array of node names';
    const bad = value.filter((n) => typeof n !== 'string' || !n.trim());
    return bad.length ? `${bad.length} entry/entries are not non-empty strings` : null;
  }
  return vec3ish(value) ? null : 'must be {x,y,z} of finite numbers';
}

export function buildManifest(joints) {
  return (joints || []).map((j) => ({
    id: j.id,
    label: j.label,
    type: j.type,
    nodes: [...(j.nodes || [])],
    anchor: j.anchor || null,
    axis: j.axis || null,
    evidence: [...(j.evidence || [])],
    confidence: j.confidence ?? 0,
    origin: 'L1-geometry', // L2 merge stamps 'L2-ai'
    tests: [], // [{ name, pass, level: 'fail'|'warn', detail }]
    status: 'candidate',
    // { decision, at, actor, note, amortizedFrom } once a human has spoken; null
    // until then. `amortizedFrom` is set only on a peer that inherited a verdict
    // laterally (see symmetry.mjs), so a record can always say whether its green
    // chip came from a human looking at THIS joint or at its mirror.
    verdict: null,
    retestNeeded: false,
    history: [], // [{ at, event, ... }] — reopen/verdict audit trail
  }));
}

// The loop owns status transitions — producers never touch this.
export function deriveStatus(rec) {
  const d = rec.verdict?.decision;
  if (d === 'accept') return 'confirmed';
  if (d === 'reject') return 'rejected';
  // An edit changed the node set, so every test still on the record measured a
  // joint that no longer exists. Letting the old score stand would report
  // `auto-accepted` for the NEW membership on the strength of the old one's
  // evidence, which is the one thing this whole file is arranged to prevent.
  if (d === 'edit' && rec.retestNeeded) return 'needs-verdict';
  const hardFail = (rec.tests || []).some((t) => t.level !== 'warn' && !t.pass);
  if (!hardFail && rec.confidence >= AUTO_ACCEPT_CONFIDENCE) return 'auto-accepted';
  return 'needs-verdict';
}

// Reopen edge: a later hard test (e.g. the rigidity gate) falsified this
// record's membership. Regress to needs-verdict with the failing evidence
// attached; evidence/confidence are retained (the evidence was right — the
// membership was wrong).
export function reopen(rec, failingTest, note = null) {
  const superseded = rec.verdict?.decision || null;
  rec.tests.push({ level: 'fail', ...failingTest, pass: false });
  // A human verdict does not survive a physical contradiction. Keeping it would
  // make deriveStatus immediately re-derive `confirmed`, so the record would
  // carry a failing test AND a green chip, and the reopen would be invisible.
  // The superseded decision is kept in history — that it was a human who was
  // wrong is exactly what a later reader needs to know.
  if (superseded) rec.verdict = null;
  rec.status = 'needs-verdict';
  rec.history.push({
    at: new Date().toISOString(), event: 'reopened', test: failingTest.name, note,
    ...(superseded ? { supersededVerdict: superseded } : {}),
  });
  return rec;
}

// The human verdict edge — the counterpart to reopen(). Where reopen() is
// reality contradicting a record, this is a person disposing of one, and it is
// the only route to `confirmed` or `rejected`.
//
// Idempotent by construction: a second verdict overwrites `rec.verdict` and
// appends to history, so reversing a decision leaves both decisions on the trail
// rather than quietly pretending the first never happened.
//
// opts: { decision:'accept'|'reject'|'edit', edits, note, actor, amortizedFrom, at }
// Returns { ok:false, code, error } on a refusal WITHOUT touching the record, so
// a bad request can never leave a half-edited joint behind.
export function applyVerdict(rec, {
  decision, edits = null, note = null, actor = 'human', amortizedFrom = null, at = null,
} = {}) {
  if (!rec) return { ok: false, code: 'NO_RECORD', error: 'no such record' };
  if (!VERDICTS.has(decision)) {
    return {
      ok: false, code: 'BAD_VERDICT',
      error: `verdict must be one of ${[...VERDICTS].join(' / ')}, got "${decision}"`,
    };
  }
  const wantEdits = decision === 'edit';
  if (wantEdits && !(edits && typeof edits === 'object' && Object.keys(edits).length)) {
    return { ok: false, code: 'NO_EDITS', error: 'an edit verdict needs at least one field to change' };
  }

  const applied = [];
  const refused = [];
  if (wantEdits) {
    for (const [field, value] of Object.entries(edits)) {
      const why = checkEdit(field, value);
      if (why) { refused.push({ field, why }); continue; }
      rec[field] = field === 'nodes' ? [...new Set(value.map((n) => String(n).trim()))]
        : field === 'label' ? String(value).trim()
          : field === 'type' ? value
            : { x: value.x, y: value.y, z: value.z };
      applied.push(field);
    }
    // Refuse the whole verdict rather than accept a partial one: a human who
    // asked to move the anchor AND retype the joint, and got only the anchor,
    // has a record that matches neither their intent nor the model's claim.
    if (!applied.length) {
      return {
        ok: false, code: 'NO_EDITS', refused,
        error: `nothing in { ${Object.keys(edits).join(', ')} } could be applied`,
      };
    }
    rec.retestNeeded = true;
    rec.tests.push({
      name: STALE_BATTERY, level: 'warn', pass: false,
      // Worded as "before the edit" rather than "against the previous node set",
      // because a label-only edit leaves the node set exactly as it was and the
      // stronger claim would be false on the record a human is reading. What is
      // always true is that the battery has not seen the corrected record.
      detail: `a human edit changed ${applied.join(', ')}; the tests above were run before it`,
    });
  }

  const stamp = at || new Date().toISOString();
  rec.verdict = {
    decision,
    at: stamp,
    actor: String(actor || 'human'),
    note: note == null ? null : String(note).slice(0, 400),
    amortizedFrom: amortizedFrom == null ? null : String(amortizedFrom),
  };
  rec.status = deriveStatus(rec);
  rec.history.push({
    at: stamp, event: 'verdict', decision, actor: rec.verdict.actor,
    ...(applied.length ? { edited: applied } : {}),
    ...(refused.length ? { refused } : {}),
    ...(rec.verdict.note ? { note: rec.verdict.note } : {}),
    ...(amortizedFrom ? { amortizedFrom: String(amortizedFrom) } : {}),
  });
  return {
    ok: true, rec, decision, status: rec.status, applied, refused,
    retestNeeded: !!rec.retestNeeded,
  };
}

// Clear the stale-battery marker an `edit` verdict leaves behind, once the
// deterministic battery has actually been re-run against the edited node set.
// Without this the record would sit at needs-verdict forever, which reads as
// "the edit was ignored" rather than "the edit was acted on".
export function retireStaleEdit(rec) {
  if (!rec || !rec.retestNeeded) return rec;
  rec.retestNeeded = false;
  rec.tests = (rec.tests || []).filter((t) => t.name !== STALE_BATTERY);
  rec.status = deriveStatus(rec);
  return rec;
}

// Node ids claimed by every non-rejected record. 'rejected' was already skipped
// here before phase 3, as a forward declaration of a status nothing set; task 17
// is what makes it reachable, so a human rejection is what actually returns a
// part to the pool. L2 proposals may not claim these except via a split of the
// claiming record.
export function claimedNodeSet(manifest) {
  const s = new Set();
  for (const rec of manifest || []) {
    if (rec.status === 'rejected') continue;
    for (const n of rec.nodes || []) s.add(n);
  }
  return s;
}

// Validated records compressed into one-line pruning facts for the L2 prompt:
// they actively subtract from the search space instead of just informing it.
const fmt3 = (v) => (v ? `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})` : '?');
export function constraintSummary(manifest) {
  return (manifest || [])
    // `confirmed` joins `auto-accepted` here, and it has to: a human-confirmed
    // record's nodes are claimed at least as firmly as an auto-accepted one's, so
    // leaving it out would make the act of confirming a joint hand its parts back
    // to the next proposal round as free real estate.
    .filter((rec) => rec.status === 'auto-accepted' || rec.status === 'confirmed')
    .map((rec) => {
      // WHY it is accepted is part of the fact, because it tells the producer what
      // kind of challenge is pointless: nothing it says can outvote a human, while
      // an auto-accept is only as strong as the tests behind it.
      const how = rec.status === 'confirmed'
        ? `HUMAN VERDICT${rec.verdict?.amortizedFrom ? ` amortized from ${rec.verdict.amortizedFrom}` : ''}`
        : `auto, conf ${(rec.confidence ?? 0).toFixed(2)}`;
      return `${rec.id}: ${String(rec.type).toUpperCase()} anchor=${fmt3(rec.anchor)} axis=${fmt3(rec.axis)} — ACCEPTED(${how}); nodes [${rec.nodes.join(', ')}] claimed — do not re-propose`;
    });
}

// Write the manifest into the run dir (resumable state, per the recorded
// hybrid-workflow decision). Plain JSON — no joint object references.
export function saveManifest(runDir, manifest) {
  if (!runDir) return null;
  const file = resolve(runDir, 'manifest.json');
  writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), joints: manifest }, null, 2));
  return file;
}

// ---- phase 3, task 19: revision snapshots -----------------------------------
//
// The manifest is the JUSTIFICATION axis — a graph of records, evidence and
// verdicts. A revision snapshot is the TIME axis: `manifest.r<N>.json` freezes
// the whole graph as it stood at the end of one loop round, and `parent` points
// at the revision it descends from. Parent is usually N-1, but it does not have
// to be: re-running a round from an earlier state makes a BRANCH, which is the
// one thing a flat overwrite (saveManifest) cannot express and the reason this
// is a snapshot chain rather than a single mutable file.
//
// This is deliberately NOT a graph framework and NOT a VCS. It is numbered files
// plus a structural diff, because the only questions anyone asks are "what did
// round N change?" and "what did the graph look like before I rejected that
// rotor?" — and a diff over two JSON snapshots answers both with no machinery.

// The next free revision number: one past the highest `manifest.r<N>.json`
// already on disk, or 0 for a fresh run. Scanned rather than counted so a
// partially deleted history cannot collide.
export function nextRevision(runDir) {
  if (!runDir || !existsSync(runDir)) return 0;
  let max = -1;
  for (const f of readdirSync(runDir)) {
    const m = f.match(/^manifest\.r(\d+)\.json$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// The highest revision on disk, or null when there are none. `parent` defaults
// to this, so a snapshot taken without naming a parent continues the trunk.
export function latestRevision(runDir) {
  const n = nextRevision(runDir);
  return n === 0 ? null : n - 1;
}

// Freeze the current manifest as revision N. Returns { file, revision, parent }
// or null with no runDir. The payload carries {round, parent, ts} per the plan,
// plus `note` (what the round was) and a `counts` summary so a listing can show
// the shape of a revision without loading every record.
export function saveRevision(runDir, manifest, {
  round = null, parent = null, note = null, at = null,
} = {}) {
  if (!runDir) return null;
  const revision = Number.isFinite(round) ? round : nextRevision(runDir);
  const list = manifest || [];
  const par = Number.isFinite(parent) ? parent : latestRevision(runDir);
  const file = resolve(runDir, `manifest.r${revision}.json`);
  const counts = list.reduce((acc, r) => {
    acc.total += 1;
    acc.byStatus[r.status] = (acc.byStatus[r.status] || 0) + 1;
    return acc;
  }, { total: 0, byStatus: {} });
  writeFileSync(file, JSON.stringify({
    revision,
    round: Number.isFinite(round) ? round : revision,
    parent: par,
    ts: at || new Date().toISOString(),
    note: note == null ? null : String(note).slice(0, 400),
    counts,
    joints: list,
  }, null, 2));
  return { file, revision, parent: par };
}

// Metadata for every revision on disk, oldest first, WITHOUT the records — a
// listing endpoint should not ship the whole graph N times. `exists` mirrors the
// count so a caller can tell an empty revision from a missing one.
export function listRevisions(runDir) {
  if (!runDir || !existsSync(runDir)) return [];
  const out = [];
  for (const f of readdirSync(runDir)) {
    const m = f.match(/^manifest\.r(\d+)\.json$/);
    if (!m) continue;
    try {
      const rev = JSON.parse(readFileSync(resolve(runDir, f), 'utf8'));
      out.push({
        revision: rev.revision ?? Number(m[1]),
        round: rev.round ?? Number(m[1]),
        parent: rev.parent ?? null,
        ts: rev.ts ?? null,
        note: rev.note ?? null,
        counts: rev.counts ?? { total: (rev.joints || []).length, byStatus: {} },
      });
    } catch { /* a truncated snapshot is skipped, not fatal to the listing */ }
  }
  return out.sort((a, b) => a.revision - b.revision);
}

// One full revision (records included), or null. `n` defaults to the latest.
export function loadRevision(runDir, n = null) {
  if (!runDir || !existsSync(runDir)) return null;
  const rev = Number.isFinite(n) ? n : latestRevision(runDir);
  if (rev == null) return null;
  const file = resolve(runDir, `manifest.r${rev}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Structural equality for the small values a record carries (scalars, and the
// shallow objects like a motion summary). JSON compare is fine here: these are
// plain data with no key-order guarantee to worry about at this size.
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The fields of a record worth reporting when they move. A whitelist rather than
// a whole-object walk, because `history` and `tests` are append-only audit trails
// that change on almost every round — diffing them would bury the one field a
// reader cares about (a status flip, a verdict, a node moved) under noise.
const DIFF_FIELDS = ['status', 'confidence', 'type', 'label', 'origin', 'retestNeeded'];

// What changed between two manifests, by record id. Returns
//   { added, removed, changed, counts }
// where `changed` carries a per-field {from,to} for scalars, a set-diff for
// nodes, and the decision/assessment for verdict/motion — the three things a
// loop round actually moves. Pure: no disk, so it is testable against two
// literals and reusable by both the diff endpoint and the shell proof.
export function diffManifests(before, after) {
  const bById = new Map((before || []).map((r) => [r.id, r]));
  const aById = new Map((after || []).map((r) => [r.id, r]));

  const added = [...aById.keys()].filter((id) => !bById.has(id))
    .map((id) => ({ id, type: aById.get(id).type ?? null, status: aById.get(id).status ?? null }));
  const removed = [...bById.keys()].filter((id) => !aById.has(id))
    .map((id) => ({ id, type: bById.get(id).type ?? null, status: bById.get(id).status ?? null }));

  const changed = [];
  for (const [id, a] of aById) {
    const b = bById.get(id);
    if (!b) continue;
    const changes = {};
    for (const f of DIFF_FIELDS) {
      if (!sameValue(b[f], a[f])) changes[f] = { from: b[f] ?? null, to: a[f] ?? null };
    }
    const bv = b.verdict?.decision ?? null;
    const av = a.verdict?.decision ?? null;
    if (bv !== av) changes.verdict = { from: bv, to: av };

    const bn = new Set(b.nodes || []);
    const an = new Set(a.nodes || []);
    const nodesAdded = [...an].filter((nm) => !bn.has(nm));
    const nodesRemoved = [...bn].filter((nm) => !an.has(nm));
    if (nodesAdded.length || nodesRemoved.length) changes.nodes = { added: nodesAdded, removed: nodesRemoved };

    // Motion is summarised, not deep-diffed: the frames/reasoning are prose that
    // changes wholesale each round, and the only part a reader scans is what the
    // model concluded.
    const bm = b.motion ? { observedType: b.motion.observedType ?? null, motionSensible: b.motion.motionSensible ?? null } : null;
    const am = a.motion ? { observedType: a.motion.observedType ?? null, motionSensible: a.motion.motionSensible ?? null } : null;
    if (!sameValue(bm, am)) changes.motion = { from: bm, to: am };

    if (Object.keys(changes).length) changed.push({ id, changes });
  }

  return {
    added, removed, changed,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
  };
}

// Copy derived status + test results back onto the served joint objects so
// jointSummary (and the step-3 UI) see them without a second lookup.
export function applyManifest(joints, manifest) {
  const byId = new Map(manifest.map((r) => [r.id, r]));
  for (const j of joints || []) {
    const r = byId.get(j.id);
    if (!r) continue;
    j.status = r.status;
    j.tests = r.tests;
    // Assigned unconditionally, null included: reopen() CLEARS a verdict, and a
    // conditional copy would leave the superseded one sitting on the joint, so
    // the chip would read `confirmed` next to a failing test.
    j.verdict = r.verdict || null;
    if (!j.evidence) j.evidence = r.evidence;
    if (j.confidence == null) j.confidence = r.confidence;
  }
  return joints;
}

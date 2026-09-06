// Manifest — the explicit per-joint state record for the discovery loop.
// A joint stops being a transient function return and becomes a RECORD with
// evidence, confidence, test results, and a lifecycle status. The manifest is
// persisted into the run dir so a run is resumable after restart.
//
// Status lifecycle (extends motion-spec's candidate|confirmed|generated|verified):
//   candidate       — produced by an L-producer, not yet tested
//   auto-accepted   — deterministic tests passed AND confidence >= 0.8
//   needs-verdict   — tests failed/warned, or confidence too low to auto-accept
// Immutability means "the LLM can't mutate records", not "reality can't
// falsify them": a later hard test (rigidity gate) reopens a record via
// reopen() and the status regresses with the failing evidence attached.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const AUTO_ACCEPT_CONFIDENCE = 0.8;

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
    history: [], // [{ at, event, ... }] — reopen/verdict audit trail
  }));
}

// The loop owns status transitions — producers never touch this.
export function deriveStatus(rec) {
  const hardFail = rec.tests.some((t) => t.level !== 'warn' && !t.pass);
  if (!hardFail && rec.confidence >= AUTO_ACCEPT_CONFIDENCE) return 'auto-accepted';
  return 'needs-verdict';
}

// Reopen edge: a later hard test (e.g. the rigidity gate) falsified this
// record's membership. Regress to needs-verdict with the failing evidence
// attached; evidence/confidence are retained (the evidence was right — the
// membership was wrong).
export function reopen(rec, failingTest, note = null) {
  rec.tests.push({ level: 'fail', ...failingTest, pass: false });
  rec.status = 'needs-verdict';
  rec.history.push({ at: new Date().toISOString(), event: 'reopened', test: failingTest.name, note });
  return rec;
}

// Node ids claimed by every non-rejected record (phase 3 adds 'rejected').
// L2 proposals may not claim these except via a split of the claiming record.
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
    .filter((rec) => rec.status === 'auto-accepted')
    .map((rec) => `${rec.id}: ${String(rec.type).toUpperCase()} anchor=${fmt3(rec.anchor)} axis=${fmt3(rec.axis)} — ACCEPTED(auto, conf ${rec.confidence.toFixed(2)}); nodes [${rec.nodes.join(', ')}] claimed — do not re-propose`);
}

// Write the manifest into the run dir (resumable state, per the recorded
// hybrid-workflow decision). Plain JSON — no joint object references.
export function saveManifest(runDir, manifest) {
  if (!runDir) return null;
  const file = resolve(runDir, 'manifest.json');
  writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), joints: manifest }, null, 2));
  return file;
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
    if (!j.evidence) j.evidence = r.evidence;
    if (j.confidence == null) j.confidence = r.confidence;
  }
  return joints;
}

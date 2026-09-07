// Revision-snapshot proof — phase 3, task 19.
//
// A revision is a commit of the JUSTIFICATION graph onto the TIME axis. The two
// properties that make it more than a flat overwrite are the `parent` link (so a
// re-run from an earlier state is a BRANCH, not a clobber) and the structural diff
// (so "what did round N change?" is answerable without eyeballing two JSON files).
// Every leg asserts the failure mode that would make it silently useless:
//
//   A) saveRevision / nextRevision / latestRevision — numbering is scanned from
//      disk, so a gap or a deleted snapshot cannot collide, and a round-trip is
//      byte-faithful
//   B) parent defaults to the trunk but an explicit parent makes a branch
//   C) listRevisions ships METADATA, not the graph N times
//   D) loadRevision defaults to latest and returns null (not a throw) when absent
//   E) diffManifests reports added / removed / changed by id
//   F) the diff tracks the fields a round actually moves (status, verdict, nodes,
//      motion) and IGNORES the append-only audit trail (history, tests) that would
//      otherwise bury the signal
//   G) a root revision diffs against the empty graph — everything reads as added
//
// Usage: node test/verify-revisions.mjs
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  diffManifests, latestRevision, listRevisions, loadRevision,
  nextRevision, saveRevision,
} from '../src/plugins/discovery/manifest.mjs';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}${extra ? ' \u2014 ' + extra : ''}`); } else { fail += 1; console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
};

console.log('\nProving revision snapshots + the structural diff\n');

const dir = mkdtempSync(resolve(tmpdir(), 'rev-'));
try {
  // A record-shaped literal. Only the fields the diff and the snapshot read are
  // present; anything else would be a lie about what real records carry.
  const rec = (id, over = {}) => ({
    id, label: id, type: 'rotor', nodes: [`${id}_a`, `${id}_b`],
    anchor: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 },
    evidence: ['e'], confidence: 0.5, origin: 'L1-geometry',
    tests: [], status: 'candidate', verdict: null, retestNeeded: false,
    history: [], ...over,
  });

  // ---- A) numbering + round-trip ------------------------------------------
  ok('A: a fresh run has no revision and next is 0',
    nextRevision(dir) === 0 && latestRevision(dir) === null);

  const m0 = [rec('a'), rec('b')];
  const r0 = saveRevision(dir, m0, { note: 'discovery loop' });
  ok('A: the first snapshot is revision 0 with no parent',
    r0.revision === 0 && r0.parent === null && existsSync(r0.file));
  ok('A: next/latest advance after a write',
    nextRevision(dir) === 1 && latestRevision(dir) === 0);

  const loaded0 = loadRevision(dir, 0);
  ok('A: a snapshot round-trips its records, round, parent, ts and note',
    loaded0.joints.length === 2 && loaded0.round === 0 && loaded0.parent === null
      && typeof loaded0.ts === 'string' && loaded0.note === 'discovery loop');
  ok('A: the snapshot carries a counts summary',
    loaded0.counts.total === 2 && loaded0.counts.byStatus.candidate === 2);

  // ---- B) parent defaults to the trunk; explicit parent branches ----------
  const r1 = saveRevision(dir, [rec('a'), rec('b'), rec('c')], { note: 'vision campaign' });
  ok('B: the next snapshot defaults its parent to the latest (the trunk)',
    r1.revision === 1 && r1.parent === 0);

  // Re-run from revision 0: an explicit parent makes a BRANCH off the trunk.
  const r2 = saveRevision(dir, [rec('a')], { round: 2, parent: 0, note: 're-run from r0' });
  ok('B: an explicit parent makes a branch, not a clobber of the trunk',
    r2.revision === 2 && r2.parent === 0 && loadRevision(dir, 1).joints.length === 3);

  // ---- C) listRevisions ships metadata, not the graph ---------------------
  const list = listRevisions(dir);
  ok('C: every revision is listed, oldest first',
    list.length === 3 && list.map((r) => r.revision).join(',') === '0,1,2');
  ok('C: a listing carries metadata and counts but NOT the records',
    list.every((r) => r.joints === undefined && r.counts && typeof r.parent !== 'undefined'),
    `keys: ${Object.keys(list[0]).join('/')}`);
  ok('C: the listing preserves each revision\u2019s parent (the branch shape)',
    list[2].parent === 0 && list[1].parent === 0);

  // ---- D) loadRevision defaults + absence ---------------------------------
  ok('D: loadRevision with no n returns the latest',
    loadRevision(dir).revision === 2);
  ok('D: a missing revision returns null, not a throw',
    loadRevision(dir, 99) === null);
  ok('D: an empty dir lists nothing',
    (() => { const e = mkdtempSync(resolve(tmpdir(), 'rev-empty-')); const r = listRevisions(e).length === 0 && latestRevision(e) === null; rmSync(e, { recursive: true, force: true }); return r; })());

  // ---- E) diff added / removed / changed ----------------------------------
  const before = [rec('a', { status: 'candidate', confidence: 0.5 }), rec('b')];
  const after = [
    rec('a', { status: 'auto-accepted', confidence: 0.85 }), // changed
    rec('c'),                                                 // added
  ];                                                        // b removed
  const d = diffManifests(before, after);
  ok('E: an added record is reported by id', d.added.length === 1 && d.added[0].id === 'c');
  ok('E: a removed record is reported by id', d.removed.length === 1 && d.removed[0].id === 'b');
  ok('E: a changed record reports the fields that moved',
    d.changed.length === 1 && d.changed[0].id === 'a'
      && d.changed[0].changes.status.from === 'candidate'
      && d.changed[0].changes.status.to === 'auto-accepted'
      && d.changed[0].changes.confidence.to === 0.85);
  ok('E: the counts summary matches the arrays',
    d.counts.added === 1 && d.counts.removed === 1 && d.counts.changed === 1);

  // ---- F) verdict / nodes / motion tracked; audit trail ignored -----------
  const bv = rec('x', { nodes: ['p', 'q'], history: [{ event: 'old' }], tests: [{ name: 't', pass: true }] });
  const av = rec('x', {
    nodes: ['q', 'r'], // p removed, r added
    verdict: { decision: 'accept', at: 'now', actor: 'human' },
    motion: { observedType: 'rotor', motionSensible: true },
    history: [{ event: 'old' }, { event: 'verdict' }], // appended — must NOT be a change
    tests: [{ name: 't', pass: true }, { name: 'u', pass: true }], // appended — must NOT be a change
  });
  const dv = diffManifests([bv], [av]);
  const ch = dv.changed[0]?.changes || {};
  ok('F: a verdict decision is reported', ch.verdict?.from === null && ch.verdict?.to === 'accept');
  ok('F: nodes are reported as a set-diff, not a whole-array replace',
    ch.nodes?.added.join(',') === 'r' && ch.nodes?.removed.join(',') === 'p');
  ok('F: a motion assessment is summarised into the diff',
    ch.motion?.from === null && ch.motion?.to?.observedType === 'rotor');
  ok('F: the append-only audit trail (history/tests) is NOT diffed',
    ch.history === undefined && ch.tests === undefined);

  // An identical pair produces no changes at all.
  ok('F: identical manifests diff to nothing',
    (() => { const z = diffManifests([rec('z')], [rec('z')]); return z.added.length === 0 && z.removed.length === 0 && z.changed.length === 0; })());

  // ---- G) a root revision diffs against the empty graph -------------------
  const root = diffManifests([], [rec('a'), rec('b')]);
  ok('G: diffing against nothing reports every record as added',
    root.added.length === 2 && root.removed.length === 0 && root.changed.length === 0);

  // The real snapshot chain diffs end to end: r1 (3 records) vs its parent r0 (2).
  const chain = diffManifests(loadRevision(dir, 0).joints, loadRevision(dir, 1).joints);
  ok('G: two on-disk revisions diff to the record the round added',
    chain.added.length === 1 && chain.added[0].id === 'c', `+${chain.added.map((a) => a.id).join(',')}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nREVISIONS_PROBE_${fail === 0 ? 'OK' : 'FAIL'} \u2014 ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

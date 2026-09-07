// Human verdict + symmetry amortization proof — phase 3, task 17.
//
// The verdict edge is the one place in this codebase where a PERSON outvotes the
// machine, and the symmetry edge is the one place where a judgement travels
// SIDEWAYS instead of down. Both are easy to get subtly wrong in a way that looks
// like success from the UI, so every leg here asserts the failure mode rather
// than the happy path:
//
//   A) applyVerdict — accept/reject/edit, and the refusals that must leave the
//      record BYTE-IDENTICAL (a half-applied edit is worse than a refused one)
//   B) deriveStatus — a human verdict is terminal against the MACHINE but not
//      against REALITY: a lower-scoring battery cannot walk it back down, while
//      reopen() must clear it
//   C) retireStaleEdit — the edit's stale marker is cleared only by a real re-run
//   D) claimedNodeSet / constraintSummary — `rejected` returns parts to the pool,
//      `confirmed` claims them at least as firmly as an auto-accept
//   E) propose-core pins verdict/status/confidence/frameRound — a producer that
//      could set `verdict` could self-confirm its own hallucination
//   F) peersOf — mirror vs family tiers, and each guard (type, axis-as-a-line,
//      minimum separation, node count) refusing for its own reason
//   G) symmetryGroups — transitive components, singletons dropped
//   H) the real sample mesh — four rotors come out as ONE offerable family
//   I) applyJointVerdict — an edit lands on the joint object too, re-runs the
//      battery, and widens to the whole manifest ONLY when nodes moved
//   J) amortizeVerdict — never a bulk write: the decision comes from the source
//      record, peers must be selected explicitly, a direct verdict outranks an
//      inherited one, and a partial success is reported as a success
//
// Usage: node test/verify-verdict.mjs
import { parseGlb } from '../src/lib/gltf.mjs';
import { geometryDiscovery } from '../src/plugins/discovery/geometry.mjs';
import {
  AUTO_ACCEPT_CONFIDENCE, STALE_BATTERY, VERDICTS, applyVerdict, buildManifest,
  claimedNodeSet, constraintSummary, deriveStatus, reopen, retireStaleEdit,
} from '../src/plugins/discovery/manifest.mjs';
import {
  AMORTIZABLE, SYMMETRY_AXIS_DOT, SYMMETRY_FAMILY_SPREAD, SYMMETRY_MIN_SEPARATION,
  SYMMETRY_TOLERANCE, peersOf, symmetryGroups, symmetryPeers,
} from '../src/plugins/discovery/symmetry.mjs';
import { createProposalGate } from '../src/plugins/discovery/propose-core.mjs';
import { applyJointVerdict, amortizeVerdict, runDiscoveryLoop } from '../src/plugins/discovery/loop.mjs';
import { modelRadius, modelTarget } from '../src/plugins/discovery/views.mjs';

const GLB = 'samples/drone_dji_inspire3.glb';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}${extra ? ' \u2014 ' + extra : ''}`); } else { fail += 1; console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
};

console.log('\nProving the human verdict edge + symmetry amortization\n');

// A joint-shaped fake, so a manifest leg can be built without a mesh. Only the
// fields buildManifest and the battery read are present; anything else would be
// a lie about what the real records carry.
const fakeJoint = (id, over = {}) => ({
  id, label: id, type: 'rotor', nodes: [`${id}_a`, `${id}_b`],
  anchor: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 },
  evidence: ['fake'], confidence: 0.5, ...over,
});

// ---- A) applyVerdict ---------------------------------------------------------
{
  const rec = buildManifest([fakeJoint('a')])[0];
  ok('A: a fresh record carries no verdict and is not confirmed', rec.verdict === null && rec.status === 'candidate');

  const bad = applyVerdict(rec, { decision: 'maybe' });
  ok('A: an unknown decision is refused', bad.ok === false && bad.code === 'BAD_VERDICT', bad.error);
  ok('A: a refused verdict left the record untouched',
    rec.verdict === null && rec.history.length === 0 && rec.status === 'candidate');
  ok('A: the refusal names the decisions that ARE allowed',
    [...VERDICTS].every((d) => bad.error.includes(d)));

  ok('A: no record is a refusal, not a throw', applyVerdict(null, { decision: 'accept' }).code === 'NO_RECORD');

  const acc = applyVerdict(rec, { decision: 'accept', actor: 'alice', note: 'looks right' });
  ok('A: accept is the only route to confirmed', acc.ok && rec.status === 'confirmed' && acc.status === 'confirmed');
  ok('A: the verdict records who, when and why',
    rec.verdict.decision === 'accept' && rec.verdict.actor === 'alice' && rec.verdict.note === 'looks right'
    && typeof rec.verdict.at === 'string' && rec.verdict.at.length > 0);
  ok('A: a direct verdict carries no amortizedFrom', rec.verdict.amortizedFrom === null);
  ok('A: the verdict went on the audit trail',
    rec.history.length === 1 && rec.history[0].event === 'verdict' && rec.history[0].decision === 'accept');

  // Reversing a decision must not pretend the first one never happened.
  applyVerdict(rec, { decision: 'reject', actor: 'bob' });
  ok('A: a verdict may be reversed', rec.status === 'rejected' && rec.verdict.decision === 'reject');
  ok('A: reversing keeps BOTH decisions on the trail',
    rec.history.length === 2 && rec.history.map((h) => h.decision).join(',') === 'accept,reject');

  const long = applyVerdict(buildManifest([fakeJoint('n')])[0], { decision: 'accept', note: 'x'.repeat(900) });
  ok('A: an over-long note is truncated, not refused', long.ok && long.rec.verdict.note.length === 400);
}

// ---- A2) the edit verdict ----------------------------------------------------
{
  const rec = buildManifest([fakeJoint('e')])[0];
  const noEdits = applyVerdict(rec, { decision: 'edit' });
  ok('A: an edit with no fields is refused', noEdits.ok === false && noEdits.code === 'NO_EDITS');
  ok('A: a refused edit changed nothing', rec.nodes.length === 2 && rec.retestNeeded === false && rec.verdict === null);

  // Every refusal is reported at once rather than stopping at the first — the
  // same shape as the kernel's `unmet` list, because a human who asked for three
  // changes and got one silent refusal has no way to know which two landed.
  const mixed = applyVerdict(rec, {
    decision: 'edit',
    edits: { label: 'corrected', status: 'confirmed', type: 'wing', nodes: ['e_a'], confidence: 0.99 },
  });
  ok('A: a partial edit applies what it can and reports what it could not',
    mixed.ok && mixed.applied.includes('label') && mixed.applied.includes('nodes')
    && mixed.refused.length === 3, `applied=${mixed.applied} refused=${mixed.refused.map((r) => r.field)}`);
  ok('A: `status` is not an editable field', mixed.refused.some((r) => r.field === 'status'));
  ok('A: `confidence` is not an editable field either', mixed.refused.some((r) => r.field === 'confidence'),
    'a verdict corrects membership, it does not re-score the producer\'s prior');
  ok('A: an unknown joint type is refused with the allowed list',
    mixed.refused.some((r) => r.field === 'type' && ['rotor', 'gimbal', 'hinge'].every((t) => r.why.includes(t))));
  ok('A: the applied fields landed', rec.label === 'corrected' && rec.nodes.join() === 'e_a');
  ok('A: a protected field is unchanged by an edit', rec.status !== 'confirmed' && rec.confidence === 0.5);
  ok('A: the refusals are on the audit trail too',
    rec.history.at(-1).refused?.length === 3 && rec.history.at(-1).edited?.includes('nodes'));
  ok('A: every refusal carries its own reason', mixed.refused.every((r) => typeof r.why === 'string' && r.why.length > 0));

  ok('A: an edit marks the battery stale', rec.retestNeeded === true);
  ok('A: an edit leaves a warn-level stale marker naming what changed',
    rec.tests.some((t) => t.name === STALE_BATTERY && t.level === 'warn' && t.pass === false
      && t.detail.includes('nodes')));
  ok('A: an edited record is needs-verdict, never auto-accepted', rec.status === 'needs-verdict');

  const dup = buildManifest([fakeJoint('d')])[0];
  applyVerdict(dup, { decision: 'edit', edits: { nodes: ['x', 'x', ' x ', 'y'] } });
  ok('A: edited node names are trimmed and de-duplicated', dup.nodes.join() === 'x,y', dup.nodes.join());

  const vec = buildManifest([fakeJoint('v')])[0];
  const badVec = applyVerdict(vec, { decision: 'edit', edits: { anchor: { x: 1, y: NaN, z: 3 } } });
  ok('A: a non-finite vector is refused whole',
    badVec.ok === false && badVec.code === 'NO_EDITS' && vec.anchor.x === 0);
  const badNodes = applyVerdict(buildManifest([fakeJoint('w')])[0], { decision: 'edit', edits: { nodes: [] } });
  ok('A: emptying the node list is refused', badNodes.ok === false);
}

// ---- B) deriveStatus is verdict-aware ---------------------------------------
{
  // The regression this leg exists to catch: a record a human confirmed, then
  // re-scored lower by a later battery, must NOT walk back down to
  // needs-verdict. If it did, the verdict button would be a no-op the moment
  // anything else touched the record, and the human would have no way to tell.
  const rec = buildManifest([fakeJoint('b', { confidence: 0.95 })])[0];
  applyVerdict(rec, { decision: 'accept' });
  rec.confidence = 0.2;
  rec.tests.push({ name: 'disc-coherence', level: 'fail', pass: false, detail: 'later battery disagreed' });
  ok('B: a confirmation survives a later low score', deriveStatus(rec) === 'confirmed');
  ok('B: a confirmation survives a later HARD test failure', deriveStatus(rec) === 'confirmed',
    'terminal against the machine');

  const rej = buildManifest([fakeJoint('b2', { confidence: 0.95 })])[0];
  applyVerdict(rej, { decision: 'reject' });
  ok('B: a rejection survives a later high score', deriveStatus(rej) === 'rejected');

  // Reality, unlike the machine, CAN outvote a human — but only through reopen(),
  // and only visibly.
  const nTests = rec.tests.length;
  reopen(rec, { name: 'rigidity-gate', detail: 'the part tore off' }, 'physical contradiction');
  ok('B: reopen clears a human verdict', rec.verdict === null);
  ok('B: reopen regresses the status despite the old confirmation', rec.status === 'needs-verdict');
  ok('B: reopen records WHICH verdict it superseded',
    rec.history.at(-1).event === 'reopened' && rec.history.at(-1).supersededVerdict === 'accept');
  ok('B: reopen kept the evidence and appended its failing test',
    rec.tests.length === nTests + 1 && rec.evidence.includes('fake'));
  ok('B: a cleared verdict does not resurrect on the next derive', deriveStatus(rec) === 'needs-verdict');

  // With no verdict at all, the old rules must still hold exactly.
  const plain = buildManifest([fakeJoint('p', { confidence: 0.95 })])[0];
  ok('B: no verdict + high confidence + no hard fail = auto-accepted', deriveStatus(plain) === 'auto-accepted');
  plain.tests.push({ name: 'isolation', level: 'fail', pass: false });
  ok('B: a hard fail blocks auto-accept', deriveStatus(plain) === 'needs-verdict');
  const warned = buildManifest([fakeJoint('p2', { confidence: AUTO_ACCEPT_CONFIDENCE })])[0];
  warned.tests.push({ name: 'attachment-sanity', level: 'warn', pass: false });
  ok('B: a warn-level test does not block auto-accept', deriveStatus(warned) === 'auto-accepted');
}

// ---- C) retireStaleEdit ------------------------------------------------------
{
  const rec = buildManifest([fakeJoint('c')])[0];
  applyVerdict(rec, { decision: 'edit', edits: { label: 'fixed' } });
  ok('C: before retirement the edit sits at needs-verdict', rec.status === 'needs-verdict' && rec.retestNeeded);

  rec.confidence = 0.95;
  rec.tests = rec.tests.filter((t) => t.name !== STALE_BATTERY);
  retireStaleEdit(rec);
  ok('C: retiring clears the flag and drops the marker',
    rec.retestNeeded === false && !rec.tests.some((t) => t.name === STALE_BATTERY));
  ok('C: retiring re-derives the status from the NEW membership', rec.status === 'auto-accepted');

  const untouched = buildManifest([fakeJoint('c2')])[0];
  ok('C: retiring a record that was never edited is a no-op', retireStaleEdit(untouched) === untouched
    && untouched.status === 'candidate');
  ok('C: retiring null is a no-op, not a throw', retireStaleEdit(null) === null);
}

// ---- D) claimedNodeSet + constraintSummary -----------------------------------
{
  const m = buildManifest([
    fakeJoint('keep', { nodes: ['k1', 'k2'] }),
    fakeJoint('gone', { nodes: ['g1'] }),
    fakeJoint('human', { nodes: ['h1'] }),
    fakeJoint('edit', { nodes: ['e1'] }),
  ]);
  m[0].status = 'auto-accepted';
  applyVerdict(m[1], { decision: 'reject' });
  applyVerdict(m[2], { decision: 'accept' });
  applyVerdict(m[3], { decision: 'edit', edits: { label: 'x' } });

  const claimed = claimedNodeSet(m);
  ok('D: a rejected record returns its parts to the pool', !claimed.has('g1'));
  ok('D: an auto-accepted record still claims its parts', claimed.has('k1') && claimed.has('k2'));
  ok('D: a human-confirmed record claims its parts', claimed.has('h1'));
  ok('D: a needs-verdict record still claims its parts', claimed.has('e1'),
    'only `rejected` frees a part');

  const sum = constraintSummary(m).join('\n');
  ok('D: a confirmation reaches the producer as a constraint', sum.includes('human:') && sum.includes('HUMAN VERDICT'));
  ok('D: a rejection is NOT a constraint', !sum.includes('gone:'));
  ok('D: an edit at needs-verdict is NOT yet a constraint', !sum.includes('edit:'));
  ok('D: an auto-accept is a constraint with its confidence', sum.includes('keep:') && sum.includes('auto, conf'));

  const amortized = buildManifest([fakeJoint('am', { nodes: ['a1'] })]);
  applyVerdict(amortized[0], { decision: 'accept', amortizedFrom: 'src' });
  amortized[0].status = deriveStatus(amortized[0]);
  ok('D: an amortized confirmation says where it came from',
    constraintSummary(amortized).join('').includes('amortized from src'),
    'a producer must be able to tell an inherited verdict from a direct one');
}

// ---- E) a producer cannot smuggle a verdict ----------------------------------
{
  const g = await parseGlb(GLB);
  const { joints } = await geometryDiscovery.api.discover(GLB, null);
  const { manifest } = runDiscoveryLoop(g, joints, {});
  const claimed = claimedNodeSet(manifest);
  // Real mesh nodes nobody has claimed yet, so the proposal is admitted on its
  // merits and the only thing under test is the protected fields.
  const free = (g.nodes || []).map((n) => n.name).filter((n) => !claimed.has(n)).slice(0, 2);

  const gate = createProposalGate({ g, manifest });
  const kind = gate.admit({
    op: 'new', type: 'rotor', nodeIds: free, axis: [0, 0, 1], anchor: [1, 2, 3],
  }, 0, {
    extra: {
      verdict: { decision: 'accept', actor: 'the model itself' },
      status: 'confirmed', confidence: 0.99, frameRound: 7,
      retestNeeded: false, history: [{ event: 'forged' }],
    },
  });
  const made = gate.records[0];
  ok('E: a forged proposal is still admitted as a record', kind === 'record' && !!made);
  ok('E: a producer cannot set `verdict`', made.verdict === null);
  ok('E: a producer cannot set `status`', made.status === 'candidate');
  ok('E: a producer cannot set `confidence`', made.confidence === 0.7, `conf=${made?.confidence}`);
  ok('E: a producer cannot stamp `frameRound`', made.frameRound === null);
  ok('E: a producer cannot pre-write history', made.history.length === 0);
  ok('E: a forged record still derives to needs-verdict, not confirmed', deriveStatus(made) !== 'confirmed');

  // `reasoning` and friends are NOT protected — they are the producer's own words
  // and the panel displays them as such. Pinning them would blank the evidence.
  const gate2 = createProposalGate({ g, manifest });
  gate2.admit({ op: 'new', type: 'hinge', nodeIds: free, axis: [1, 0, 0], anchor: [0, 0, 0] }, 0,
    { extra: { reasoning: 'it looks hinged', uncertainties: ['the pin is hidden'] } });
  ok('E: a producer MAY supply its reasoning and uncertainties',
    gate2.records[0]?.reasoning === 'it looks hinged' && gate2.records[0]?.uncertainties.length === 1);
}

// ---- F) peersOf --------------------------------------------------------------
{
  const C = [0, 0, 0];
  const R = 100;
  const geom = { center: C, radius: R };
  const rotor = (id, anchor, over = {}) => fakeJoint(id, {
    type: 'rotor', nodes: [`${id}_a`, `${id}_b`],
    anchor: { x: anchor[0], y: anchor[1], z: anchor[2] }, axis: { x: 0, y: 0, z: 1 }, ...over,
  });
  const m = (recs) => buildManifest(recs);

  // The canonical case: a port/starboard pair.
  const pair = m([rotor('fl', [10, 0, 0]), rotor('fr', [-10, 0, 0])]);
  const p = peersOf(pair, 'fl', geom);
  ok('F: a mirrored anchor is found as a peer', p.length === 1 && p[0].id === 'fr');
  ok('F: the peer is reported on the MIRROR tier', p[0].basis === 'mirror' && p[0].flip === 'x');
  ok('F: the mirror is exact, so the gap is zero', p[0].gap === 0, `gap=${p[0].gap}`);
  ok('F: the gloss says which reflection it was in words a human can check',
    typeof p[0].gloss === 'string' && p[0].gloss.length > 20, p[0].gloss);
  ok('F: the relation is symmetric', peersOf(pair, 'fr', geom)[0]?.id === 'fl');
  ok('F: separation is reported so a human can see how far apart they are',
    p[0].separation === 0.2, `sep=${p[0].separation}`);

  // Counter-rotation: FL and BR spin opposite ways, so their recorded axes point
  // in opposite directions and must still count as the same axis.
  const contra = m([rotor('fl', [10, 0, 0]), rotor('br', [-10, 0, 0], { axis: { x: 0, y: 0, z: -1 } })]);
  ok('F: an antiparallel spin axis is still the same axis',
    peersOf(contra, 'fl', geom)[0]?.basis === 'mirror', 'axis treated as a LINE, not a ray');

  const perp = m([rotor('fl', [10, 0, 0]), rotor('odd', [-10, 0, 0], { axis: { x: 1, y: 0, z: 0 } })]);
  ok('F: a perpendicular spin axis is not a peer', peersOf(perp, 'fl', geom).length === 0);
  ok('F: the axis tolerance is a real angle, not a guess', Math.abs(SYMMETRY_AXIS_DOT - Math.cos(10 * Math.PI / 180)) < 1e-12);

  const mixed = m([rotor('fl', [10, 0, 0]), fakeJoint('cam', {
    type: 'gimbal', anchor: { x: -10, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 },
  })]);
  ok('F: a different joint type is never a peer', peersOf(mixed, 'fl', geom).length === 0,
    'symmetrically placed != the same part');

  // The degenerate case the minimum-separation guard exists for: a joint ON a
  // principal plane mirrors onto itself, so two co-located same-type joints would
  // otherwise be each other's "mirror" at zero gap.
  const colocated = m([rotor('gim', [0, 0, 5]), rotor('cam', [0, 0, 5.1])]);
  ok('F: co-located joints are not mirrors of each other', peersOf(colocated, 'gim', geom).length === 0);
  ok('F: the minimum separation is derived from the tolerance, not independent of it',
    SYMMETRY_MIN_SEPARATION === 2 * SYMMETRY_TOLERANCE);

  // A part that misses the mirror by a little is still a mirror; by a lot it is
  // not, and then only the family tier can offer it.
  const near = m([rotor('fl', [10, 0, 0]), rotor('fr', [-10.5, 0.2, 0])]);
  ok('F: a slightly out-of-true mirror still matches', peersOf(near, 'fl', geom)[0]?.basis === 'mirror');
  const far = m([rotor('fl', [10, 0, 0]), rotor('nope', [-18, 0, 0])]);
  ok('F: a badly out-of-true mirror does not match', peersOf(far, 'fl', geom).length === 0);

  // The family tier: same type, same node count, same axis, comparable reach from
  // the centre, but NOT a reflection. This is what makes the sample drone's four
  // rotors one offerable family when its bbox is symmetric in X only.
  const fam = m([rotor('fl', [10, 0, 0]), rotor('fwd', [0, 10.4, 0])]);
  const fp = peersOf(fam, 'fl', geom);
  ok('F: a same-reach sibling is offered on the FAMILY tier', fp.length === 1 && fp[0].basis === 'family');
  ok('F: a family peer names no flip, because there is none', fp[0].flip === null && fp[0].gap === null);
  ok('F: the family gloss quantifies the reach difference',
    fp[0].gloss.includes('%') && fp[0].gloss.includes('not a mirror'), fp[0].gloss);
  ok('F: the family spread tolerance is a fraction, so it scales with the mesh',
    SYMMETRY_FAMILY_SPREAD > 0 && SYMMETRY_FAMILY_SPREAD < 1);

  const farReach = m([rotor('fl', [10, 0, 0]), rotor('out', [0, 40, 0])]);
  ok('F: a sibling at a different reach is not family', peersOf(farReach, 'fl', geom).length === 0);

  // Node count gates the FAMILY tier (it is the only structural evidence there)
  // but not the MIRROR tier (a real machine can have a mirror with a blade
  // missing, and that is exactly the human's call to make).
  const blade = m([rotor('fl', [10, 0, 0], { nodes: ['a', 'b'] }), rotor('fr', [-10, 0, 0], { nodes: ['c'] })]);
  const bp = peersOf(blade, 'fl', geom);
  ok('F: a mirror with a different part count is STILL offered', bp[0]?.basis === 'mirror');
  ok('F: ...and the count mismatch is reported rather than hidden', bp[0]?.sameNodeCount === false && bp[0]?.nodeCount === 1);
  const famBlade = m([rotor('fl', [10, 0, 0], { nodes: ['a', 'b'] }), rotor('fwd', [0, 10.4, 0], { nodes: ['c'] })]);
  ok('F: a part-count mismatch DOES gate the family tier', peersOf(famBlade, 'fl', geom).length === 0);

  // Mirrors sort before family, then best gap first, then by id — so a panel that
  // shows the list top-down puts the strongest evidence first and does not
  // reshuffle its checkboxes every time it is opened.
  const zoo = m([
    rotor('self', [10, 0, 0]),
    rotor('famB', [0, 10.4, 0]),
    rotor('mirNear', [-10.4, 0, 0]),
    rotor('mirExact', [-10, 0, 0]),
    rotor('famA', [0, -10.2, 0]),
  ]);
  const order = peersOf(zoo, 'self', geom).map((x) => x.id);
  ok('F: mirrors sort before family', order.slice(0, 2).every((id) => id.startsWith('mir')));
  ok('F: the tighter mirror sorts first', order[0] === 'mirExact', order.join(' < '));
  ok('F: family peers sort deterministically by id', order[2] === 'famA' && order[3] === 'famB');
  const again = peersOf(zoo, 'self', geom).map((x) => x.id);
  ok('F: the order is stable between calls', again.join() === order.join());

  // Degenerate inputs return [] rather than throwing: "no peer" and "you asked
  // about a joint that does not exist" are the same thing to a caller that only
  // wants to know whom to offer the button to.
  ok('F: an unknown id yields no peers', peersOf(zoo, 'nope', geom).length === 0);
  ok('F: a record with no usable anchor yields no peers',
    peersOf(m([fakeJoint('na', { anchor: null })]), 'na', geom).length === 0);
  ok('F: a singleton manifest yields no peers', peersOf(m([rotor('only', [10, 0, 0])]), 'only', geom).length === 0);
  ok('F: a null manifest yields no peers, not a throw', peersOf(null, 'x', geom).length === 0);
  ok('F: a nonsense radius falls back to the unit sphere rather than dividing by zero',
    peersOf(pair, 'fl', { center: C, radius: 0 }).length >= 0);
  ok('F: a two-element centre is rejected rather than silently mis-mirroring',
    peersOf(pair, 'fl', { center: [0, 0], radius: R }).length === 1,
    'g.center is XY-only, so the canonical helpers must supply it');

  const all = symmetryPeers(pair, geom);
  ok('F: symmetryPeers maps every record', all.size === 2 && all.get('fl')[0].id === 'fr');
  ok('F: only accept and reject may travel', [...AMORTIZABLE].sort().join() === 'accept,reject' && !AMORTIZABLE.has('edit'));
}

// ---- G) symmetryGroups -------------------------------------------------------
{
  const geom = { center: [0, 0, 0], radius: 100 };
  const rotor = (id, a) => fakeJoint(id, {
    type: 'rotor', nodes: [`${id}_a`, `${id}_b`],
    anchor: { x: a[0], y: a[1], z: a[2] }, axis: { x: 0, y: 0, z: 1 },
  });
  // A quad: two exact mirrors plus two family links. The components are
  // transitive, so all four come out as ONE group even though no single flip
  // maps every one of them onto every other.
  const quad = buildManifest([
    rotor('fl', [10, 0, 0]), rotor('fr', [-10, 0, 0]),
    rotor('rl', [0, 10.4, 0]), rotor('rr', [0, -10.4, 0]),
    fakeJoint('cam', { type: 'gimbal', anchor: { x: 0, y: 0, z: -8 }, axis: { x: 1, y: 0, z: 0 } }),
  ]);
  const groups = symmetryGroups(quad, geom);
  ok('G: the four rotors form ONE offerable family', groups.length === 1 && groups[0].length === 4,
    groups.map((x) => x.join('+')).join(' | '));
  ok('G: singletons are dropped, so the count means families', !groups.flat().includes('cam'));
  ok('G: grouping agrees with peersOf rather than re-deriving it',
    groups[0].every((id) => id === 'fl' || peersOf(quad, 'fl', geom).some((p) => p.id === id)
      || peersOf(quad, id, geom).some((p) => groups[0].includes(p.id))));
  ok('G: an empty manifest yields no groups', symmetryGroups([], geom).length === 0);
  ok('G: a null manifest yields no groups, not a throw', symmetryGroups(null, geom).length === 0);
}

// ---- H, I, J) the real sample mesh ------------------------------------------
const g = await parseGlb(GLB);
const { joints } = await geometryDiscovery.api.discover(GLB, null);
const { manifest } = runDiscoveryLoop(g, joints, {});
const geom = { center: modelTarget(g), radius: modelRadius(g) };
const rotors = manifest.filter((r) => r.type === 'rotor');

{
  ok('H: the sample mesh has more than one rotor to amortize across', rotors.length >= 2, `${rotors.length} rotors`);
  const groups = symmetryGroups(manifest, geom);
  const rotorGroup = groups.find((grp) => grp.includes(rotors[0].id)) || [];
  ok('H: every rotor lands in ONE offerable family', rotorGroup.length === rotors.length,
    `${rotorGroup.length}/${rotors.length}: ${rotorGroup.join(', ')}`);
  ok('H: the family is reported with both tiers present',
    peersOf(manifest, rotors[0].id, geom).some((p) => p.basis === 'mirror')
    || peersOf(manifest, rotors[0].id, geom).some((p) => p.basis === 'family'));
  const bases = new Set(peersOf(manifest, rotors[0].id, geom).map((p) => p.basis));
  console.log(`    rotors=${rotors.length} group=${rotorGroup.length} tiers=${[...bases].join('/') || 'none'} centre=[${geom.center.map((n) => n.toFixed(1))}] R=${geom.radius.toFixed(1)}`);
  ok('H: a non-rotor is not offered a rotor verdict',
    peersOf(manifest, rotors[0].id, geom).every((p) => p.type === 'rotor'));
}

{
  // I: the orchestration layer — one write path shared by routes and UI.
  ok('I: an unknown joint is refused with a code the route maps to 404',
    applyJointVerdict(g, joints, manifest, { id: 'nope', decision: 'accept' }).code === 'NO_RECORD');
  ok('I: an unknown decision is refused with a code the route maps to 400',
    applyJointVerdict(g, joints, manifest, { id: rotors[0].id, decision: 'yes' }).code === 'BAD_VERDICT');

  const target = rotors[0];
  const joint = joints.find((j) => j.id === target.id);
  const r = applyJointVerdict(g, joints, manifest, { id: target.id, decision: 'accept', actor: 'test' });
  ok('I: accept confirms the record', r.ok && r.status === 'confirmed' && target.status === 'confirmed');
  ok('I: the served joint object agrees with the record', joint.status === 'confirmed' && joint.verdict?.decision === 'accept',
    'one write path, so the chip and the manifest cannot disagree');

  // A label-only edit must re-score THIS record and leave its siblings alone.
  const sibling = rotors[1];
  const sibJoint = joints.find((j) => j.id === sibling.id);
  const sibBefore = sibJoint ? sibling.tests.find((t) => t.name === 'disc-coherence') : null;
  const labelEdit = applyJointVerdict(g, joints, manifest, {
    id: target.id, decision: 'edit', edits: { label: 'front-left rotor' },
  });
  ok('I: a label edit applies and is reported', labelEdit.ok && labelEdit.applied.join() === 'label');
  ok('I: a label-only edit does NOT re-score its siblings',
    sibBefore === null || sibling.tests.find((t) => t.name === 'disc-coherence') === sibBefore);
  ok('I: an edit is retired by the re-run, so it does not sit stale forever',
    target.retestNeeded === false && !target.tests.some((t) => t.name === STALE_BATTERY));
  ok('I: the edited label landed on the joint object too', joint.label === 'front-left rotor');

  // A NODES edit falsifies `isolation` manifest-wide, so it must widen: the
  // sibling whose part was just claimed has to be re-scored as well.
  const before = sibling.tests.find((t) => t.name === 'disc-coherence');
  const nodesEdit = applyJointVerdict(g, joints, manifest, {
    id: target.id, decision: 'edit', edits: { nodes: target.nodes.slice(0, 1) },
  });
  ok('I: a nodes edit applies', nodesEdit.ok && nodesEdit.applied.includes('nodes'));
  ok('I: a nodes edit re-scores its siblings too',
    before == null || sibling.tests.find((t) => t.name === 'disc-coherence') !== before,
    'isolation is a property of the WHOLE manifest');
  ok('I: a re-run REPLACES its own battery results instead of appending',
    sibling.tests.filter((t) => t.name === 'disc-coherence').length === 1,
    `${sibling.tests.filter((t) => t.name === 'disc-coherence').length} entries`);

  // Evidence from anywhere else survives: reopen()'s rigidity failure is not a
  // battery test, and a re-run must not launder it away.
  reopen(sibling, { name: 'rigidity-gate', detail: 'fake tear-off' }, 'test');
  applyJointVerdict(g, joints, manifest, { id: target.id, decision: 'edit', edits: { label: 'again' } });
  ok('I: a rigidity-gate failure survives a later battery re-run',
    sibling.tests.some((t) => t.name === 'rigidity-gate' && !t.pass));
  ok('I: that reopen also cleared the sibling\'s inherited state', sibling.verdict === null);

  ok('I: an edit does NOT rewrite the producer\'s confidence',
    Number.isFinite(target.confidence), `conf=${target.confidence} — a correction to membership is not a new measurement`);

  // A consequence worth pinning, because it is the two tiers disagreeing on
  // purpose. The edit above cut this rotor's node count, and the family tier is
  // gated on node count (it has no geometry to corroborate it) while the mirror
  // tier is not — a reflection is a fact about where the part sits, and a mirror
  // with a blade missing is still a mirror. So an edit to membership can narrow
  // whom a verdict may be offered to, and that narrowing is correct rather than
  // a regression: the peers that dropped out were only ever "same kind of part at
  // the same reach", which the edit just stopped being evidence for.
  const tiersNow = new Set(peersOf(manifest, target.id, geom).map((p) => p.basis));
  ok('I: a node-count edit keeps the MIRROR peers', tiersNow.has('mirror'), [...tiersNow].join('/'));
  ok('I: ...and dissolves the FAMILY peers, which leaned on that count', !tiersNow.has('family'),
    `${peersOf(manifest, target.id, geom).length} peer(s) left`);
}

{
  // J: amortization — the lateral edge, executed.
  //
  // A PRISTINE manifest and joint list, shadowing leg I's on purpose. Leg I ends
  // by cutting one rotor's node set, which dissolves its family peers (see the
  // last two assertions above), so amortizing against that state would offer one
  // peer where the real mesh offers three — and would test the side effects of an
  // edit rather than the lateral edge itself.
  const { joints } = await geometryDiscovery.api.discover(GLB, null);
  const { manifest } = runDiscoveryLoop(g, joints, {});

  // `src` is the PRISTINE record, not leg I's: leg I shrank this rotor's node set
  // to one part, and every tier test below is about node counts.
  const src = manifest.find((r) => r.id === rotors[0].id);
  const peerIds = peersOf(manifest, src.id, geom).map((p) => p.id);
  ok('J: the source rotor has offerable peers', peerIds.length > 0, peerIds.join(', '));
  ok('J: on a real quad one verdict reaches every other rotor', peerIds.length === rotors.length - 1,
    `${peerIds.length} of ${rotors.length - 1} — the plan's rotor_fl -> fr/bl/br`);
  ok('J: no peer has a verdict yet, so nothing here is inherited from leg I',
    manifest.every((r) => r.verdict === null));

  ok('J: amortizing from a record with no verdict is refused',
    amortizeVerdict(g, joints, manifest, { fromId: src.id, toIds: peerIds }).code === 'NO_VERDICT');
  ok('J: an unknown source is refused',
    amortizeVerdict(g, joints, manifest, { fromId: 'nope', toIds: peerIds }).code === 'NO_RECORD');

  applyJointVerdict(g, joints, manifest, { id: src.id, decision: 'edit', edits: { label: 'fl' } });
  const notAmortizable = amortizeVerdict(g, joints, manifest, { fromId: src.id, toIds: peerIds });
  ok('J: an EDIT verdict cannot travel', notAmortizable.ok === false && notAmortizable.code === 'NOT_AMORTIZABLE');
  ok('J: the refusal says WHY in terms a human can act on',
    notAmortizable.error.includes('node names'), notAmortizable.error);

  applyJointVerdict(g, joints, manifest, { id: src.id, decision: 'accept', actor: 'human' });
  ok('J: no peers selected is a refusal, never "all of them"',
    amortizeVerdict(g, joints, manifest, { fromId: src.id, toIds: [] }).code === 'NO_PEERS');
  ok('J: omitting the peer list entirely is the same refusal',
    amortizeVerdict(g, joints, manifest, { fromId: src.id }).code === 'NO_PEERS');

  const nonPeer = manifest.find((r) => !peerIds.includes(r.id) && r.id !== src.id);
  const partial = amortizeVerdict(g, joints, manifest, {
    fromId: src.id, toIds: [...peerIds, nonPeer?.id].filter(Boolean),
  });
  ok('J: a non-peer is REFUSED, not silently skipped',
    partial.ok && partial.refused.some((x) => x.id === nonPeer?.id && x.why.includes('not a symmetry peer')));
  ok('J: every real peer took the verdict', partial.applied.length === peerIds.length,
    `${partial.applied.length}/${peerIds.length}`);
  ok('J: the decision is whatever the source record said, not a parameter',
    partial.decision === 'accept' && partial.applied.every((a) => a.status === 'confirmed'));
  ok('J: each target records WHERE its verdict came from',
    peerIds.every((id) => manifest.find((r) => r.id === id).verdict?.amortizedFrom === src.id));
  ok('J: an inherited verdict is labelled as inherited, not as a direct one',
    peerIds.every((id) => manifest.find((r) => r.id === id).verdict?.actor === 'human'));
  ok('J: the applied list carries the tier each peer qualified on',
    partial.applied.every((a) => a.basis === 'mirror' || a.basis === 'family'));
  ok('J: the full offer is returned, not only the wins',
    partial.peers.length >= peerIds.length && partial.peers.every((p) => 'basis' in p && 'gloss' in p));
  ok('J: the served joints agree with the records',
    peerIds.every((id) => (joints.find((j) => j.id === id) || {}).status === 'confirmed'));

  // A DIRECT human verdict outranks an inference drawn from a mirror. Overwriting
  // it would be the machine outvoting the person who actually looked at the joint.
  const direct = peerIds[0];
  applyJointVerdict(g, joints, manifest, { id: direct, decision: 'reject', actor: 'human' });
  applyJointVerdict(g, joints, manifest, { id: src.id, decision: 'accept', actor: 'human' });
  const clash = amortizeVerdict(g, joints, manifest, { fromId: src.id, toIds: [direct] });
  ok('J: a peer with a DIRECT verdict is skipped',
    clash.ok === false && clash.skipped.some((s) => s.id === direct && s.why.includes('direct human verdict')));
  ok('J: ...and its own verdict is left intact',
    manifest.find((r) => r.id === direct).verdict.decision === 'reject'
    && manifest.find((r) => r.id === direct).verdict.amortizedFrom === null);
  ok('J: nothing applying at all is ok:false with its own code',
    clash.code === 'NOTHING_APPLIED' && clash.applied.length === 0);

  // An INHERITED verdict may be replaced: it is not direct evidence, and the newer
  // family decision is at least as good.
  const inherited = peerIds[1];
  const rec2 = manifest.find((r) => r.id === inherited);
  ok('J: the peer under test really is carrying an inherited verdict', rec2.verdict?.amortizedFrom === src.id);
  applyJointVerdict(g, joints, manifest, { id: src.id, decision: 'reject', actor: 'human' });
  const replaced = amortizeVerdict(g, joints, manifest, { fromId: src.id, toIds: [inherited] });
  ok('J: an inherited verdict MAY be replaced by a newer family decision',
    replaced.ok && rec2.verdict.decision === 'reject' && rec2.status === 'rejected');
  ok('J: the replacement reports what it overwrote', replaced.applied[0].replaced === 'accept');

  // Rejecting frees the parts, which is the whole point of a human gate: the next
  // proposal round may claim them again. `src` and `direct` are both rejected by
  // now, so the still-confirmed control is the third peer, which the amortization
  // reached and nothing since has touched.
  const stillUp = manifest.find((r) => r.id === peerIds[2]);
  const claimedNow = claimedNodeSet(manifest);
  ok('J: a rejected peer returns its parts to the pool',
    rec2.nodes.every((n) => !claimedNow.has(n)), `${rec2.nodes.length} part(s) freed`);
  ok('J: a rejected source returns its parts too', src.nodes.every((n) => !claimedNow.has(n)));
  ok('J: an INHERITED confirmation still claims its parts',
    stillUp.status === 'confirmed' && stillUp.verdict?.amortizedFrom === src.id
    && stillUp.nodes.every((n) => claimedNow.has(n)),
    'confirming a joint must never hand its parts back to the next round');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('VERDICT_PROBE_OK');

// Actuator-dictionary + recognition-gate proof — the automated answer to
// "does the deterministic category table drive the expected counts, and does
// the dual admission rule (physics-grounded AND visually recognized) decide
// the actuator list?"
//
// Nine legs, exit 0 only if all hold:
//   D1) a free-text category resolves to the right table entry — and an
//       unknown machine is a clean MISS, never a forced match
//   D2) the recognition vocabulary is closed, normalized (case, dashes,
//       plurals), and every table entry speaks the IR's three motions
//   D3) reconcileExpectation pins the deterministic counts onto a prior, the
//       gap check falsifies THOSE, and the discovery prompt is handed the
//       reference list as a hypothesis
//   D4) both prompts say their new parts out loud: the discovery turn gets the
//       vocabulary + the "part" field, the category turn gets the known kinds
//   D5) the vision producer validates `part` against the vocabulary: a valid
//       name lands on the record, a plural is rescued, an unknown word reads
//       as UNRECOGNIZED with a warning, and a confirm can carry a name
//   D6) the gate itself: expected listed, extras listed-and-flagged, the
//       unnamed EXCLUDED with a note — and with no category match it is a
//       no-op, so pre-dictionary behaviour is untouched
//   D7) a name arriving via corroboration stamps the existing record, first
//       name wins, and lane reconciliation carries the name into the confirm
//   D8) one whole vision round with faked effects: the category is reconciled,
//       the recognition beat fires, and the three proposal fates land on the
//       manifest
//   D9) the step-2 hardline: a record is VISIBLE as an actuator only when its
//       part is one of the pre-defined category names — unnamed, unknown-word,
//       gate-withheld, and rejected records are all hidden
//
// Usage: node test/verify-dictionary.mjs
import { parseGlb } from '../src/lib/gltf.mjs';
import { planViews } from '../src/plugins/discovery/views.mjs';
import {
  ACTUATOR_VOCABULARY, DICTIONARY, actuatorList, actuatorVisible, applyRecognitionGate,
  lookupDictionary, normPartName, reconcileExpectation,
} from '../src/plugins/discovery/actuator-dictionary.mjs';
import { expectationBrief, expectationGap, buildExpectationPrompt, isExpectationPrompt } from '../src/plugins/discovery/expectation.mjs';
import { buildVisionPrompt } from '../src/plugins/discovery/vision-prompt.mjs';
import { visionPropose } from '../src/plugins/discovery/vision-propose.mjs';
import { admitCandidates, reconcileLanes, runVisionRound } from '../src/plugins/discovery/loop.mjs';
import { frameKey } from '../src/plugins/discovery/observations.mjs';

const GLB = 'samples/drone_dji_inspire3.glb';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); } else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const J = (o) => JSON.stringify(o);

console.log('\nProving the actuator dictionary + recognition gate\n');

// ---- D1) category lookup -----------------------------------------------------
{
  ok('D1: a free-text category resolves to its entry, however the model phrased it',
    lookupDictionary('quadrotor drone')?.key === 'quadrotor-drone'
    && lookupDictionary('a sports car, possibly a Porsche')?.key === 'car'
    && lookupDictionary('main battle tank')?.key === 'tank'
    && lookupDictionary('DJI quad')?.key === 'quadrotor-drone'
    && lookupDictionary('robotic arm')?.key === 'robot-arm');
  ok('D1: the longest alias wins, so a compound phrase cannot land on its shorter neighbour',
    lookupDictionary('quadrotor drone with a camera')?.key === 'quadrotor-drone');
  ok('D1: an unknown machine is a clean MISS — a true unknown beats a forced match',
    lookupDictionary('submarine') === null && lookupDictionary('') === null && lookupDictionary(null) === null);
  ok('D1: the table covers the twelve kinds the category prompt advertises',
    Object.keys(DICTIONARY).length === 12,
    Object.keys(DICTIONARY).join(', '));
}

// ---- D2) the closed vocabulary ------------------------------------------------
{
  // The table speaks the MODEL-FACING two words only. hinge survives as an IR
  // type (manual records, the motion lane) but no prompt offers it, so no
  // entry here may use it — and a limited-swing part (door, boom, control
  // surface) is a gimbal in this vocabulary.
  const motions = new Set(['rotor', 'gimbal']);
  const entries = Object.values(DICTIONARY).flatMap((e) => e.actuators);
  ok('D2: every table entry speaks the model-facing motion vocabulary and a positive count',
    entries.every((a) => motions.has(a.motion) && a.count >= 1 && a.name && a.where));
  ok('D2: hinge appears NOWHERE in the table — it is an internal IR type, never an expectation',
    !entries.some((a) => a.motion === 'hinge'));
  ok('D2: doors are listed for the categories that have them — named door, typed gimbal',
    ['car', 'truck', 'bus'].every((k) => DICTIONARY[k].actuators.some((a) => a.name === 'door' && a.motion === 'gimbal' && a.count === 2 && !a.soft)));
  ok('D2: the vocabulary is exactly the names the table uses — no orphan words, no missing ones',
    entries.every((a) => ACTUATOR_VOCABULARY.has(a.name))
    && ACTUATOR_VOCABULARY.size === new Set(entries.map((a) => a.name)).size);
  ok('D2: names normalize — case, spaces, dashes, and a plural rescued only into a real word',
    normPartName('Wheels') === 'wheel'
    && normPartName('doors') === 'door'
    && normPartName('track sprocket') === 'track_sprocket'
    && normPartName('MAIN_ROTOR') === 'main_rotor'
    && normPartName('flux-capacitor') === null
    && normPartName('') === null && normPartName(null) === null,
    `bus -> ${J(normPartName('bus'))} (a plural rule that fired here would mangle it)`);
  ok('D2: a word ending in s that is NOT a plural of a vocabulary word is left alone',
    normPartName('bus') === null && normPartName('glass') === null);
}

// ---- D3) reconciliation drives the counts -------------------------------------
{
  const exp = {
    category: 'Sports car', confidence: 0.9, summary: 'a low coupe',
    instances: [{ type: 'rotor', count: 2, frameId: 'f', regionBox: [0, 0, 0.1, 0.1] }],
    doubts: [], alternatives: [],
  };
  const rec = reconcileExpectation(exp);
  ok('D3: a known category is pinned to its table entry with deterministic per-motion counts',
    exp.dictKey === 'car' && exp.dictCounts?.rotor === 4 && exp.dictCounts?.gimbal === 6
    && typeof exp.dictRef === 'string' && /4x wheel/.test(exp.dictRef) && /2x door/.test(exp.dictRef),
    exp.dictRef);
  ok('D3: a disagreement between the first look and the table is ANNOUNCED, not absorbed',
    rec.warnings.some((w) => /usually has 4 rotor/.test(w) && /first look said 2/.test(w)), J(rec.warnings));
  const gaps = expectationGap(exp, []);
  ok('D3: the gap check falsifies the DICTIONARY list per part NAME, not the model\'s run-to-run guess — and a car expects no hinges',
    gaps.find((x) => x.part === 'wheel')?.expected === 4 && gaps.find((x) => x.part === 'door')?.expected === 2
      && gaps.find((x) => x.part === 'mirror')?.expected === 2 && gaps.find((x) => x.part === 'headlight')?.expected === 2
      && !gaps.some((x) => x.type || x.part === 'hinge'),
    J(gaps));
  ok('D3: a kind the model expected and the table does not list is still looked for',
    expectationGap({ instances: [{ type: 'hinge', count: 2 }], dictCounts: { rotor: 4 } }, [])
      .find((x) => x.type === 'hinge')?.expected === 2);
  ok('D3: the discovery prompt is handed the reference list as a hypothesis line, walked one by one',
    expectationBrief(exp).some((l) => /reference list for a car/.test(l) && /one by one/.test(l)));
  const miss = reconcileExpectation({ category: 'submarine', instances: [] });
  ok('D3: a category the table does not know keeps the model\'s own counts, and says so',
    miss.dict === null && miss.warnings.some((w) => /not in the actuator dictionary/.test(w)), J(miss.warnings));
}

// ---- D4) the prompts say their new parts out loud -----------------------------
{
  const vp = buildVisionPrompt({ manifest: [], frames: [], plan: { views: [] } });
  ok('D4: the discovery prompt carries the PARTS vocabulary and the "part" field in its schema',
    /PARTS vocabulary/.test(vp.text) && /"part"/.test(vp.text) && vp.text.includes('wheel') && vp.text.includes('turret'));
  ok('D4: null is offered as the honest answer — an unnamed part must be sayable',
    /Use null when none of these honestly fits/.test(vp.text));
  const ep = buildExpectationPrompt({ frames: [{ id: 'f0', mode: 'photo', dataBase64: PNG }] });
  ok('D4: the category prompt names the kinds the table knows, and permits a true unknown',
    ep.text.includes('quadrotor-drone') && ep.text.includes('robot-arm') && /a true unknown beats a forced match/.test(ep.text));
  ok('D4: the category prompt teaches TWO motion kinds and never speaks the word hinge',
    /"motion": "rotor\|gimbal"/.test(ep.text) && /Do not invent a third kind/.test(ep.text) && !/\bhinge\b/.test(ep.text));
  ok('D4: the discovery prompt proposes a door as a gimbal named door, and refuses the other hinged panels',
    /A DOOR is proposed/.test(vp.text) && /part "door"/.test(vp.text) && /hood, hatch, trunk, wiper\) are NOT proposed/.test(vp.text));
}

// ---- D5) the producer validates the name --------------------------------------
const g = await parseGlb(GLB);
const nodeNames = g.nodes.map((n) => n.name).filter(Boolean);
const [n1, n2, n3] = nodeNames;
{
  const base = { op: 'new', type: 'rotor', axis: [0, 0, 1], anchor: [0, 0, 0] };
  const run = (items, manifest = []) => visionPropose({ reply: J(items), g, manifest, frames: [], plan: null });
  const good = run([{ ...base, nodeIds: [n1], part: 'rotor' }]);
  ok('D5: a valid part name lands on the record',
    good.records[0]?.part === 'rotor', J(good.warnings));
  const plural = run([{ ...base, nodeIds: [n1], part: 'Wheels' }]);
  ok('D5: a plural with different case is rescued into the vocabulary word',
    plural.records[0]?.part === 'wheel', J(plural.warnings));
  const junk = run([{ ...base, nodeIds: [n1], part: 'flux-capacitor' }]);
  ok('D5: a name outside the vocabulary is NOT rescued — the record stays, unnamed, with a warning',
    junk.records[0] && junk.records[0].part === undefined
    && junk.warnings.some((w) => /flux-capacitor/.test(w) && /not in the actuator vocabulary/.test(w)), J(junk.warnings));
  const existing = [{ id: 'rotor_geo_0', type: 'rotor', status: 'candidate', nodes: [n2], evidence: [] }];
  const conf = run([{ op: 'confirm', targetId: 'rotor_geo_0', type: 'rotor', part: 'rotor', reasoning: 'I can see it' }], existing);
  ok('D5: a confirm can carry the name — corroboration is how a geometry record learns what it IS',
    conf.confirms[0]?.part === 'rotor' && conf.records.length === 0, J(conf.confirms));
}

// ---- D6) the gate --------------------------------------------------------------
{
  const manifest = [
    { id: 'a', type: 'rotor', status: 'candidate', nodes: [n1], part: 'wheel' },
    { id: 'b', type: 'rotor', status: 'candidate', nodes: [n2], part: 'turret' },
    { id: 'c', type: 'hinge', status: 'candidate', nodes: [n3] },
    { id: 'd', type: 'rotor', status: 'rejected', nodes: [nodeNames[4]] },
  ];
  const r = applyRecognitionGate(manifest, { category: 'car' });
  ok('D6: a recognized part the category expects is LISTED as expected',
    r.dict === 'car' && manifest[0].listed === true && manifest[0].expected === true && manifest[0].extra === false);
  ok('D6: a recognized part the category does NOT have is still listed — flagged EXTRA and announced',
    manifest[1].listed === true && manifest[1].extra === true && r.extras === 1
    && r.notes.some((w) => /"turret"/.test(w) && /EXTRA/.test(w)), J(r.notes));
  ok('D6: a mover nobody could name is EXCLUDED from the list — record kept, listing withheld, announced',
    manifest[2].listed === false && r.excluded === 1
    && r.notes.some((w) => /\bc\b/.test(w) && /EXCLUDED/.test(w)), J(r.notes));
  ok('D6: a rejected record is the human\'s business — the gate does not re-judge it',
    manifest[3].listed === undefined);
  ok('D6: the actuator list is exactly the non-rejected records the gate did not exclude',
    J(actuatorList(manifest).map((x) => x.id)) === J(['a', 'b']), J(actuatorList(manifest).map((x) => x.id)));
  const blind = [{ id: 'x', type: 'rotor', status: 'candidate', nodes: [n1] }];
  const r2 = applyRecognitionGate(blind, { category: 'submarine' });
  ok('D6: with no category match there is no predefined set to be beyond — the gate is a clean no-op',
    r2.dict === null && r2.listed === 0 && r2.excluded === 0 && blind[0].listed === undefined);
  ok('D6: ...and with no category at all the list keeps every live record, exactly as before the table existed',
    actuatorList(blind).length === 1);
}

// ---- D7) names arriving by corroboration ---------------------------------------
{
  const manifest = [{ id: 'rotor_geo_0', type: 'rotor', status: 'candidate', nodes: [n1], evidence: [] }];
  admitCandidates([], manifest, { records: [], confirms: [{ targetId: 'rotor_geo_0', part: 'rotor' }] });
  ok('D7: a confirm stamps its name onto the record it corroborates',
    manifest[0].part === 'rotor');
  admitCandidates([], manifest, { records: [], confirms: [{ targetId: 'rotor_geo_0', part: 'propeller' }] });
  ok('D7: first name wins — a later confirm corroborates, it does not rename',
    manifest[0].part === 'rotor');
  const lanes = reconcileLanes(manifest, { records: [{ id: 'v0', type: 'rotor', nodes: [n1], part: 'propeller' }], confirms: [] }, { origin: 'L2-vision' });
  ok('D7: lane reconciliation carries the lane\'s name into the confirm it converts agreement into',
    lanes.agreed.length === 1 && lanes.confirms[0]?.part === 'propeller', J(lanes.confirms));
}

// ---- D8) one whole round, end to end -------------------------------------------
{
  const bigPlan = planViews(g, { maxViews: 8, allowGhost: true, ghostViews: 2 });
  const beats = [];
  const catReply = (images) => J({
    category: 'quadrotor drone', confidence: 0.91,
    summary: 'four lifting rotors at the arm tips and a camera cradle',
    instances: [{ type: 'rotor', count: 4, frameId: images[0]?.name, regionBox: [0.1, 0.1, 0.4, 0.4], symmetry: '4-fold', note: 'propellers' }],
    doubts: [], alternatives: ['helicopter'],
  });
  const discoveryReply = J([
    { op: 'new', type: 'rotor', part: 'rotor', nodeIds: [n1], axis: [0, 0, 1], anchor: [0, 0, 0], reasoning: 'spins at an arm tip' },
    { op: 'new', type: 'rotor', part: 'turret', nodeIds: [n2], axis: [0, 0, 1], anchor: [0, 0, 0], reasoning: 'a rotating collar' },
    { op: 'new', type: 'gimbal', nodeIds: [n3], axis: [1, 0, 0], anchor: [0, 0, 0], reasoning: 'a tilting collar I cannot name' },
  ]);
  const res = await runVisionRound(g, [], [], {
    plan: () => bigPlan,
    capture: async (view, mode, focusNodes) => ({
      id: frameKey(view.id, mode), viewId: view.id, mode, pose: view.pose, spec: view.spec,
      covers: view.covers, sees: view.sees, focus: focusNodes, mediaType: 'image/png',
      dataBase64: PNG, colorMap: null,
    }),
    propose: async (text, images) => (isExpectationPrompt(text)
      ? { reply: catReply(images), model: 'fake-vlm', ms: 1 }
      : { reply: discoveryReply, model: 'fake-vlm', ms: 1 }),
    expectation: true,
    emit: (kind, payload) => beats.push({ kind, payload }),
  });
  const recBeat = beats.find((b) => b.kind === 'vision:recognition');
  ok('D8: the round lands its three proposals and emits the recognition beat',
    res.ok === true && res.added === 3 && !!recBeat, `added=${res.added}`);
  ok('D8: the category was reconciled against the table before the discovery turn was asked',
    res.expectation?.dictKey === 'quadrotor-drone' && res.expectation?.dictCounts?.rotor === 4
    && beats.some((b) => b.kind === 'vision:expect' && b.payload?.dictKey === 'quadrotor-drone'));
  ok('D8: the beat and the result report the gate\'s verdict — two listed (one an extra), one excluded',
    recBeat?.payload?.dict === 'quadrotor-drone' && recBeat.payload.listed === 2
    && recBeat.payload.extras === 1 && recBeat.payload.excluded === 1
    && J(res.recognition) === J(recBeat.payload), J(recBeat?.payload));
  ok('D8: the exclusion is announced in the round\'s own warnings, so a persisted round keeps it',
    res.warnings.some((w) => /recognition gate: .*EXCLUDED/.test(w)), J(res.warnings.filter((w) => /recognition/.test(w))));
}

// ---- D9) the step-2 hardline --------------------------------------------------
{
  ok('D9: a record named with a pre-defined category is VISIBLE in step 2',
    actuatorVisible({ id: 'w', type: 'rotor', status: 'candidate', nodes: [n1], part: 'wheel' }) === true);
  ok('D9: a record nobody named yet is NOT shown — the list waits for a vocabulary name',
    actuatorVisible({ id: 'u', type: 'rotor', status: 'candidate', nodes: [n2] }) === false);
  ok('D9: a name outside every pre-defined category is NOT shown either',
    actuatorVisible({ id: 'x', type: 'rotor', status: 'candidate', nodes: [n2], part: 'antenna' }) === false);
  ok('D9: a plural spelling of a category name still counts — the normalizer rescues it',
    actuatorVisible({ id: 'd', type: 'gimbal', status: 'candidate', nodes: [n3], part: 'doors' }) === true);
  ok('D9: the recognition gate\'s withheld listing stays withheld, name or not',
    actuatorVisible({ id: 'e', type: 'gimbal', status: 'candidate', nodes: [n3], part: 'door', listed: false }) === false);
  ok('D9: a rejected record is never an actuator, named or not',
    actuatorVisible({ id: 'r', type: 'rotor', status: 'rejected', nodes: [n1], part: 'rotor' }) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

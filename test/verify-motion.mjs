// Motion-fan proof — phase 3, task 18.
//
// A motion round is the one turn in this codebase that asks a model a SEMANTIC
// question about something already measured exactly. That asymmetry is what makes
// it easy to get subtly wrong: a round that quietly re-measured, or that turned an
// honest "I cannot tell" into a negative finding, would look like success from the
// UI while corrupting the record a human is about to judge. So every leg asserts
// the failure mode, not the happy path:
//
//   A) buildMotionPrompt — the fan is described AUTHORITATIVELY in text (angle per
//      frame), the corner tag is named as redundancy, the joint's geometry is
//      stated as measured fact, MAX_MOTION_FRAMES caps a stray-large fan, and a
//      frame with no bytes is described-but-not-attached rather than silently sent
//   B) parseMotionReply — one object pulled out of a bare / fenced / array-wrapped
//      / prose-padded reply, and null (not a guess) when there is no object
//   C) motionAssess — observedType outside our four words is DROPPED not guessed;
//      motionSensible coerces to a real boolean or to null, and null is never read
//      as insensible; agreesWithType is COMPUTED here, never trusted from the model
//   D) runMotionRound — the bail ladder leaves the manifest untouched, a preset fan
//      replays with nothing driven, and a captured round ANNOTATES rec.motion
//      without moving confidence or status
//   E) the real sample mesh — a real rotor is framed by regionForJoint (proven by
//      reaching the capture guard rather than the aim guard), and a replayed fan
//      annotates it while confidence/status stay byte-identical
//
// Usage: node test/verify-motion.mjs
import { parseGlb } from '../src/lib/gltf.mjs';
import { geometryDiscovery } from '../src/plugins/discovery/geometry.mjs';
import { buildMotionPrompt, MAX_MOTION_FRAMES } from '../src/plugins/discovery/motion-prompt.mjs';
import { MOTION_TYPES, motionAssess, parseMotionReply } from '../src/plugins/discovery/motion-propose.mjs';
import { MOTION_ANGLES, runMotionRound, runDiscoveryLoop } from '../src/plugins/discovery/loop.mjs';

const GLB = 'samples/drone_dji_inspire3.glb';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}${extra ? ' \u2014 ' + extra : ''}`); } else { fail += 1; console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
};

console.log('\nProving the motion-fan semantic turn\n');

// A tiny stand-in for a rendered pose. Nothing in the headless path decodes it —
// buildMotionPrompt passes bytes straight through to the provider — so a stub is
// honest here in a way a fake geometry would not be.
const PX = 'iVBORw0KGgo=';
const pose = (index, angle, over = {}) => ({
  index, angle, tag: `${angle}\u00b0`, id: `motion_pose_${index}`,
  mediaType: 'image/png', dataBase64: PX, ...over,
});

// A view shape big enough to skip the aim step, so a capture-guard leg is not
// really testing regionForJoint.
const stubView = { id: 'stub', pose: { position: [0, 0, 10], target: [0, 0, 0], up: [0, 0, 1] } };

// ---- A) buildMotionPrompt ---------------------------------------------------
{
  const joint = { id: 'rotor_fl', type: 'rotor', axis: { x: 0, y: 0, z: 1 }, nodes: ['a', 'b', 'c'] };
  const frames = [pose(1, 0), pose(2, 30), pose(3, 60)];
  const composite = { id: 'sweep', kind: 'sweep', mediaType: 'image/png', dataBase64: PX };
  const p = buildMotionPrompt({ joint, frames, composite, mode: 'photo' });

  ok('A: every pose plus the composite is attached, in order',
    p.images.length === 4 && p.images[3].name === 'sweep',
    `${p.images.length} images`);
  ok('A: images are the shape the provider wants',
    p.images.every((im) => im.mediaType && im.dataBase64 && im.name));
  ok('A: the angle is annotated AUTHORITATIVELY in text, one line per frame',
    p.text.includes('frame 1 = pose 1, joint driven to 0\u00b0')
      && p.text.includes('frame 2 = pose 2, joint driven to 30\u00b0')
      && p.text.includes('frame 3 = pose 3, joint driven to 60\u00b0'));
  ok('A: the burned-in corner tag is named as redundancy, not the primary annotation',
    p.text.includes('corner tag reads "30\u00b0"') && /redundancy|reorder/i.test(p.text));
  ok('A: the joint geometry is stated as MEASURED FACT and the model is told not to re-measure',
    p.text.includes('claimed motion type: rotor') && p.text.includes('rotation axis')
      && p.text.includes('3 mesh node(s)') && /do NOT re-measure|already been measured/i.test(p.text));
  ok('A: the question is SEMANTIC ONLY',
    /SEMANTIC ONLY/i.test(p.text) && /is the motion sensible|motionSensible/i.test(p.text));
  ok('A: the swept composite is described as the last frame',
    p.text.includes('frame 4 = swept composite'));
  ok('A: the returned frame manifest records what was actually attached',
    p.frames.length === 3 && p.frames.every((f) => f.attached === true) && p.composite.attached === true);
  ok('A: no warnings on a clean fan', p.warnings.length === 0, p.warnings.join(' | '));

  // A stray-large fan is capped HERE, not trusted to the caller.
  const many = Array.from({ length: MAX_MOTION_FRAMES + 4 }, (_, i) => pose(i + 1, i * 10));
  const capped = buildMotionPrompt({ joint, frames: many, composite: null });
  ok('A: a fan larger than MAX_MOTION_FRAMES is truncated, with a warning',
    capped.images.length === MAX_MOTION_FRAMES
      && capped.warnings.some((w) => /truncated/i.test(w)),
    `${capped.images.length} images kept of ${many.length}`);

  // A frame with no bytes is described in text but NOT attached — sending an empty
  // image would be worse than sending one fewer.
  const holed = buildMotionPrompt({ joint, frames: [pose(1, 0), pose(2, 30, { dataBase64: null })], composite: null });
  ok('A: a frame with no bytes is described but not attached, with a warning',
    holed.images.length === 1 && holed.frames[1].attached === false
      && holed.warnings.some((w) => /no image bytes/i.test(w)));

  // No frames at all is still a well-formed (empty) turn, flagged.
  const empty = buildMotionPrompt({ joint, frames: [], composite: null });
  ok('A: an empty fan warns rather than throwing',
    empty.images.length === 0 && empty.warnings.some((w) => /no pose frames/i.test(w)));

  // No swept composite is stated, so the model judges from the poses.
  const noComp = buildMotionPrompt({ joint, frames, composite: null });
  ok('A: a missing composite is stated in text, not silently dropped',
    /no swept composite/i.test(noComp.text));
}

// ---- B) parseMotionReply ----------------------------------------------------
{
  const obj = { label: 'two-blade propeller', observedType: 'rotor', motionSensible: true };
  ok('B: a bare object is parsed', parseMotionReply(JSON.stringify(obj)).item?.observedType === 'rotor');
  ok('B: a fenced object is parsed',
    parseMotionReply('```json\n' + JSON.stringify(obj) + '\n```').item?.label === 'two-blade propeller');
  const wrapped = parseMotionReply(JSON.stringify([obj]));
  ok('B: a single-object array wrap still yields the object',
    wrapped.item?.observedType === 'rotor');
  // The array FALLBACK (and its warning) is only reached for a genuinely odd shape:
  // several objects, where the brace slice "{...},{...}" is not valid JSON.
  const multi = parseMotionReply(JSON.stringify([obj, { label: 'second', observedType: 'hinge' }]));
  ok('B: a multi-object array takes the first object, with an array warning',
    multi.item?.observedType === 'rotor' && multi.warnings.some((w) => /array/i.test(w)));
  ok('B: prose padding around the object is tolerated',
    parseMotionReply(`Sure! Here you go: ${JSON.stringify(obj)} — hope that helps.`).item?.observedType === 'rotor');
  const none = parseMotionReply('I cannot see anything in these frames.');
  ok('B: no object yields null, not a guess',
    none.item === null && none.warnings.some((w) => /no JSON object/i.test(w)));
}

// ---- C) motionAssess --------------------------------------------------------
{
  const rotor = { id: 'rotor_fl', type: 'rotor' };

  const good = motionAssess({ reply: JSON.stringify({ label: 'propeller', observedType: 'rotor', motionSensible: true, confidence: 0.9 }), joint: rotor });
  ok('C: a clean rotor assessment agrees with the claim',
    good.assessment.observedType === 'rotor' && good.assessment.motionSensible === true
      && good.assessment.agreesWithType === true && good.assessment.concerns.length === 0);
  ok('C: modelConfidence is carried for ROUTING only',
    good.assessment.modelConfidence === 0.9 && good.assessment.confidence === undefined);

  // observedType outside our vocabulary is DROPPED, never guessed into one.
  const wing = motionAssess({ reply: JSON.stringify({ observedType: 'wing', motionSensible: true }), joint: rotor });
  ok('C: an observedType outside rotor|gimbal|hinge|static is dropped, with a warning',
    wing.assessment.observedType === null && wing.warnings.some((w) => /not one of/i.test(w)));
  ok('C: MOTION_TYPES is exactly the four words',
    MOTION_TYPES.size === 4 && ['rotor', 'gimbal', 'hinge', 'static'].every((t) => MOTION_TYPES.has(t)));

  // An unclear motionSensible becomes null (unknown), NEVER false. This is the
  // load-bearing rule: a false negative drags a human in to review a joint the
  // model never doubted.
  const unclear = motionAssess({ reply: JSON.stringify({ observedType: 'rotor', motionSensible: 'maybe' }), joint: rotor });
  ok('C: an unclear motionSensible is recorded as null (unknown), NOT insensible',
    unclear.assessment.motionSensible === null
      && unclear.warnings.some((w) => /NOT as insensible|unknown/i.test(w)));
  ok('C: an unknown motionSensible raises NO "not sensible" concern',
    !unclear.assessment.concerns.some((c) => /NOT sensible/i.test(c)));

  // A real negative IS a concern.
  const bad = motionAssess({ reply: JSON.stringify({ observedType: 'rotor', motionSensible: false, reasoning: 'blade shears off' }), joint: rotor });
  ok('C: motionSensible false raises a concern',
    bad.assessment.motionSensible === false && bad.assessment.concerns.some((c) => /NOT sensible/i.test(c)));

  // Disagreement between observed and claimed type is the whole signal.
  const disagree = motionAssess({ reply: JSON.stringify({ observedType: 'gimbal', motionSensible: true }), joint: rotor });
  ok('C: a type disagreement is COMPUTED and surfaced as a concern',
    disagree.assessment.agreesWithType === false
      && disagree.assessment.concerns.some((c) => /looks like a gimbal/i.test(c)));

  // "static" is its own concern: nothing moved.
  const still = motionAssess({ reply: JSON.stringify({ observedType: 'static', motionSensible: true }), joint: rotor });
  ok('C: observedType static raises a "nothing moved" concern',
    still.assessment.concerns.some((c) => /nothing appeared to move/i.test(c)));

  // No parseable reply is null, distinct from "the motion is fine".
  const nothing = motionAssess({ reply: 'no json here', joint: rotor });
  ok('C: an unparseable reply yields a null assessment', nothing.assessment === null);

  // agreesWithType is null when either side is unknown — "cannot compare" is not
  // "they disagree".
  const noType = motionAssess({ reply: JSON.stringify({ motionSensible: true }), joint: rotor });
  ok('C: agreesWithType is null when the model gave no usable type',
    noType.assessment.agreesWithType === null);
}

// ---- D) runMotionRound bail ladder + annotation -----------------------------
{
  const rec = { id: 'j1', type: 'rotor', label: 'j1', nodes: ['a', 'b'], anchor: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, confidence: 0.5, status: 'needs-verdict', tests: [], history: [] };
  const g = { nodes: [{ i: 0, name: 'a', parent: -1 }] };

  ok('D: no parse table bails NO_PROJECT',
    (await runMotionRound(null, [], [rec], { jointId: 'j1' })).code === 'NO_PROJECT');
  ok('D: no manifest bails NO_MANIFEST',
    (await runMotionRound(g, [], null, { jointId: 'j1' })).code === 'NO_MANIFEST');
  ok('D: an unknown jointId bails NO_RECORD',
    (await runMotionRound(g, [], [rec], { jointId: 'nope' })).code === 'NO_RECORD');

  const empty = { ...rec, id: 'j2', nodes: [] };
  ok('D: a record with no nodes bails NO_NODES',
    (await runMotionRound(g, [], [empty], { jointId: 'j2' })).code === 'NO_NODES');

  // Reaching the capture guard (not the aim guard) requires a view; supply one so
  // this leg tests the missing-renderer path specifically.
  const noRenderer = await runMotionRound(g, [], [rec], { jointId: 'j1', view: stubView });
  ok('D: no capture effect and no preset fan bails NO_RENDERER',
    noRenderer.code === 'NO_RENDERER' && noRenderer.manifestUntouched === true);

  const shortFan = { frames: [pose(1, 0)] };
  ok('D: a preset fan with fewer than 2 usable frames bails NO_FRAMES',
    (await runMotionRound(g, [], [rec], { jointId: 'j1', view: stubView, fan: shortFan })).code === 'NO_FRAMES');

  // A full preset fan but no model wired.
  const fan = { frames: [pose(1, 0), pose(2, 30), pose(3, 60)], composite: { id: 'sweep', kind: 'sweep', dataBase64: PX }, angles: [0, 30, 60] };
  const noAgent = await runMotionRound(g, [], [rec], { jointId: 'j1', view: stubView, fan });
  ok('D: a fan with no propose effect bails NO_VISION_AGENT',
    noAgent.code === 'NO_VISION_AGENT' && noAgent.manifestUntouched === true);

  // A capture effect that throws NO_RENDERER is surfaced, not swallowed.
  const throwing = await runMotionRound(g, [], [rec], {
    jointId: 'j1', view: stubView,
    capture: async () => { const e = new Error('no renderer'); e.code = 'NO_RENDERER'; throw e; },
  });
  ok('D: a capture that throws NO_RENDERER bails with that code', throwing.code === 'NO_RENDERER');

  // The full happy path with injected effects: annotate, persist, and prove the
  // status/confidence did NOT move.
  const live = { ...rec, id: 'j3' };
  const before = { confidence: live.confidence, status: live.status };
  let persisted = null;
  const res = await runMotionRound(g, [], [live], {
    jointId: 'j3', view: stubView, fan,
    propose: async () => ({ reply: JSON.stringify({ label: 'propeller', observedType: 'rotor', motionSensible: true, confidence: 0.8 }), model: 'stub', ms: 3 }),
    persist: { motion: (m) => { persisted = m; } },
  });
  ok('D: a captured round succeeds and annotates the record',
    res.ok === true && live.motion?.observedType === 'rotor' && live.motion?.motionSensible === true);
  ok('D: annotation did NOT move confidence or status — motion is evidence, not measurement',
    live.confidence === before.confidence && live.status === before.status);
  ok('D: the round reports manifestUntouched:false but annotated:true',
    res.manifestUntouched === false && res.annotated === true);
  ok('D: the exchange was persisted for replay',
    persisted && persisted.jointId === 'j3' && persisted.frames.length === 3 && persisted.reply);
  ok('D: MOTION_ANGLES is the 0/30/60 default fan',
    JSON.stringify(MOTION_ANGLES) === JSON.stringify([0, 30, 60]));
}

// ---- E) the real sample mesh ------------------------------------------------
{
  const g = await parseGlb(GLB);
  const { joints } = await geometryDiscovery.api.discover(GLB, null);
  const { manifest } = runDiscoveryLoop(g, joints, {});
  const rotor = manifest.find((r) => (r.type === 'rotor') && Array.isArray(r.nodes) && r.nodes.length);
  ok('E: the sample mesh yields a real rotor record to drive', !!rotor, rotor?.id);

  if (rotor) {
    // No view override and no capture: the round must AIM (regionForJoint +
    // planCloseUps) successfully and only then reach the capture guard. Bailing
    // NO_RENDERER — rather than NO_REGION/NO_VIEWS — proves the real rotor was
    // framed by its own geometry.
    const aimed = await runMotionRound(g, joints, manifest, { jointId: rotor.id });
    ok('E: regionForJoint frames the real rotor (reached the capture guard, not the aim guard)',
      aimed.code === 'NO_RENDERER', aimed.code);

    // Replay a fan against the real record and prove annotation is inert on the
    // fields the battery and the human own.
    const snap = { confidence: rotor.confidence, status: rotor.status };
    const fan = { frames: [pose(1, 0), pose(2, 30), pose(3, 60)], composite: { id: 'sweep', kind: 'sweep', dataBase64: PX }, angles: [0, 30, 60] };
    const res = await runMotionRound(g, joints, manifest, {
      jointId: rotor.id, fan,
      propose: async () => ({ reply: JSON.stringify({ label: 'propeller', observedType: 'rotor', motionSensible: true, reasoning: 'spins cleanly', confidence: 0.7 }), model: 'stub', ms: 4 }),
    });
    ok('E: a replayed fan annotates the real rotor',
      res.ok === true && rotor.motion?.label === 'propeller' && rotor.motion?.frames.length === 3);
    ok('E: the real rotor\u2019s confidence and status are untouched by the semantic turn',
      rotor.confidence === snap.confidence && rotor.status === snap.status);
    ok('E: the assessment agreed a rotor looks like a rotor',
      rotor.motion?.agreesWithType === true && (rotor.motion?.concerns || []).length === 0);
  }
}

console.log(`\nMOTION_PROBE_${fail === 0 ? 'OK' : 'FAIL'} \u2014 ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

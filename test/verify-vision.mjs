// Vision-producer proof — the automated answer to "when a model POINTS at a
// rendered frame instead of naming nodes, do we resolve it to the right nodes,
// keep its doubt, and refuse to let its self-confidence into the manifest?"
//
// Six legs, exit 0 only if all hold:
//   A) the geometry fallbacks: a part cloud's centroid is its anchor, and a FLAT
//      cloud's least-variance direction is its spin axis — while a blobby cloud
//      yields NO axis rather than a confident wrong one
//   B) a box-only reply grounds to the part the box was drawn around, and the
//      anchor comes from geometry because depth is unrecoverable from a 2D image
//   C) the colour channel is exact, and a box/colour disagreement survives as an
//      uncertainty instead of being averaged away
//   D) every rejection path: malformed reply, unknown frame, missing locator,
//      unknown type, claimed nodes, duplicate node set — plus confirm and split
//   E) the confidence discipline: a model reporting 0.99 still lands at 0.70,
//      with its number preserved for routing only
//   F) suggestView is collected from dropped proposals too, and a weak grounding
//      synthesizes one — this is what round 2 aims itself with
//   G) shot selection and ONE whole round with plan/capture/propose all faked —
//      no browser, no model — plus resume semantics over a reopened record
//   G3) a confirm of an id the manifest has never heard of is re-routed to a
//      grounded candidate (the mesh geometry found nothing in), and a confirm may
//      only ever LIFT a record — never demote one physics already auto-accepted
//   G4) a project reload mid-campaign aborts at every phase boundary, with the
//      manifest provably untouched and not one further frame spent
//   G5) the omni survey tier is FORCED: four orthogonal eye-level side looks plus
//      a true top and a true bottom, paid for before masks and ghosts, inside the
//      hard frame cap
//   G6) every frame is annotated with the fov, the machine's real extent and the
//      screen-axis mapping it was drawn in — and with NO mapping rather than a
//      guessed one when the basis is unavailable
//   G7) an INDEPENDENT lane does not inherit another producer's guesses: a machine
//      guess stops blocking its parts, agreement becomes corroboration, and only a
//      HUMAN verdict stays off-limits
//   G8) two producer lanes run concurrently against clones and are reconciled by
//      NODE SET into one writer — same parts corroborate, disjoint parts coexist
//   G9) the category prior aims the camera and supplies a count to falsify, and
//      has NO path into the manifest: a guess can never become a joint
//   G10) expectation HINTS: the localization turn's per-part boxes land as hinted
//      candidates through the same gate (a missing axis is announced, never
//      invented), the battery — not the hint — disposes of a cabin-swallowing
//      scope, extras stay gated, and a tighter hint SUPERSEDES the geometry
//      record it overlaps unless a human has verdicted it
//   H) every failure path bails with the manifest provably untouched, and an
//      empty reply counts as success rather than as a crash
//   I) the model's reasoning and doubts survive the trip to the wire the UI reads
//
// Usage: node test/verify-vision.mjs
import { parseGlb } from '../src/lib/gltf.mjs';
import { makeCamera, modelRadius, namedIndex, nodeBox, planViews, rectOf, renderTargets, VIEWPORT } from '../src/plugins/discovery/views.mjs';
import {
  cloudAnchor, cloudAxis, HINT_GATE_PROFILE, visionPropose, L2_VISION_BASE_CONFIDENCE,
} from '../src/plugins/discovery/vision-propose.mjs';
import {
  buildVisionPrompt, frameLine, sceneFacts, screenAxes,
} from '../src/plugins/discovery/vision-prompt.mjs';
import {
  isHintRecord, MAX_EXTRA_VIEWS, MAX_VISION_ROUNDS, reconcileLanes, runProducerLanes,
  runVisionCampaign, runVisionRound, selectShots, SHOT_BUDGET,
} from '../src/plugins/discovery/loop.mjs';
import {
  buildExpectationPrompt, expectationGap, expectationIsUsable, isExpectationPrompt,
  MAX_INSTANCE_COUNT, parseExpectation, surveyPhotos, verifiedInstances,
} from '../src/plugins/discovery/expectation.mjs';
import { isLocalizationPrompt } from '../src/plugins/discovery/localize.mjs';
import { regionsFromExpectations } from '../src/plugins/discovery/grounding.mjs';
import { frameKey } from '../src/plugins/discovery/observations.mjs';
// The serializer that stands between a merged record and the browser. Importing
// it from the server is safe headlessly: routes/project.mjs pulls in only
// slots.mjs -> src/core/registry.mjs, no Fastify and no I/O at module scope.
import { jointSummary } from '../server/routes/project.mjs';

const GLB = 'samples/drone_dji_inspire3.glb';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}${extra ? ' \u2014 ' + extra : ''}`); } else { fail += 1; console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
};
const J = (o) => JSON.stringify(o);

console.log('\nProving the vision producer\n');

// ---- A) geometry-derived anchor and axis -------------------------------------
{
  // A flat plate: thin in Z. Its least-variance direction IS the spin axis, and
  // this must hold even for ONE box, because a two-blade rotor has only two.
  const plate = new Map([['p', { c: [0, 0, 0], h: [6, 6, 0.15] }]]);
  const ax = cloudAxis(plate, ['p']);
  ok('A: one flat plate yields its normal as the axis',
    !!ax && Math.abs(ax[2]) > 0.99, J(ax?.map((x) => Number(x.toFixed(4)))));

  // Four blades around a hub in the XY plane. Centres alone would be a degenerate
  // cross; the corners of flat blades still resolve Z.
  const disc = new Map([
    ['hub', { c: [0, 0, 0], h: [2, 2, 1] }],
    ['b0', { c: [12, 0, 0], h: [8, 1.2, 0.2] }],
    ['b1', { c: [-12, 0, 0], h: [8, 1.2, 0.2] }],
    ['b2', { c: [0, 12, 0], h: [1.2, 8, 0.2] }],
    ['b3', { c: [0, -12, 0], h: [1.2, 8, 0.2] }],
  ]);
  const dn = ['hub', 'b0', 'b1', 'b2', 'b3'];
  const dax = cloudAxis(disc, dn);
  ok('A: a rotor disc yields the Z spin axis',
    !!dax && Math.abs(dax[2]) > 0.99, J(dax?.map((x) => Number(x.toFixed(4)))));

  // The axis must be reported in the hemisphere the prompt states, never negated.
  ok('A: the derived axis points into the positive hemisphere', dax && dax[2] > 0);

  // A disc in the XZ plane must give Y, proving this is real principal-axis math
  // and not a hardcoded "rotors spin about Z".
  const xz = new Map([
    ['hub', { c: [0, 0, 0], h: [2, 1, 2] }],
    ['b0', { c: [12, 0, 0], h: [8, 0.2, 1.2] }],
    ['b1', { c: [-12, 0, 0], h: [8, 0.2, 1.2] }],
    ['b2', { c: [0, 0, 12], h: [1.2, 0.2, 8] }],
    ['b3', { c: [0, 0, -12], h: [1.2, 0.2, 8] }],
  ]);
  const xax = cloudAxis(xz, ['hub', 'b0', 'b1', 'b2', 'b3']);
  ok('A: a disc in the XZ plane yields the Y axis',
    !!xax && Math.abs(xax[1]) > 0.99, J(xax?.map((x) => Number(x.toFixed(4)))));

  // THE important negative: an isotropic blob has no axis. Returning one here
  // would be a confident wrong spin axis — the worst error this producer can make.
  const blob = new Map([
    ['a', { c: [0, 0, 0], h: [5, 5, 5] }],
    ['b', { c: [9, 3, -4], h: [4, 6, 3] }],
    ['c', { c: [-7, -5, 6], h: [3, 4, 7] }],
  ]);
  ok('A: a blobby cloud yields NO axis rather than a guessed one',
    cloudAxis(blob, ['a', 'b', 'c']) === null);
  ok('A: too few points yields no axis', cloudAxis(plate, []) === null);
  ok('A: unknown names are skipped, not crashed on', cloudAxis(plate, ['nope']) === null);

  // The centroid is the mean of the part centres — including a multi-mesh name,
  // because a group's anchor is the centre of the GROUP, not of one fragment.
  const two = new Map([['x', { c: [10, 0, 0], h: [1, 1, 1] }], ['y', { c: [0, 4, 0], h: [1, 1, 1] }]]);
  const anc = cloudAnchor(two, ['x', 'y']);
  ok('A: the anchor is the centroid of the grounded parts',
    !!anc && Math.abs(anc[0] - 5) < 1e-9 && Math.abs(anc[1] - 2) < 1e-9, J(anc));
  ok('A: an empty grounding yields no anchor', cloudAnchor(two, []) === null);
}

// ---- real model, real plan, real boxes ---------------------------------------
const g = await parseGlb(GLB);
const plan = planViews(g, { maxViews: 4 });
const named = namedIndex(g);
const targets = renderTargets(g);
const nameOfMesh = new Map();
for (const n of targets) {
  const nm = named.get(n.i);
  if (nm && !nameOfMesh.has(nm)) nameOfMesh.set(nm, n);
}

const view = plan.views[0];
const cam = makeCamera(view.pose.eye, view.pose.target);
// The strongest available oracle: the exact rectangle a part really projects to.
// If a box drawn precisely on a part does not ground to that part, resolution is
// broken — no VLM slop involved.
const probeNames = (view.sees || []).filter((nm) => nameOfMesh.has(nm));
const boxOfName = (nm) => {
  const r = rectOf(nodeBox(nameOfMesh.get(nm)), cam);
  return r ? [r.x0 / cam.w, r.y0 / cam.h, r.x1 / cam.w, r.y1 / cam.h] : null;
};

ok('setup: the plan yields parts to point at', probeNames.length > 4,
  `view ${view.id} sees=${view.sees?.length} probeable=${probeNames.length}`);

const subject = probeNames[0];
const other = probeNames.find((nm) => nm !== subject) || probeNames[1];
const third = probeNames.find((nm) => nm !== subject && nm !== other) || probeNames[2];
const subjectBox = boxOfName(subject);
const otherBox = boxOfName(other);

// Frames as the loop will hand them over: stored entries joined to plan poses.
const photoFrame = {
  id: view.id, mode: 'photo', pose: view.pose, spec: view.spec, covers: (view.covers || []).length,
};
const MASK = { '#a1b2c3': subject, '#d4e5f6': other, '#112233': third };
const maskFrame = { ...photoFrame, id: 'm0', mode: 'colorId', colorMap: MASK };

// The claimed record holds TWO nodes, not one. That is deliberate: the gate
// dedupes on node SET before it tests isolation, so a single-node claim would make
// every re-claim of it look like a duplicate and the isolation rule would never be
// reached. A two-node claim lets a one-node proposal trip isolation on its own.
const rec = (over = {}) => ({
  id: 'hinge_claimed', label: 'claimed hinge', type: 'hinge', nodes: [other, third],
  anchor: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, evidence: [],
  confidence: 0.8, origin: 'L1-geometry', tests: [], status: 'auto-accepted', history: [],
  ...over,
});
const manifest = () => [rec()];

// ---- B) a box-only reply ------------------------------------------------------
{
  const reply = J([{
    op: 'new', type: 'rotor', frameId: view.id, regionBox: subjectBox,
    axis: [0, 0, 1], reasoning: 'a hub with radial blades', uncertainties: ['blade count unclear'],
  }]);
  const r = visionPropose({ reply, g, manifest: [], frames: [photoFrame], plan });
  const rec0 = r.records[0];
  ok('B: a box-only reply becomes exactly one candidate record',
    r.records.length === 1 && r.confirms.length === 0, J(r.warnings));
  ok('B: the record is stamped as vision-origin',
    rec0?.origin === 'L2-vision' && rec0?.evidence?.[0] === 'l2-vision', `${rec0?.id} ${rec0?.origin}`);
  ok('B: the grounded node set contains the part the box was drawn on',
    (rec0?.nodes || []).includes(subject), `${rec0?.nodes?.length} nodes, top=${rec0?.nodes?.[0]}`);
  ok('B: the grounding is reported as geometric, not exact',
    rec0?.grounding?.source === 'box', J(rec0?.grounding?.source));
  ok('B: the anchor came from GEOMETRY, because depth is unrecoverable from a 2D image',
    rec0?.anchorSource === 'geometry' && [rec0.anchor.x, rec0.anchor.y, rec0.anchor.z].every(Number.isFinite),
    J(rec0?.anchor));
  // The derived anchor must actually be near the part that was pointed at — where
  // "near" is measured in MODEL RADII, not in units: the grounded set here is the
  // coarse eight-part cap spanning the fuselage, so its centroid can sit a good
  // fraction of the machine away from the part the box was drawn on. What must
  // never happen is an anchor on the far side of the model (or outside it), which
  // is what an absolute number in glTF units cannot tell you across exports.
  const bb = nodeBox(nameOfMesh.get(subject));
  const d = rec0 ? Math.hypot(rec0.anchor.x - bb.c[0], rec0.anchor.y - bb.c[1], rec0.anchor.z - bb.c[2]) : Infinity;
  ok('B: the geometry anchor is near the pointed-at part', d < modelRadius(g),
    `d=${d.toFixed(2)} units = ${(d / modelRadius(g)).toFixed(2)} model radii`);
  ok('B: a reported axis is kept rather than overridden',
    rec0?.axisSource === 'model' && rec0.axis.z === 1);
  ok('B: the model reasoning and its doubts travel onto the record',
    rec0?.reasoning === 'a hub with radial blades'
    && (rec0?.uncertainties || []).some((u) => u.includes('blade count unclear')),
    `${rec0?.uncertainties?.length} uncertainties`);
  ok('B: box-only grounding declares itself geometric in the uncertainties',
    (rec0?.uncertainties || []).some((u) => /box only|geometric/i.test(u)));
  ok('B: the record starts as a candidate at base confidence',
    rec0?.status === 'candidate' && rec0?.confidence === L2_VISION_BASE_CONFIDENCE,
    `conf=${rec0?.confidence}`);
  ok('B: a coarse box is capped, and says so',
    (rec0?.nodes?.length || 0) <= 8
    && (rec0.grounding.candidates > 8 ? (rec0.uncertainties || []).some((u) => u.includes('coarse')) : true),
    `candidates=${rec0?.grounding?.candidates} kept=${rec0?.grounding?.kept}`);

  // No anchor at all, but grounding produced parts: geometry must rescue it.
  const rescued = visionPropose({
    reply: J([{ op: 'new', type: 'rotor', frameId: view.id, regionBox: subjectBox, axis: [0, 0, 1] }]),
    g, manifest: [], frames: [photoFrame], plan,
  });
  ok('B: a missing anchor is synthesized from geometry instead of dropping the proposal',
    rescued.records.length === 1 && rescued.records[0].anchorSource === 'geometry');

  // Neither anchor nor a derivable axis. The anchor is RESCUED by geometry, but
  // this coarse eight-part set spans the fuselage, so its principal axes are not
  // separable and cloudAxis refuses rather than inventing a spin axis.
  const dead = visionPropose({
    reply: J([{ op: 'new', type: 'rotor', frameId: view.id, regionBox: subjectBox }]),
    g, manifest: [], frames: [photoFrame], plan,
  });
  const g0 = dead.grounded[0];
  ok('B: an underivable axis drops the proposal and says the axis was not derivable',
    dead.records.length === 0
    && (g0?.uncertainties || []).some((u) => u.includes('no axis'))
    && (dead.warnings || []).some((w) => w.includes('axis must be')),
    J(dead.warnings));
}

// ---- C) the colour channel ----------------------------------------------------
{
  const r = visionPropose({
    reply: J([{ op: 'new', type: 'rotor', frameId: 'm0', regionColors: ['#A1B2C3'], axis: [0, 0, 1] }]),
    g, manifest: [], frames: [maskFrame], plan,
  });
  const rec0 = r.records[0];
  ok('C: a colour id resolves EXACTLY to its painted node, case-insensitively',
    rec0?.nodes?.length === 1 && rec0.nodes[0] === subject, J(rec0?.nodes));
  ok('C: the grounding source is reported as colour, not geometry',
    rec0?.grounding?.source === 'colorId' && rec0?.grounding?.colors?.[0] === '#a1b2c3',
    J(rec0?.grounding));
  ok('C: an exact colour grounding carries no geometric-doubt uncertainty',
    !(rec0?.uncertainties || []).some((u) => /box only/i.test(u)), J(rec0?.uncertainties));

  // Box and colour present and AGREEING: both channels, no clash reported.
  const agree = visionPropose({
    reply: J([{
      op: 'new', type: 'rotor', frameId: 'm0', regionBox: subjectBox,
      regionColors: ['#a1b2c3'], axis: [0, 0, 1],
    }]),
    g, manifest: [], frames: [maskFrame], plan,
  });
  const a0 = agree.records[0];
  ok('C: agreeing channels are recorded as dual-sourced',
    a0?.grounding?.source === 'colorId+box' && a0?.grounding?.agreement === 'agree',
    J(a0?.grounding?.agreement));
  ok('C: agreement produces no clash uncertainty',
    !(a0?.uncertainties || []).some((u) => /clash|disagree/i.test(u)));

  // THE disagreement case: a box drawn on one part, colours read off another.
  // This must survive as legible evidence, never be averaged into a single answer.
  const clash = visionPropose({
    reply: J([{
      op: 'new', type: 'rotor', frameId: 'm0', regionBox: otherBox,
      regionColors: ['#a1b2c3'], axis: [0, 0, 1],
    }]),
    g, manifest: [], frames: [maskFrame], plan,
  });
  const c0 = clash.records[0];
  ok('C: a box/colour clash is detected and the COLOUR channel wins',
    c0?.grounding?.agreement === 'disagree' && c0?.nodes?.length === 1 && c0.nodes[0] === subject,
    `verdict=${c0?.grounding?.agreement} score=${c0?.grounding?.score} nodes=${J(c0?.nodes)}`);
  ok('C: the clash is carried onto the record as an uncertainty naming both sides',
    (c0?.uncertainties || []).some((u) => u.includes('grounding clash') && u.includes(subject)),
    J(c0?.uncertainties?.[0]));
  ok('C: a clash synthesizes a suggestView for round 2',
    c0?.suggestView?.origin === 'derived' && /disagree/.test(c0.suggestView.reason || ''),
    J(c0?.suggestView));

  // Colours reported against a PHOTO frame: the exact identification is lost.
  // Silently falling back to the box would hide that we threw evidence away.
  const lost = visionPropose({
    reply: J([{ op: 'new', type: 'rotor', frameId: view.id, regionBox: subjectBox, regionColors: ['#a1b2c3'], axis: [0, 0, 1] }]),
    g, manifest: [], frames: [photoFrame], plan,
  });
  ok('C: colours on a non-mask frame are refused loudly, not silently ignored',
    lost.warnings.some((w) => w.includes('regionColors ignored'))
    && (lost.records[0]?.uncertainties || []).some((u) => u.includes('unreadable')),
    J(lost.warnings.filter((w) => w.includes('regionColors'))));

  // A stored frame carries the colour map's FILENAME. Treating that string as a
  // map would resolve every colour to nothing and look like "model found nothing".
  const unloaded = visionPropose({
    reply: J([{ op: 'new', type: 'rotor', frameId: 'm1', regionColors: ['#a1b2c3'], axis: [0, 0, 1] }]),
    g, manifest: [], frames: [{ ...maskFrame, id: 'm1', colorMap: 'observations/r0/m1.colors.json' }], plan,
  });
  ok('C: an unloaded colour table is reported, not read as an empty map',
    unloaded.records.length === 0
    && unloaded.warnings.some((w) => w.includes('was not loaded')),
    J(unloaded.warnings));

  // An unknown colour is a near-miss (antialiasing blends two ids). Approximating
  // it would ground the wrong part, so it must be reported unknown.
  const near = visionPropose({
    reply: J([{ op: 'new', type: 'rotor', frameId: 'm0', regionColors: ['#a1b2c4'], axis: [0, 0, 1] }]),
    g, manifest: [], frames: [maskFrame], plan,
  });
  ok('C: a near-miss colour is unknown rather than approximated',
    near.records.length === 0 && near.warnings.some((w) => w.includes('not painted')),
    J(near.warnings));
}

// ---- D) rejection paths -------------------------------------------------------
{
  const frames = [photoFrame, maskFrame];
  const bad = (reply, m = []) => visionPropose({ reply, g, manifest: m, frames, plan });

  // Two distinct malformations, because they take different branches: an
  // unclosed bracket has no ']' to find, while invalid JSON has one and fails
  // inside JSON.parse. Both must yield nothing and say which happened.
  const unclosed = bad('[{"op": "new", ');
  ok('D: an unclosed reply yields no records and reports no array',
    unclosed.records.length === 0 && unclosed.warnings.some((w) => w.includes('no JSON array')));
  const invalid = bad('[{op: new, type: rotor}]');
  ok('D: invalid JSON yields no records and reports the parse failure',
    invalid.records.length === 0 && invalid.warnings.some((w) => w.includes('JSON parse failed')),
    J(invalid.warnings));
  ok('D: a reply with no array yields no records',
    bad('I cannot see any moving parts.').warnings.some((w) => w.includes('no JSON array')));
  ok('D: a fenced reply still parses',
    bad(`Sure:\n\`\`\`json\n${J([{ op: 'confirm', targetId: 'hinge_claimed', rationale: 'visible' }])}\n\`\`\``, manifest()).confirms.length === 1);

  ok('D: an unknown frameId is refused rather than grounded against another camera',
    (() => { const r = bad(J([{ op: 'new', type: 'rotor', frameId: 'v999', regionBox: subjectBox, axis: [0, 0, 1] }])); return r.records.length === 0 && r.warnings.some((w) => w.includes('unknown frameId')); })());
  ok('D: a locator with no frame is refused',
    (() => { const r = bad(J([{ op: 'new', type: 'rotor', regionBox: subjectBox, axis: [0, 0, 1] }])); return r.records.length === 0 && r.warnings.some((w) => w.includes('not among the frames')); })());
  ok('D: a proposal with no locator at all is refused',
    (() => { const r = bad(J([{ op: 'new', type: 'rotor', frameId: view.id, axis: [0, 0, 1] }])); return r.records.length === 0 && r.grounded[0].uncertainties.some((u) => u.includes('no locator')); })());
  ok('D: an unknown type is refused',
    bad(J([{ op: 'new', type: 'propeller', frameId: 'm0', regionColors: ['#a1b2c3'], axis: [0, 0, 1] }])).warnings.some((w) => w.includes('unknown type')));
  ok('D: an unknown op is refused',
    bad(J([{ op: 'teleport', frameId: 'm0', regionColors: ['#a1b2c3'] }])).warnings.some((w) => w.includes('unknown op')));
  ok('D: merge is refused by the vision producer too',
    bad(J([{ op: 'merge', targetId: 'hinge_claimed', type: 'rotor', frameId: 'm0', regionColors: ['#a1b2c3'], axis: [0, 0, 1] }])).warnings.some((w) => /merge/.test(w)));

  // Isolation: the manifest claims `other` inside a two-node record, so a
  // one-node proposal for it is not a duplicate set — it is a re-claim.
  ok('D: re-claiming an already-claimed node is refused',
    (() => {
      const r = bad(J([{ op: 'new', type: 'rotor', frameId: 'm0', regionColors: ['#d4e5f6'], axis: [0, 0, 1] }]), manifest());
      return r.records.length === 0 && r.warnings.some((w) => w.includes('already-claimed'));
    })());
  // Splitting off the ENTIRE target is refused. Which rule fires depends on
  // ordering — a whole-target split is also an existing node set, so dedupe wins
  // — but either way it must not become a record.
  const split = bad(J([{ op: 'split', targetId: 'hinge_claimed', type: 'rotor', nodeIds: [other, third], axis: [0, 0, 1] }]), manifest());
  ok('D: a split of the WHOLE target is refused, not admitted as a twin',
    split.records.length === 0 && split.warnings.some((w) => /proper subset|duplicate/.test(w)),
    J(split.warnings));
  ok('D: a split reaching outside its target is refused',
    (() => {
      const r = bad(J([{ op: 'split', targetId: 'hinge_claimed', type: 'rotor', nodeIds: [other, subject], axis: [0, 0, 1] }]), manifest());
      return r.records.length === 0 && r.warnings.some((w) => w.includes('split nodes not in'));
    })());

  // Duplicate node set: the same part claimed twice in one reply.
  ok('D: the same node set twice in one reply is deduplicated',
    (() => {
      const p = { op: 'new', type: 'rotor', frameId: 'm0', regionColors: ['#a1b2c3'], axis: [0, 0, 1] };
      const r = bad(J([p, p]), []);
      return r.records.length === 1 && r.warnings.some((w) => w.includes('duplicate'));
    })());
  ok('D: a node set already in the manifest is deduplicated',
    (() => {
      const r = bad(J([{ op: 'new', type: 'rotor', nodeIds: [other, third], axis: [0, 0, 1] }]), manifest());
      return r.records.length === 0 && r.warnings.some((w) => w.includes('duplicate'));
    })());
  ok('D: hallucinated node names are refused',
    bad(J([{ op: 'new', type: 'rotor', nodeIds: ['motor_front_left_1'], axis: [0, 0, 1] }])).warnings.some((w) => w.includes('unknown nodes')));

  // confirm is evidence, not a new record.
  const conf = bad(J([{ op: 'confirm', targetId: 'hinge_claimed', rationale: 'I can see this hinge' }]), manifest());
  ok('D: confirm yields a corroboration and no record',
    conf.records.length === 0 && conf.confirms.length === 1 && conf.confirms[0].targetId === 'hinge_claimed');
  ok('D: confirm against an unknown id is refused',
    bad(J([{ op: 'confirm', targetId: 'nope' }]), manifest()).warnings.some((w) => w.includes('valid targetId')));

  // A split of a MULTI-node target succeeds and carries splitFrom.
  const wide = rec({ id: 'rotor_wide', type: 'rotor', nodes: [subject, other], status: 'needs-verdict', confidence: 0.7 });
  const goodSplit = visionPropose({
    reply: J([{ op: 'split', targetId: 'rotor_wide', type: 'rotor', nodeIds: [subject], axis: [0, 0, 1] }]),
    g, manifest: [wide], frames, plan,
  });
  ok('D: a proper subset split is admitted with splitFrom set',
    goodSplit.records.length === 1 && goodSplit.records[0].splitFrom === 'rotor_wide',
    J(goodSplit.records[0]?.id));

  // More than MAX_PROPOSALS is truncated, and the truncation is reported.
  const many = Array.from({ length: 9 }, (_, i) => ({
    op: 'confirm', targetId: 'hinge_claimed', rationale: `c${i}`,
  }));
  ok('D: an over-long reply is truncated with a warning',
    (() => { const r = bad(J(many), manifest()); return r.confirms.length === 6 && r.warnings.some((w) => w.includes('truncated')); })());
}

// ---- E) the confidence discipline --------------------------------------------
{
  const reply = J([{
    op: 'new', type: 'rotor', frameId: 'm0', regionColors: ['#a1b2c3'], axis: [0, 0, 1],
    confidence: 0.99, certainty: 'absolutely a rotor',
  }]);
  const r = visionPropose({ reply, g, manifest: [], frames: [maskFrame], plan });
  const rec0 = r.records[0];
  ok('E: a model reporting 0.99 still lands at base confidence',
    rec0?.confidence === L2_VISION_BASE_CONFIDENCE, `model said 0.99, record says ${rec0?.confidence}`);
  ok('E: the model number is preserved for ROUTING only',
    rec0?.modelConfidence === 0.99, J(rec0?.modelConfidence));
  ok('E: no producer can write status through extra',
    rec0?.status === 'candidate');
  ok('E: evidence provenance cannot be overwritten by the model',
    rec0?.evidence?.[0] === 'l2-vision' && rec0.evidence.some((e) => e.startsWith('grounded-by:')),
    J(rec0?.evidence));
  ok('E: tests start empty — only the battery may fill them',
    Array.isArray(rec0?.tests) && rec0.tests.length === 0);
  ok('E: the record shape matches the manifest contract',
    ['id', 'label', 'type', 'nodes', 'anchor', 'axis', 'confidence', 'origin', 'tests', 'status', 'history']
      .every((k) => k in rec0), J(Object.keys(rec0 || {})));
  ok('E: a vision id is distinguishable from a text-producer id at a glance',
    /^rotor_vis_0/.test(rec0?.id || ''), rec0?.id);
}

// ---- F) suggestView and round-2 routing --------------------------------------
{
  const frames = [photoFrame, maskFrame];
  const run = (items, m = []) => visionPropose({ reply: J(items), g, manifest: m, frames, plan });

  const modelSv = run([{
    op: 'new', type: 'gimbal', frameId: view.id, regionBox: subjectBox, axis: [1, 0, 0],
    suggestView: { target: 'the camera mount from below', reason: 'the yoke is hidden by the hull' },
  }]);
  ok('F: a model suggestView is passed through and marked as the model\'s',
    modelSv.suggestViews.length === 1 && modelSv.suggestViews[0].origin === 'model'
    && modelSv.suggestViews[0].target.includes('camera mount'),
    J(modelSv.suggestViews[0]));
  ok('F: the suggestView is also attached to the record',
    modelSv.records[0]?.suggestView?.reason?.includes('yoke'));

  // A DROPPED proposal must still contribute its suggestView: a claim that failed
  // grounding is exactly the region worth another frame.
  const dropped = run([{
    op: 'new', type: 'propeller', frameId: view.id, regionBox: subjectBox, axis: [0, 0, 1],
    suggestView: { target: 'front rotor', reason: 'need a closer look' },
  }]);
  ok('F: a dropped proposal still contributes its suggestView',
    dropped.records.length === 0 && dropped.suggestViews.length === 1
    && dropped.suggestViews[0].reason === 'need a closer look');

  // Weak grounding with no model request synthesizes one, so round 2 has a target
  // even when the model was too confident to ask for help.
  const derived = run([{ op: 'new', type: 'rotor', frameId: view.id, regionBox: subjectBox, axis: [0, 0, 1] }]);
  ok('F: box-only grounding synthesizes a suggestView asking for a mask',
    derived.suggestViews[0]?.origin === 'derived' && /colorId/.test(derived.suggestViews[0]?.reason || ''),
    J(derived.suggestViews[0]));

  const exact = run([{ op: 'new', type: 'rotor', frameId: 'm0', regionColors: ['#a1b2c3'], axis: [0, 0, 1] }]);
  ok('F: exact colour grounding needs no further view',
    exact.suggestViews.length === 0 && exact.records.length === 1);

  ok('F: grounded[] reports one entry per proposal including drops',
    (() => {
      const r = run([
        { op: 'new', type: 'rotor', frameId: 'm0', regionColors: ['#a1b2c3'], axis: [0, 0, 1] },
        { op: 'new', type: 'bogus', frameId: 'm0', regionColors: ['#d4e5f6'], axis: [0, 0, 1] },
      ]);
      return r.grounded.length === 2 && r.grounded[0].names.length === 1 && r.grounded[1].names.length === 1 && r.records.length === 1;
    })());

  // A large gap between the model's anchor and the parts it denotes is a signal.
  const farAnchor = run([{
    op: 'new', type: 'rotor', frameId: 'm0', regionColors: ['#a1b2c3'],
    axis: [0, 0, 1], anchor: [9999, 9999, 9999],
  }]);
  ok('F: an anchor far from the parts it denotes is flagged and replaced',
    farAnchor.records[0]?.anchorSource === 'geometry'
    && (farAnchor.records[0]?.uncertainties || []).some((u) => u.includes('centroid')),
    J(farAnchor.records[0]?.modelAnchor));
  ok('F: the model\'s own anchor is retained for comparison',
    farAnchor.records[0]?.modelAnchor?.[0] === 9999);
}

// ---- G) one whole round, fully faked -----------------------------------------
// No browser and no model: plan/capture/propose are all injected. This is the
// proof that the round is a pure function of its effects, which is what makes the
// persisted-run replay claim true rather than aspirational.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const hexOf = (i) => `#${(((i + 1) * 2654435761) % 0xffffff).toString(16).padStart(6, '0')}`;
const bigPlan = planViews(g, { maxViews: 8, allowGhost: true, ghostViews: 2 });

{
  const shots = selectShots(bigPlan.views, { maxFrames: 12, maskPairs: 3, ghostFrames: 2 });
  const of = (m) => shots.filter((s) => s.mode === m);
  ok('G: shots are budgeted, never more than the prompt can carry',
    shots.length > 0 && shots.length <= 12, `${shots.length} of ${bigPlan.views.length} planned views`);

  // STRUCTURAL, never positional. The allocation order is: orientation rings,
  // then the tightest cell mask pairs, then ghosts, then fill. Asserting that
  // shots[0] is a mask would just re-encode the budget constants into the test
  // and break the moment they are retuned.
  const firstMask = shots.findIndex((s) => s.mode === 'colorId');
  ok('G: masks are actually selected out of the planned views',
    firstMask >= 0, `${of('colorId').length} masks of ${shots.length} shots`);
  ok('G: EVERY mask is paired with a CLAY FRAME OF THE SAME POSE',
    of('colorId').every((s) => {
      const i = shots.indexOf(s);
      return i > 0 && shots[i - 1].mode === 'clay' && shots[i - 1].viewId === s.viewId;
    }),
    J(of('colorId').map((s) => `${shots[shots.indexOf(s) - 1]?.viewId}/${shots[shots.indexOf(s) - 1]?.mode}+${s.viewId}/${s.mode}`)));
  ok('G: clay frames sit on the TIGHTEST views and carry no focus',
    of('clay').length > 0
    && of('clay').every((s) => s.view.spec?.kind === 'cell' && s.focusNodes === null),
    J(of('clay').map((s) => `${s.viewId}:${s.view.spec?.kind}:focus=${s.focusNodes}`)));
  ok('G: a pose scoped in clay is not re-shot as a photo in the fill',
    of('clay').every((c) => !of('photo').some((p) => p.viewId === c.viewId)),
    J(of('clay').map((c) => c.viewId)));
  ok('G: EVERY mask carries a focus set, so its legend stays readable',
    of('colorId').every((s) => Array.isArray(s.focusNodes) && s.focusNodes.length > 0),
    J(of('colorId').map((s) => s.focusNodes?.length)));
  // A whole-model ring would paint all ~345 named parts and the legend would be
  // unreadable, which is exactly what makes the "exact" channel inexact.
  ok('G: masks sit on the TIGHTEST views, not on whole-model rings',
    of('colorId').every((s) => s.view.spec?.kind === 'cell'),
    J(of('colorId').map((s) => `${s.viewId}:${s.view.spec?.kind}:sees=${s.focusNodes.length}`)));
  // The load-bearing distinction: `covers` is a NUMBER (newly added names) and
  // `sees` is the ARRAY (everything visible). A focus list built from `covers`
  // is undefined, which silently degrades every mask to an unfocused photo.
  ok('G: a mask focuses on what that view actually SEES, not what it newly covers',
    of('colorId').every((s) => s.focusNodes.length === (s.view.sees || []).length
      && Number.isFinite(s.view.covers)),
    J(of('colorId').map((s) => `sees=${(s.view.sees || []).length} covers=${s.view.covers} focus=${s.focusNodes.length}`)));
  ok('G: EVERY ghost carries a focus set — an unfocused ghost is just a photo',
    of('ghost').every((s) => Array.isArray(s.focusNodes) && s.focusNodes.length > 0),
    J(of('ghost').map((s) => `${s.viewId}:focus=${s.focusNodes?.length}`)));
  ok('G: photos carry no focus, so the model gets full context',
    of('photo').every((s) => s.focusNodes === null));
  ok('G: no pose is photographed twice',
    new Set(of('photo').map((s) => s.viewId)).size === of('photo').length,
    J(of('photo').map((s) => s.viewId)));

  // Only ghosts that SEE something are shootable: captureAt's ghost branch makes
  // inFocus() true for everything when focus is null, so opacity is 0.95 across
  // the model and the "ghost" frame is an ordinary opaque photo.
  const usableGhosts = bigPlan.views.filter((v) => v.mode === 'ghost' && Array.isArray(v.sees) && v.sees.length);
  ok('G: ghost frames are shot when the planner offers usable ones',
    of('ghost').length === Math.min(2, usableGhosts.length),
    `${usableGhosts.length} usable, ${of('ghost').length} shot`);
  const blind = {
    id: 'gBlind', mode: 'ghost', sees: [], covers: 0, marginal: 9,
    pose: { eye: [1, 1, 1], target: [0, 0, 0], up: [0, 1, 0] },
  };
  ok('G: a ghost that sees NOTHING is skipped rather than shot as a fake ghost',
    !selectShots([blind, ...bigPlan.views], { maxFrames: 12, ghostFrames: 1 })
      .some((s) => s.viewId === 'gBlind'));

  const ringCount = bigPlan.views.filter((v) => v.mode !== 'ghost' && v.spec?.kind !== 'cell').length;
  ok('G: the orientation budget puts wide shots first, so the model can localise',
    ringCount < 2 || shots.slice(0, 2).every((s) => s.mode === 'photo' && s.view.spec?.kind !== 'cell'),
    J(shots.slice(0, 3).map((s) => `${s.viewId}:${s.mode}:${s.view.spec?.kind}`)));
  ok('G: a hard frame cap is respected',
    selectShots(bigPlan.views, { maxFrames: 3 }).length === 3);
  ok('G: views with no pose are not shot',
    selectShots([{ id: 'x' }, ...bigPlan.views], { maxFrames: 12 }).every((s) => s.view.pose));
}

// The fake renderer: builds the same colour table captureAt would, from the focus
// set it was handed, and stores it RESOLVED (an object, not a filename).
function makeFakes(replyOf) {
  const calls = { plan: 0, capture: 0, propose: 0, savedPlan: 0, savedFrame: 0, savedReply: 0, savedProposals: 0 };
  const seen = { promptText: null, images: null, proposals: null, reply: null };
  return {
    calls, seen,
    plan: () => { calls.plan += 1; return bigPlan; },
    capture: async (view, mode, focusNodes) => {
      calls.capture += 1;
      const colorMap = {};
      if (mode === 'colorId') (focusNodes || []).forEach((nm, i) => { colorMap[hexOf(i)] = nm; });
      return {
        id: frameKey(view.id, mode), viewId: view.id, mode, pose: view.pose, spec: view.spec,
        // Honest to the real plan shape: `covers` is a NUMBER, `sees` the ARRAY.
        covers: view.covers, sees: view.sees, focus: focusNodes, mediaType: 'image/png',
        dataBase64: PNG, colorMap: mode === 'colorId' ? colorMap : null,
      };
    },
    // Reads the LEGEND back out of the prompt and points at its first colour. That
    // makes this an honest fake: it proves the legend the prompt emits is exactly
    // what grounding can resolve, rather than hardcoding an id that happens to work.
    propose: async (text, images) => {
      calls.propose += 1;
      seen.promptText = text;
      seen.images = images;
      const m = text.match(/LEGEND for "([^"]+)":\s*(#[0-9a-f]{6})=(\S+)/);
      seen.reply = replyOf(m ? { frameId: m[1], color: m[2], name: m[3] } : null, images);
      return { reply: seen.reply, model: 'fake-vlm', ms: 7, mode: 'live' };
    },
    persist: {
      plan: () => { calls.savedPlan += 1; },
      frame: () => { calls.savedFrame += 1; },
      reply: (r) => { calls.savedReply += 1; seen.savedReply = r; },
      proposals: (p) => { calls.savedProposals += 1; seen.proposals = p; },
    },
  };
}

{
  const f = makeFakes((loc) => J([{
    op: 'new', type: 'rotor', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1],
    reasoning: 'a hub with radial blades', uncertainties: ['blade count unclear'],
    suggestView: { target: 'the same rotor from below', reason: 'the hub is hidden'
    },
  }]));
  const joints = [];
  const man = [];
  const res = await runVisionRound(g, joints, man, {
    plan: f.plan, capture: f.capture, propose: f.propose, persist: f.persist,
  });

  ok('G: a faked round completes and merges a candidate',
    res.ok === true && res.added === 1 && man.length === 1, J({ ok: res.ok, added: res.added, reason: res.reason, w: res.warnings.slice(0, 2) }));
  ok('G: the merged record is vision-origin and grounded by exact colour',
    man[0]?.origin === 'L2-vision' && man[0]?.grounding?.source === 'colorId',
    `${man[0]?.id} via ${man[0]?.grounding?.source}`);
  ok('G: the round really captured frames and sent them all to the model',
    res.frames === f.calls.capture && f.calls.capture > 0 && f.seen.images.length === res.frames,
    `${f.calls.capture} captured, ${f.seen.images.length} attached`);
  ok('G: the deterministic battery ran on the proposal',
    man[0]?.tests?.length === 4, J((man[0]?.tests || []).map((t) => `${t.name}:${t.pass}`)));
  ok('G: confidence was disposed by PHYSICS, not by the model',
    [0.7, 0.75, 0.8].includes(man[0]?.confidence) && man[0].modelConfidence === undefined,
    `conf=${man[0]?.confidence}`);
  ok('G: status was derived and pushed onto the joint for the UI',
    ['needs-verdict', 'auto-accepted'].includes(man[0]?.status) && joints[0]?.status === man[0].status,
    `${man[0]?.status}`);
  ok('G: the model reasoning and doubts reached the record',
    !!man[0]?.reasoning && (man[0]?.uncertainties || []).some((u) => u.includes('blade count')));
  ok('G: every stage was persisted',
    f.calls.savedPlan === 1 && f.calls.savedFrame === res.frames && f.calls.savedReply === 1 && f.calls.savedProposals === 1,
    J({ ...f.calls }));
  ok('G: the persisted prompt is the one that was actually sent',
    f.seen.savedReply?.prompt?.text === f.seen.promptText && f.seen.savedReply.reply === f.seen.reply);
  ok('G: suggestView survives the round for round 2 to aim at',
    res.suggestViews.length === 1 && res.suggestViews[0].target.includes('from below'),
    J(res.suggestViews[0]));
  ok('G: the persisted proposals carry the suggestViews and the grounding',
    f.seen.proposals?.suggestViews?.length === 1 && f.seen.proposals?.grounded?.length === 1);
  ok('G: the result reports the plan it used',
    res.views === bigPlan.views.length && res.shots === f.calls.capture && res.coverage != null,
    `views=${res.views} shots=${res.shots} coverage=${res.coverage}`);

  // HUMAN-IN-THE-LOOP: a note queued while the frames rendered is folded into the
  // discovery prompt the model actually receives, and narrated as its own beat. The
  // grounding gate is unchanged — this only adds words to the ask, never a joint.
  const fNote = makeFakes(() => '[]');
  const noteBeats = [];
  await runVisionRound(g, [], [], {
    plan: fNote.plan, capture: fNote.capture, propose: fNote.propose, persist: fNote.persist,
    humanNotes: () => ['ignore the landing gear', 'the gimbal is what matters'],
    emit: (kind, payload) => { if (kind === 'vision:note') noteBeats.push(payload); },
  });
  ok('G: a human note is folded into the vision prompt the model receives',
    typeof fNote.seen.promptText === 'string' && fNote.seen.promptText.includes('HUMAN IN THE LOOP')
    && fNote.seen.promptText.includes('ignore the landing gear')
    && fNote.seen.promptText.includes('the gimbal is what matters'),
    fNote.seen.promptText ? fNote.seen.promptText.slice(-140) : 'no prompt');
  ok('G: the round narrates the folded note as its own beat',
    noteBeats.length === 1 && noteBeats[0].notes.length === 2, J(noteBeats));
  ok('G: the note rides into the persisted prompt too - the audit trail shows what was really sent',
    fNote.seen.savedReply?.prompt?.text === fNote.seen.promptText
    && (fNote.seen.savedReply?.prompt?.text || '').includes('HUMAN IN THE LOOP'));

  // No notes queued -> no block injected: the un-steered prompt is unchanged, which
  // is what keeps every existing vision assertion byte-identical.
  const fPlain = makeFakes(() => '[]');
  await runVisionRound(g, [], [], {
    plan: fPlain.plan, capture: fPlain.capture, propose: fPlain.propose, persist: fPlain.persist,
    humanNotes: () => [],
  });
  ok('G: an empty note queue injects nothing into the vision prompt',
    typeof fPlain.seen.promptText === 'string' && !fPlain.seen.promptText.includes('HUMAN IN THE LOOP'));

  // RESUME SEMANTICS: the manifest must not be rebuilt, so a reopened record
  // keeps its history and its regressed status through a vision round.
  const reopened = rec({
    id: 'gimbal_cam', type: 'gimbal', nodes: [subject], status: 'needs-verdict', confidence: 0.75,
    history: [{ at: 'x', event: 'reopened', test: 'rigidity-gate', note: 'cracked' }],
    tests: [{ name: 'rigidity-gate', pass: false, level: 'fail', detail: 'cracked' }],
  });
  const f2 = makeFakes((loc) => J([{
    op: 'new', type: 'rotor', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1],
  }]));
  const j2 = [{ ...reopened }];
  const m2 = [reopened];
  const res2 = await runVisionRound(g, j2, m2, { plan: f2.plan, capture: f2.capture, propose: f2.propose });
  ok('G: a reopened record survives the round with its history intact',
    res2.ok === true && m2.length === 2 && m2[0].id === 'gimbal_cam'
    && m2[0].history.length === 1 && m2[0].status === 'needs-verdict',
    `${m2.length} records, history=${m2[0]?.history?.length}, status=${m2[0]?.status}`);
}

// ---- G2) the live-progress tap emits the beats in the order the UI animates --
// The 3D theater animates strictly from these kinds, in this order; a reorder or
// a dropped beat would show up as a glyph that never moves or a dashed mark that
// never solidifies. Pin the wire contract headlessly, with no browser and no
// model, exactly like the rest of this file.
{
  const f = makeFakes((loc) => J([{
    op: 'new', type: 'rotor', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1],
  }]));
  const beats = [];
  const res = await runVisionCampaign(g, [], [], {
    plan: f.plan, capture: f.capture, propose: f.propose,
    rounds: 1, extraViews: 0,
    emit: (kind, payload) => beats.push([kind, payload]),
  });
  const kinds = beats.map(([k]) => k);
  const at = (k) => kinds.indexOf(k);
  // Anchors are {x,y,z} objects on manifest records and [x,y,z] arrays on plan
  // poses; the contract the theater relies on is "a finite 3-vector", not a shape.
  const isV3 = (p) => (Array.isArray(p) ? p : [p?.x, p?.y, p?.z]).every((n) => Number.isFinite(n));
  ok('G2: the campaign emitted every beat the theater animates',
    ['vision:round', 'vision:plan', 'vision:ask', 'vision:reply', 'vision:propose', 'vision:verdict']
      .every((k) => kinds.includes(k)),
    J(kinds));
  ok('G2: beats arrive in the order the look-around actually happens',
    at('vision:round') < at('vision:plan') && at('vision:plan') < at('vision:ask')
    && at('vision:ask') < at('vision:reply') && at('vision:reply') < at('vision:propose')
    && at('vision:propose') < at('vision:verdict'), J(kinds));
  const planBeat = beats.find(([k]) => k === 'vision:plan')?.[1];
  ok('G2: vision:plan carries eye+target for every view so the camera path can be drawn',
    (planBeat?.views || []).length > 0
    && planBeat.views.every((v) => isV3(v.eye) && isV3(v.target)),
    J(planBeat?.views?.length));
  const propBeat = beats.find(([k]) => k === 'vision:propose')?.[1];
  ok('G2: vision:propose carries an anchor per entry so a dashed mark can be placed',
    (propBeat?.entries || []).length === 1 && isV3(propBeat.entries[0].anchor),
    J(propBeat?.entries));
  const verdBeat = beats.find(([k]) => k === 'vision:verdict')?.[1];
  ok('G2: vision:verdict names what the battery accepted so marks can solidify',
    res.added === 1 && verdBeat?.added === 1
    && Array.isArray(verdBeat?.proposals) && verdBeat.proposals.length === 1,
    J(verdBeat));
}

// ---- G3) a confirm of a joint the manifest has never heard of -----------------
// The failure this pins: a mesh whose node names are numeric (drone_dji_air3)
// gives the geometry heuristics NOTHING, so the manifest starts empty and every
// rotor the model sees arrives as op:"confirm" of an id it inferred from the
// naming convention. Refusing those for an invalid targetId threw away the only
// evidence on the table and the run reported "0 joints discovered". They are now
// re-routed to `new`, with the trust boundary exactly where it always was:
// grounding resolves the nodes, physics disposes the confidence, a human holds
// the verdict. A confirm of a KNOWN id is unchanged by any of this.
{
  const frames = [photoFrame, maskFrame];
  const run = (items, m = []) => visionPropose({ reply: J(items), g, manifest: m, frames, plan });
  const isV3 = (a) => [a?.x, a?.y, a?.z].every((n) => Number.isFinite(n));

  const known = run([{
    op: 'confirm', targetId: 'hinge_claimed', type: 'hinge', frameId: photoFrame.id,
    regionBox: subjectBox, reasoning: 'I can see this hinge',
  }], manifest());
  ok('G3: a confirm of a KNOWN id stays a corroboration and creates no record',
    known.records.length === 0 && known.confirms.length === 1
    && known.confirms[0].targetId === 'hinge_claimed',
    J({ records: known.records.length, confirms: known.confirms.length }));

  // The air3 reply verbatim in shape: an EMPTY manifest, a box, no axis, no
  // anchor, and a targetId nobody issued.
  const orphan = run([{
    op: 'confirm', targetId: 'rotor_br_0', type: 'rotor', frameId: photoFrame.id,
    regionBox: subjectBox,
    reasoning: 'two blades bolted to a finned motor bell at the end of an arm',
    uncertainties: ['left/right labelling assumes screen-right is +X'],
  }]);
  const conv = orphan.records[0];
  ok('G3: a confirm of an UNKNOWN id becomes a grounded candidate instead of being dropped',
    orphan.records.length === 1 && orphan.confirms.length === 0,
    J({ records: orphan.records.length, confirms: orphan.confirms.length, w: orphan.warnings.slice(0, 2) }));
  ok('G3: the converted record keeps the id the model invented as provenance',
    (conv?.evidence || []).includes('confirm-converted:rotor_br_0'), J(conv?.evidence));
  ok('G3: the converted record states the doubt about its own origin and keeps the doubts the model declared',
    (conv?.uncertainties || []).some((u) => u.includes('not in the current joint map'))
    && (conv?.uncertainties || []).some((u) => u.includes('screen-right')),
    J(conv?.uncertainties?.slice(0, 3)));
  ok('G3: the converted record is grounded from its REGION, never from the invented name',
    conv?.origin === 'L2-vision' && (conv?.nodes || []).includes(subject)
    && conv?.grounding?.source === 'box' && conv?.id !== 'rotor_br_0',
    `${conv?.id} via ${conv?.grounding?.source} (${conv?.nodes?.length} node(s))`);
  ok('G3: the axis it was never asked for comes from geometry or from a stated convention',
    isV3(conv?.axis) && ['geometry', 'convention'].includes(conv?.axisSource) && isV3(conv?.anchor),
    `axis=${conv?.axisSource} anchor=${conv?.anchorSource}`);
  ok('G3: confidence is still disposed by physics, never by the model',
    conv?.confidence === L2_VISION_BASE_CONFIDENCE && conv?.modelConfidence === undefined,
    `conf=${conv?.confidence}`);

  // Conversion re-routes EVIDENCE; it is not a licence to invent a joint from an
  // id alone. With nothing to ground, the old refusal still stands.
  const locatorless = run([{ op: 'confirm', targetId: 'rotor_fl_3' }]);
  ok('G3: a locator-less confirm of an unknown id is still refused',
    locatorless.records.length === 0 && locatorless.confirms.length === 0
    && locatorless.warnings.some((w) => w.includes('valid targetId')),
    J(locatorless.warnings.slice(0, 1)));
}

// A corroboration may only ever LIFT. Revision r1 of the air3 run showed the
// opposite: rotors geometry had auto-accepted came back from the model as
// confirms and were CAPPED below the auto-accept line, demoting them to
// needs-verdict. The cap exists so no number of model agreements can cross that
// line by itself — it must never pull a record back below a line physics lifted
// it over.
{
  const strong = rec({
    id: 'rotor_fr_1', type: 'rotor', nodes: [subject], confidence: 0.9, status: 'auto-accepted',
    tests: [{ name: 'isolation', pass: true, level: 'fail', detail: 'clean' }],
  });
  const weak = rec({
    id: 'rotor_bl_2', type: 'rotor', nodes: [other], confidence: 0.7, status: 'needs-verdict', tests: [],
  });
  const f = makeFakes(() => J([
    { op: 'confirm', targetId: 'rotor_fr_1', reasoning: 'two blades on a finned motor bell' },
    { op: 'confirm', targetId: 'rotor_bl_2', reasoning: 'the same construction on the other arm' },
  ]));
  const man = [strong, weak];
  const res = await runVisionRound(g, [{ ...strong }, { ...weak }], man, {
    plan: f.plan, capture: f.capture, propose: f.propose,
  });
  ok('G3: a confirm never DEMOTES a record physics already auto-accepted',
    res.ok === true && res.added === 0 && res.confirms === 2
    && strong.confidence === 0.9 && strong.status === 'auto-accepted'
    && strong.evidence.includes('l2-vision-confirm'),
    `conf=${strong.confidence} status=${strong.status} ev=${J(strong.evidence)}`);
  ok('G3: a confirm still LIFTS a record below the line, but not across it',
    weak.confidence === 0.75 && weak.status === 'needs-verdict'
    && weak.evidence.includes('l2-vision-confirm'),
    `conf=${weak.confidence} status=${weak.status}`);
}

// ---- G4) a reload mid-campaign stops the spend and merges nothing -------------
// The air3 run also lost a whole campaign to a race: frames were rendered and a
// reply merged into arrays belonging to a project that no longer existed, then
// the NEW (empty) manifest was saved while the log reported "+1 record" — a
// success message about nothing. An abort predicate lets the caller say "the
// project you were handed is gone" at every phase boundary: before a round
// starts, before each frame is rendered, and before the model is asked.
{
  const f = makeFakes((loc) => J([{
    op: 'new', type: 'rotor', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1],
  }]));
  const man = [];
  const res = await runVisionRound(g, [], man, {
    plan: f.plan, capture: f.capture, propose: f.propose, abort: () => true,
  });
  ok('G4: an aborted round refuses before spending a single frame or turn',
    res.ok === false && res.code === 'PROJECT_RELOADED' && res.manifestUntouched === true
    && f.calls.capture === 0 && f.calls.propose === 0 && man.length === 0,
    `${res.code} — rendered=${f.calls.capture} turns=${f.calls.propose}`);

  // An abort that lands MID-capture must stop the remaining frames as well:
  // a reload halfway through a 12-frame budget should not render 10 more.
  const f2 = makeFakes(() => '[]');
  let rendered = 0;
  const res2 = await runVisionRound(g, [], [], {
    plan: f2.plan,
    capture: async (v, m, focus) => { rendered += 1; return f2.capture(v, m, focus); },
    propose: f2.propose,
    abort: () => rendered >= 2,
  });
  ok('G4: an abort mid-capture stops the remaining frames and never asks the model',
    res2.ok === false && res2.code === 'PROJECT_RELOADED' && res2.manifestUntouched === true
    && rendered === 2 && f2.calls.propose === 0,
    `rendered=${rendered} turns=${f2.calls.propose} — ${res2.reason}`);

  // Campaign level: round 1 merges, then the project changes, so round 2 must
  // not be started at all — no second plan, no second batch of frames.
  const f3 = makeFakes((loc) => J([{
    op: 'new', type: 'rotor', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1],
    uncertainties: ['blade count unclear'],
    suggestView: { target: 'the same rotor from below', reason: 'the hub is hidden' },
  }]));
  const man3 = [];
  let reloaded = false;
  const res3 = await runVisionCampaign(g, [], man3, {
    plan: f3.plan, capture: f3.capture, propose: f3.propose,
    rounds: 2, extraViews: 2, abort: () => reloaded,
    emit: (kind) => { if (kind === 'vision:verdict') reloaded = true; },
  });
  ok('G4: a campaign whose project changed starts no further round and says why',
    res3.code === 'PROJECT_RELOADED' && res3.roundCount === 1 && f3.calls.plan === 1
    && res3.stop.includes('reloaded') && man3.length === 1,
    J({ code: res3.code, rounds: res3.roundCount, plans: f3.calls.plan, stop: res3.stop, man: man3.length }));
}

// ---- G5) the omni survey tier is forced, not chosen ---------------------------
// The machine type is unknown before the first frame is rendered, so the only
// honest opening move is to look at the WHOLE thing from every side, including
// the two directions a coverage-greedy ring never picks: straight down and
// straight up. Those six frames are bought before anything else, and the budget
// for them comes out of the mask/ghost allowance rather than out of the cap.
{
  const surveys = bigPlan.views.filter((v) => v.spec?.kind === 'survey');
  ok('G5: the planner forces a whole omni survey tier into the plan',
    surveys.length === SHOT_BUDGET.survey && surveys.every((v) => v.mode !== 'ghost'),
    `${surveys.length} survey of ${bigPlan.views.length} planned views`);

  const poles = surveys.map((v) => v.spec.pole || 'side');
  ok('G5: the tier is four EYE-LEVEL side looks plus a TRUE top and a TRUE bottom',
    poles.filter((p) => p === 'side').length === 4 && poles.includes('top') && poles.includes('bottom'),
    J(poles));
  // The six-side orthographic convention: the ring sits on the horizon at azimuths
  // 90° apart, so the frames are front/back/left/right of whatever the machine's
  // own axes turn out to be, and a human can tell which is which without being
  // told where the camera stood.
  ok('G5: the four side looks are ORTHOGONAL - elevation 0, azimuths 90\u00b0 apart',
    surveys.filter((v) => !v.spec.pole).every((v) => v.spec.elevation === 0)
    && [...new Set(surveys.filter((v) => !v.spec.pole).map((v) => v.spec.azimuth))].sort((a, b) => a - b).join() === '0,90,180,270',
    J(surveys.filter((v) => !v.spec.pole).map((v) => `az${v.spec.azimuth}/el${v.spec.elevation}`)));
  ok('G5: the poles really are at +/-90 elevation, not at the old +/-80 clamp',
    surveys.filter((v) => v.spec.pole).every((v) => Math.abs(v.spec.elevation) === 90),
    J(surveys.filter((v) => v.spec.pole).map((v) => `${v.spec.pole}:${v.spec.elevation}`)));
  ok('G5: every survey frame is fitted to the WHOLE machine, at one shared distance',
    new Set(surveys.map((v) => Math.round(v.spec.distance))).size === 1
    && surveys.every((v) => v.spec.distance > 0),
    J([...new Set(surveys.map((v) => v.spec.distance.toFixed(1)))]));

  const shots = selectShots(bigPlan.views);
  const surveyShots = shots.filter((s) => s.view.spec?.kind === 'survey');
  ok('G5: the whole survey tier is shot, and still fits inside the hard frame cap',
    surveyShots.length === surveys.length && shots.length <= 12,
    `${surveyShots.length} survey frames of ${shots.length} shots (cap 12)`);
  ok('G5: the survey tier is spent FIRST, so nothing else can crowd it out',
    shots.slice(0, surveys.length).every((s) => s.view.spec?.kind === 'survey' && s.mode === 'photo'),
    J(shots.slice(0, surveys.length).map((s) => `${s.viewId}/${s.mode}`)));
  ok('G5: a cap of exactly the tier size yields the survey and NOTHING else',
    (() => {
      const s6 = selectShots(bigPlan.views, { maxFrames: SHOT_BUDGET.survey });
      return s6.length === SHOT_BUDGET.survey && s6.every((s) => s.view.spec?.kind === 'survey');
    })(), J(selectShots(bigPlan.views, { maxFrames: SHOT_BUDGET.survey }).map((s) => s.viewId)));
  ok('G5: when the cap cannot hold both, the survey tier wins over masks and ghosts',
    (() => {
      const s4 = selectShots(bigPlan.views, { maxFrames: 4 });
      return s4.length === 4 && s4.every((s) => s.view.spec?.kind === 'survey');
    })());

  const cells = bigPlan.views.filter((v) => v.spec?.kind === 'cell');
  const masks = shots.filter((s) => s.mode === 'colorId');
  const ghosts = shots.filter((s) => s.mode === 'ghost');
  ok('G5: after the tier is paid for, the retuned budget still buys mask pairs and a ghost',
    masks.length === Math.min(SHOT_BUDGET.maskPairs, cells.length)
    && masks.every((m) => Array.isArray(m.focusNodes) && m.focusNodes.length > 0)
    && ghosts.length <= SHOT_BUDGET.ghostFrames,
    J({ masks: masks.length, cells: cells.length, ghosts: ghosts.length, total: shots.length }));
  ok('G5: no survey frame is masked - a whole-machine legend is unreadable, so the exact channel would not be exact',
    shots.every((s) => !(s.mode === 'colorId' && s.view.spec?.kind === 'survey')),
    J(masks.map((m) => `${m.viewId}:${m.view.spec?.kind}`)));
  ok('G5: coverage is not sacrificed for the tier - the plan still sees essentially every part',
    Number(bigPlan.coverage) >= 0.99, `coverage=${bigPlan.coverage}`);
}

// ---- G6) annotations that remove the model's guesswork ------------------------
// The air3 round's dominant doubt was "left/right labelling assumes screen-right
// is +X". That is not a fact the model should have to assume: we chose the pose,
// we built the basis, and we can simply say so. Same for the fov and for how big
// the machine is, without which "eye distance 163.1 units" is a meaningless number.
{
  const facts = sceneFacts(g, VIEWPORT, bigPlan.views.map((v) => ({ cam: v.cam })));
  ok('G6: the scene facts carry the frame size, the fov, the radius and the extent',
    facts.vp?.w === VIEWPORT.w && facts.vp?.fov === VIEWPORT.fov
    && Number.isFinite(facts.radius) && facts.radius > 0
    && Array.isArray(facts.extent) && facts.extent.length === 3 && facts.extent.every(Number.isFinite),
    J({ vp: facts.vp, radius: +facts.radius.toFixed(1), extent: facts.extent?.map((x) => +x.toFixed(1)) }));

  const photos = bigPlan.views.filter((v) => v.mode !== 'ghost').slice(0, 3);
  const frames = photos.map((v) => ({
    id: frameKey(v.id, 'photo'), viewId: v.id, mode: 'photo', dataBase64: PNG, mediaType: 'image/png',
  }));
  const p = buildVisionPrompt({ manifest: [], frames, plan: bigPlan, g, viewport: VIEWPORT });
  const txt = p.text || '';
  const lineOf = (id) => txt.split('\n').find((l) => l.includes(`"${id}"`) && l.includes('frame ')) || '';

  ok('G6: the prompt states the fov and the frame size once, as a shared scene fact',
    /fov 45/.test(txt) && new RegExp(`frame ${VIEWPORT.w}x${VIEWPORT.h} px`).test(txt));
  ok('G6: the prompt states the machine radius and bounding box, so "eye distance" means something',
    /radius \d+\.\d world units/.test(txt) && /bounding box [\d.]+ x [\d.]+ x [\d.]+/.test(txt),
    J({ radius: +facts.radius.toFixed(1), extent: facts.extent?.map((x) => +x.toFixed(1)) }));
  ok('G6: the prompt says the machine type is UNKNOWN and names what it might be',
    /WE DO NOT KNOW WHAT MACHINE THIS IS/.test(txt) && /ground vehicle/.test(txt) && /aircraft/.test(txt));
  ok('G6: EVERY frame line carries its own screen-axis mapping, fov and pixel size',
    frames.every((f) => {
      const l = lineOf(f.id);
      return /screen-right = /.test(l) && /screen-up = /.test(l) && /fov 45/.test(l) && /1024x1024px/.test(l);
    }), J(frames.map((f) => lineOf(f.id).match(/screen-right = [^,]+, screen-up = \S+/)?.[0])));
  ok('G6: the mapping differs per pose, so it is derived from the basis and not a constant',
    new Set(frames.map((f) => lineOf(f.id).match(/screen-right = [^,]+/)?.[0])).size === frames.length,
    J(frames.map((f) => lineOf(f.id).match(/screen-right = ([^,]+)/)?.[1])));

  // A frame replayed from disk with no plan beside it has no basis. Printing one
  // anyway would be a lie the model believes; omitting it is honest and the
  // grounding still works from the stored pose.
  const bare = buildVisionPrompt({
    manifest: [], frames: frames.map((f) => ({ ...f, viewId: 'no-such-view' })),
    plan: { views: [] }, g: null, viewport: null,
  });
  ok('G6: with no basis available the annotation is OMITTED rather than guessed',
    !!bare.text && !/screen-right/.test(bare.text) && !/SCENE \(every frame/.test(bare.text),
    J(bare.text?.split('\n').filter((l) => /frame 1 =/.test(l))[0]?.slice(0, 90)));

  const poleOf = (pk) => bigPlan.views.find((v) => v.spec?.pole === pk);
  const basisOk = (c) => {
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return [...c.r, ...c.u, ...c.f].every(Number.isFinite)
      && [c.r, c.u, c.f].every((v) => Math.abs(Math.hypot(...v) - 1) < 1e-9)
      && Math.abs(dot(c.r, c.u)) < 1e-9 && Math.abs(dot(c.r, c.f)) < 1e-9 && Math.abs(dot(c.u, c.f)) < 1e-9;
  };
  ok('G6: both true poles have a finite, orthonormal basis - the up override did its job',
    ['top', 'bottom'].every((pk) => { const v = poleOf(pk); return !!v && basisOk(v.cam); }),
    J(['top', 'bottom'].map((pk) => `${pk}:${screenAxes(poleOf(pk)?.cam)}`)));
  ok('G6: the bottom look is genuinely flipped, not the top look relabelled',
    screenAxes(poleOf('top').cam) !== screenAxes(poleOf('bottom').cam)
    && /screen-up = -/.test(screenAxes(poleOf('bottom').cam)));

  const fl = (v) => frameLine({ id: v.id, mode: 'photo', spec: v.spec, cam: v.cam, covers: v.covers }, 0);
  // The survey ring is eye-level now (SURVEY_ELEVATION = 0), so the words printed
  // for it must say so: a frame the model believes is a top-down look is a frame
  // it will draw a regionBox on as though the hull were not in the way.
  ok('G6: an eye-level survey frame is announced as a SIDE view, never as a pole',
    /eye-level orthogonal side view/.test(lineOf(frames[0].id))
    && /elevation 0\u00b0/.test(lineOf(frames[0].id))
    && !/top-down|bottom-up/.test(lineOf(frames[0].id)),
    lineOf(frames[0].id).slice(0, 140));
  ok('G6: the pole frames are announced as the poles they really are',
    /true top-down/.test(fl(poleOf('top'))) && /true bottom-up/.test(fl(poleOf('bottom'))));
}

// ---- G7) an independent lane inherits nothing ---------------------------------
// Two producers that can read each other are one producer with an echo: the air3
// round spent four of its five proposals agreeing with ids another pass had
// invented. So the automatic lane is run blind to the other's conclusions - and
// the one thing it is still told is what a HUMAN settled, because a person is not
// a producer and their verdict is not a guess.
{
  const autoGuess = rec();                                        // nodes [other, third], auto-accepted
  const humanVerdict = rec({ id: 'hinge_by_human', status: 'confirmed', verdict: { ok: true } });
  // A DIFFERENT node set that overlaps one claimed node: this is the case the
  // claimed-set narrowing decides. An identical set is handled by the dedupe below.
  const overlap = J([{ op: 'new', type: 'rotor', frameId: 'm0', regionColors: ['#a1b2c3', '#d4e5f6'], axis: [0, 0, 1] }]);
  const sameSet = J([{ op: 'new', type: 'rotor', frameId: 'm0', regionColors: ['#d4e5f6', '#112233'], axis: [0, 0, 1] }]);
  const run = (reply, man, independent) => visionPropose({
    reply, g, manifest: man, frames: [maskFrame], plan, independent,
  });

  const dep = run(overlap, [autoGuess], false);
  const ind = run(overlap, [autoGuess], true);
  ok('G7: a dependent lane is blocked by another machine\'s guess over one shared part',
    dep.records.length === 0 && dep.warnings.some((w) => /already-claimed nodes/.test(w)),
    J(dep.warnings.slice(0, 1)));
  ok('G7: an INDEPENDENT lane proposes the same parts freely - a guess is not a claim',
    ind.records.length === 1 && ind.records[0].origin === 'L2-vision'
    && !ind.warnings.some((w) => /already-claimed nodes/.test(w)),
    J({ records: ind.records.map((r) => `${r.id}:${r.nodes.length}`), w: ind.warnings.slice(0, 1) }));

  const depSame = run(sameSet, [autoGuess], false);
  const indSame = run(sameSet, [autoGuess], true);
  ok('G7: agreement on the SAME parts is a duplicate to a dependent lane ...',
    depSame.records.length === 0 && depSame.confirms.length === 0
    && depSame.warnings.some((w) => /duplicate of an existing record/.test(w)),
    J(depSame.warnings.slice(0, 1)));
  ok('G7: ... and is CORROBORATION to an independent lane, never a second record',
    indSame.records.length === 0 && indSame.confirms.length === 1
    && indSame.confirms[0].targetId === autoGuess.id
    && indSame.confirms[0].tag === 'cross-producer:L2-vision',
    J(indSame.confirms));

  ok('G7: a HUMAN verdict still blocks an independent lane - independence is from machines, not from people',
    run(overlap, [humanVerdict], true).records.length === 0
    && run(overlap, [humanVerdict], true).warnings.some((w) => /already-claimed nodes/.test(w)),
    J(run(overlap, [humanVerdict], true).warnings.slice(0, 1)));
  ok('G7: and agreeing with a human verdict can never mint a competing record either',
    run(sameSet, [humanVerdict], true).records.length === 0);

  const depP = buildVisionPrompt({ manifest: [autoGuess, humanVerdict], frames: [photoFrame], plan, g, viewport: VIEWPORT });
  const indP = buildVisionPrompt({ manifest: [autoGuess, humanVerdict], frames: [photoFrame], plan, g, viewport: VIEWPORT, independent: true });
  ok('G7: the independent prompt withholds the machine guess and lists only what a human settled',
    /VALIDATED CONSTRAINTS/.test(depP.text) && depP.text.includes(autoGuess.id)
    && /HUMAN-CONFIRMED CONSTRAINTS/.test(indP.text) && indP.text.includes(humanVerdict.id)
    && !indP.text.includes(autoGuess.id),
    J({ dep: depP.text.split('\n').filter((l) => /CONSTRAINTS/.test(l))[0], ind: indP.text.split('\n').filter((l) => /CONSTRAINTS/.test(l))[0] }));
  ok('G7: the independent prompt says it is being kept in the dark, and why',
    /INDEPENDENT OBSERVER/.test(indP.text) && /WITHHELD/.test(indP.text) && !/INDEPENDENT OBSERVER/.test(depP.text));

  // The shape a FAILED geometry pass is adopted into: an empty manifest, not a
  // refusal. air3 legitimately yields zero joints from numeric node names, and a
  // lane that would not look without a baseline is a lane that cannot help there.
  const fInd = makeFakes((loc) => J([{
    op: 'new', type: 'rotor', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1],
  }]));
  const manInd = [];
  const resInd = await runVisionRound(g, [], manInd, {
    plan: fInd.plan, capture: fInd.capture, propose: fInd.propose, independent: true,
  });
  ok('G7: an independent lane runs against an EMPTY manifest and still finds a joint',
    resInd.ok === true && resInd.added === 1 && manInd[0]?.origin === 'L2-vision'
    && /INDEPENDENT OBSERVER/.test(fInd.seen.promptText || ''),
    J({ ok: resInd.ok, added: resInd.added, man: manInd.length }));
  ok('G7: a NULL manifest is not an error to the prompt builder or to the gate - there is simply nothing to inherit',
    (() => {
      const np = buildVisionPrompt({ manifest: null, frames: [photoFrame], plan, g, viewport: VIEWPORT, independent: true });
      const nv = visionPropose({ reply: sameSet, g, manifest: null, frames: [maskFrame], plan, independent: true });
      return !!np.text && Array.isArray(nv.records) && nv.records.length === 1;
    })());
  ok('G7: the round still refuses when there is no array to merge into - adoption is the CALLER\'s decision',
    (await runVisionRound(g, [], null, { plan: fInd.plan, capture: fInd.capture, propose: fInd.propose })).code === 'NO_MANIFEST');
}

// ---- G8) two producer lanes, one writer ---------------------------------------
// Independence and a single writer pull in opposite directions: a producer shown
// the other's output agrees with it, and two lanes merging into one array
// concurrently would interleave the battery, the node-set dedupe and the id
// allocation. So each lane runs against a CLONE, the clones are diffed, and the
// deltas are applied serially through the one code path that writes a record.
{
  const mkRec = (id, origin, nodes, type = 'rotor') => ({
    id, label: `${type} (${origin})`, type, nodes: [...nodes],
    anchor: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 },
    evidence: [origin === 'L2-vision' ? 'l2-vision' : 'l2-batch'],
    confidence: 0.7, origin, tests: [], status: 'needs-verdict', history: [],
  });

  const held = [mkRec('rotor_a', 'L1-geometry', [subject])];
  const same = reconcileLanes(held, {
    records: [mkRec('vis_rotor', 'L2-vision', [subject])], confirms: [],
  }, { origin: 'L2-vision' });
  ok('G8: the same node set from a second producer becomes corroboration, not a second record',
    same.records.length === 0 && same.confirms.length === 1
    && same.confirms[0].targetId === 'rotor_a' && same.confirms[0].tag === 'cross-producer:L2-vision'
    && same.agreed.length === 1 && same.agreed[0].discardedId === 'vis_rotor', J(same.agreed));
  ok('G8: identity is the node SET - neither order nor naming can turn one part into two joints',
    (() => {
      const r = reconcileLanes([mkRec('r_ab', 'L1-geometry', [subject, other])],
        { records: [mkRec('v_ba', 'L2-vision', [other, subject])] }, { origin: 'L2-vision' });
      return r.records.length === 0 && r.agreed.length === 1;
    })());
  ok('G8: a DISJOINT node set is admitted as its own record - agreement is not a precondition',
    (() => {
      const r = reconcileLanes(held, { records: [mkRec('vis_rotor', 'L2-vision', [other, third])] }, { origin: 'L2-vision' });
      return r.records.length === 1 && r.records[0].id === 'vis_rotor' && r.confirms.length === 0 && r.agreed.length === 0;
    })());
  ok('G8: an OVERLAPPING claim is the same part seen twice - it corroborates, never duplicates',
    (() => {
      // the geometry lane held the whole rigid cluster; the vision lane grounded a
      // subset of it (as it does in the wild: 8 of a rotor's 15 nodes)
      const big = [mkRec('rotor_big', 'L1-geometry', [subject, other, third, 'bolt_x', 'bolt_y'])];
      const r = reconcileLanes(big, { records: [mkRec('vis_sub', 'L2-vision', [subject, other, third])] }, { origin: 'L2-vision' });
      return r.records.length === 0 && r.agreed.length === 1 && r.agreed[0].id === 'rotor_big'
        && r.agreed[0].match === 'overlap' && r.agreed[0].containment === 1
        && r.confirms.length === 1 && r.confirms[0].tag === 'cross-producer:L2-vision';
    })(), J(reconcileLanes([mkRec('rotor_big', 'L1-geometry', [subject, other, third])],
      { records: [mkRec('vis_sub', 'L2-vision', [subject, other])] }, { origin: 'L2-vision' }).agreed));
  ok('G8: a partial overlap below the floor is NOT merged - a brush is not an agreement',
    (() => {
      // 2 of 4 shared = 0.5 containment of the smaller claim -> merged; 1 of 4 = 0.25 -> not
      const arm = [mkRec('arm_a', 'L1-geometry', [subject, other, third, 'bolt_z'])];
      const brushed = reconcileLanes(arm, { records: [mkRec('vis_arm', 'L2-vision', [subject, 'p', 'q', 'r'])] }, { origin: 'L2-vision' });
      return brushed.records.length === 1 && brushed.records[0].id === 'vis_arm' && brushed.agreed.length === 0;
    })());
  ok('G8: the lane-only nodes of an overlap merge are reported, and the kept set is unchanged',
    (() => {
      const big = [mkRec('rotor_big', 'L1-geometry', [subject, other, third])];
      const r = reconcileLanes(big, { records: [mkRec('vis_off', 'L2-vision', [subject, other, 'extra_node'])] }, { origin: 'L2-vision' });
      return r.records.length === 0 && r.agreed[0].laneOnly.length === 1 && r.agreed[0].laneOnly[0] === 'extra_node'
        && big[0].nodes.length === 3 && big[0].nodes.includes('extra_node') === false;
    })());
  ok('G8: a TYPE disagreement between producers is reported, never silently resolved',
    (() => {
      const r = reconcileLanes([mkRec('gim_x', 'L1-geometry', [subject], 'gimbal')],
        { records: [mkRec('vis_x', 'L2-vision', [subject], 'rotor')] }, { origin: 'L2-vision' });
      return r.records.length === 0 && r.agreed[0]?.typeMismatch?.kept === 'gimbal' && r.agreed[0].typeMismatch.lane === 'rotor';
    })(), J(reconcileLanes([mkRec('gim_x', 'L1-geometry', [subject], 'gimbal')],
      { records: [mkRec('vis_x', 'L2-vision', [subject], 'rotor')] }, { origin: 'L2-vision' }).agreed[0]?.typeMismatch));
  ok('G8: one lane claiming the same parts twice is reconciled against ITSELF, not admitted twice',
    (() => {
      const r = reconcileLanes([], { records: [mkRec('a', 'L2-vision', [subject]), mkRec('b', 'L2-vision', [subject])] }, { origin: 'L2-vision' });
      return r.records.length === 1 && r.agreed.length === 1;
    })());
  ok('G8: a confirm a lane produced itself is carried across untouched, and a record with no nodes cannot enter',
    reconcileLanes(held, { records: [mkRec('empty', 'L2-vision', [])], confirms: [{ targetId: 'rotor_a', tag: 'l2-vision-confirm' }] }, { origin: 'L2-vision' }).confirms.length === 1
    && reconcileLanes(held, { records: [mkRec('empty', 'L2-vision', [])] }, { origin: 'L2-vision' }).records.length === 0);

  const real = [];
  const beats = [];
  const laneRes = await runProducerLanes(g, [], real, {
    text: async (m) => { m.push(mkRec('text_rotor', 'L2-ai', [subject])); return { ok: true, added: 1 }; },
    vision: async (m) => {
      m.push(mkRec('vis_rotor', 'L2-vision', [subject]));
      return { ok: true, added: 1, frames: 11, expectation: { category: 'quadrotor drone' }, gaps: [{ type: 'rotor', expected: 4, found: 1, missing: 3 }] };
    },
    emit: (kind, payload) => beats.push({ kind, payload }),
  });
  ok('G8: two producers that found the SAME part leave ONE record in the real manifest',
    real.length === 1 && laneRes.added === 1 && laneRes.agreed.length === 1
    && laneRes.lanes.text?.merged === 1 && laneRes.lanes.vision?.merged === 0
    && laneRes.lanes.vision?.corroborated === 1,
    J({ real: real.map((r) => r.id), added: laneRes.added, text: laneRes.lanes.text?.merged, vision: laneRes.lanes.vision?.merged }));
  ok('G8: the survivor carries the other lane\'s corroboration in its own evidence trail',
    (real[0]?.evidence || []).some((t) => /cross-producer:L2-vision/.test(t)), J(real[0]?.evidence));

  const solo = [];
  await runProducerLanes(g, [], solo, {
    text: async (m) => { m.push(mkRec('text_rotor', 'L2-ai', [subject])); return { ok: true }; },
  });
  ok('G8: agreement between producers can only LIFT a record - never demote one physics already disposed of',
    real.length === 1 && solo.length === 1 && real[0].confidence >= solo[0].confidence,
    `corroborated=${real[0]?.confidence?.toFixed(3)} alone=${solo[0]?.confidence?.toFixed(3)}`);

  ok('G8: each lane announces its own merge on the beat wire, and only its own',
    beats.filter((b) => b.kind === 'lane:merged').length === 2
    && beats.some((b) => b.kind === 'lane:merged' && b.payload.lane === 'text' && b.payload.origin === 'L2-ai')
    && beats.some((b) => b.kind === 'lane:merged' && b.payload.lane === 'vision' && b.payload.corroborated === 1),
    J(beats.map((b) => b.kind)));
  ok('G8: the category prior rides on the VISION lane\'s result and never on the text lane\'s - that is what keeps them independent',
    laneRes.lanes.vision?.expectation?.category === 'quadrotor drone'
    && Array.isArray(laneRes.lanes.vision?.gaps)
    && laneRes.lanes.text?.expectation == null && laneRes.lanes.text?.gaps == null,
    J({ vision: laneRes.lanes.vision?.expectation?.category, text: laneRes.lanes.text?.expectation }));

  const seenBy = {};
  await runProducerLanes(g, [], [], {
    text: async (m) => {
      seenBy.textAtStart = m.length;
      m.push(mkRec('t', 'L2-ai', [subject]));
      await new Promise((r) => setTimeout(r, 6));
      seenBy.textAtEnd = m.length;
      return { ok: true };
    },
    vision: async (m) => {
      seenBy.visionAtStart = m.length;
      m.push(mkRec('v', 'L2-vision', [other]));
      await new Promise((r) => setTimeout(r, 1));
      seenBy.visionAtEnd = m.length;
      return { ok: true };
    },
  });
  ok('G8: neither lane can see the other\'s writes, so agreement between them is real agreement',
    seenBy.textAtStart === 0 && seenBy.visionAtStart === 0 && seenBy.textAtEnd === 1 && seenBy.visionAtEnd === 1,
    J(seenBy));

  const mixed = [];
  const resMixed = await runProducerLanes(g, [], mixed, {
    text: async () => { throw new Error('the text provider is not configured'); },
    vision: async (m) => { m.push(mkRec('vis_rotor', 'L2-vision', [other, third])); return { ok: true }; },
  });
  ok('G8: a lane that THROWS does not take the other down - one producer being absent is the normal case',
    resMixed.lanes.text?.ok === false && /not configured/.test(resMixed.lanes.text?.error || '')
    && resMixed.lanes.vision?.merged === 1 && mixed.length === 1
    && resMixed.warnings.some((w) => /the text lane failed/.test(w)),
    J({ text: resMixed.lanes.text, vision: resMixed.lanes.vision?.merged }));

  const two = [];
  const resTwo = await runProducerLanes(g, [], two, {
    text: async (m) => { m.push(mkRec('text_gimbal', 'L2-ai', [subject], 'gimbal')); return { ok: true }; },
    vision: async (m) => { m.push(mkRec('vis_rotor', 'L2-vision', [other, third])); return { ok: true }; },
  });
  ok('G8: disjoint findings from both lanes coexist - independence must not cost a discovery',
    two.length === 2 && resTwo.added === 2 && resTwo.agreed.length === 0
    && new Set(resTwo.proposals).size === 2,
    J(two.map((r) => `${r.id}:${r.type}:${r.status}`)));
  ok('G8: no manifest to merge into is refused rather than quietly invented',
    (await runProducerLanes(g, [], null, { text: async () => ({ ok: true }) })).code === 'NO_MANIFEST');
}

// ---- G9) the category prior aims and checks, and NEVER merges ------------------
// Asking what kind of machine this is buys two things: it aims the scarce round-2
// budget at PLACES a machine of that kind keeps its joints, and it supplies a
// COUNT to falsify. What it must never buy is a joint. The boundary is structural
// rather than disciplinary - nothing this lane parses has a path to mergeProposals.
{
  const surveyFrames = bigPlan.views.filter((v) => v.spec?.kind === 'survey').map((v) => ({
    id: frameKey(v.id, 'photo'), viewId: v.id, mode: 'photo', spec: v.spec, cam: v.cam,
    covers: v.covers, dataBase64: PNG, mediaType: 'image/png',
  }));
  const noise = [
    { id: frameKey('v511', 'colorId'), viewId: 'v511', mode: 'colorId', spec: { kind: 'cell' }, dataBase64: PNG },
    { id: frameKey('g0', 'ghost'), viewId: 'g0', mode: 'ghost', spec: { kind: 'ring' }, dataBase64: PNG },
  ];
  const sp = surveyPhotos([...surveyFrames, ...noise]);
  ok('G9: a category is read from whole-machine PHOTOS only - never from a mask or a ghost',
    sp.length === surveyFrames.length && sp.every((f) => f.mode === 'photo' && f.spec?.kind === 'survey'),
    `${sp.length} of ${surveyFrames.length + noise.length} frames offered`);
  ok('G9: with no survey tier it falls back to any photo, and with none of those it offers nothing',
    surveyPhotos(noise).length === 0
    && surveyPhotos([{ ...noise[0], mode: 'photo', spec: { kind: 'cell' } }]).length === 1);

  const ep = buildExpectationPrompt({ frames: [...surveyFrames, ...noise], g, viewport: VIEWPORT });
  ok('G9: the category turn carries its own mark, so a round\'s two turns cannot be confused by counting calls',
    isExpectationPrompt(ep.text) && ep.images.length === surveyFrames.length && ep.frames.every((f) => f.attached),
    `${ep.images.length} attached, ${ep.frames.length} described`);
  ok('G9: the category prompt says plainly that an expectation is NEVER a discovery',
    /NEVER a/.test(ep.text) && /nothing you write here becomes a joint/.test(ep.text));
  // The prior is read off the orthographic six, so the prompt has to SAY that: a
  // model told it is looking at obliques will place an instance's regionBox from
  // the wrong mental camera, and the aim that comes back misses the part.
  ok('G9: the category prompt describes the survey it is really showing - six orthographic looks',
    /six orthographic looks/.test(ep.text) && /eye-level side/.test(ep.text) && !/four oblique/.test(ep.text),
    ep.text.split('\n').filter((l) => /orthographic|eye-level/.test(l)).join(' / ').slice(0, 150));
  ok('G9: the category prompt demands a count, a place, a symmetry, a doubt and an alternative',
    ['count', 'regionBox', 'symmetry', 'doubts', 'alternatives'].every((k) => ep.text.includes(k)));
  ok('G9: it maps an inexpressible motion onto the nearest of the three and forbids a fourth kind',
    /track/.test(ep.text) && /Do not invent a fourth kind/.test(ep.text));
  ok('G9: with no whole-machine photo there is nothing to ask, and the caller is told rather than left to guess',
    (() => { const none = buildExpectationPrompt({ frames: noise, g }); return none.text === null && none.images.length === 0 && none.warnings.length > 0; })(),
    J(buildExpectationPrompt({ frames: noise, g }).warnings));
  ok('G9: the discovery prompt is NOT a category prompt - the two turns are separable from either side',
    !isExpectationPrompt(buildVisionPrompt({ manifest: [], frames: surveyFrames, plan: bigPlan, g, viewport: VIEWPORT }).text));

  const box0 = [0.5, 0.5, 0.8, 0.8];
  const goodReply = J({
    category: 'quadrotor drone', confidence: 0.86,
    summary: 'four lifting rotors at the arm tips and one camera cradle at the nose',
    instances: [
      { type: 'rotor', count: 4, frameId: surveyFrames[0].id, regionBox: box0, symmetry: '4-fold about the vertical, one per arm tip', note: 'propeller and motor bell' },
      { type: 'gimbal', count: 1, frameId: surveyFrames[0].id, regionBox: [0.1, 0.2, 0.3, 0.4], symmetry: 'one at the nose', note: 'camera cradle' },
    ],
    doubts: ['the arm tips are partly occluded in the top view'],
    alternatives: ['a fixed-wing VTOL; a visible wing would settle it'],
  });
  const sentIds = surveyFrames.map((f) => f.id);
  const parsed = parseExpectation(goodReply, { frameIds: sentIds });
  ok('G9: a well-formed prior parses whole - category, confidence, counts, symmetry, doubt and alternative',
    parsed.expectation.category === 'quadrotor drone' && parsed.expectation.confidence === 0.86
    && parsed.expectation.instances.length === 2 && parsed.expectation.instances[0].count === 4
    && /4-fold/.test(parsed.expectation.instances[0].symmetry || '')
    && parsed.expectation.doubts.length === 1 && parsed.expectation.alternatives.length === 1
    && parsed.warnings.length === 0, J(parsed.warnings));
  ok('G9: a fenced reply is still read - being told "JSON only" does not stop a model wrapping it',
    parseExpectation('```json\n' + goodReply + '\n```', { frameIds: sentIds }).expectation.instances.length === 2);

  const bad = parseExpectation(J({
    category: 'something', confidence: 2,
    instances: [
      { type: 'track', count: 2, frameId: surveyFrames[0].id, regionBox: [0, 0, 1, 1] },
      { type: 'rotor', count: 4, frameId: 'v999.photo', regionBox: [0, 0, 0.5, 0.5] },
      { type: 'rotor', count: 4, frameId: surveyFrames[0].id, regionBox: [0, 0, 5000, 5000] },
      { type: 'gimbal', count: 99, frameId: surveyFrames[0].id, regionBox: [0.1, 0.1, 0.4, 0.4] },
      'not an object',
    ],
  }), { frameIds: sentIds });
  ok('G9: an instance outside the motion vocabulary is DROPPED with a warning, never mapped by guesswork',
    !bad.expectation.instances.some((i) => i.type === 'track')
    && bad.warnings.some((w) => /track/.test(w) && /not rotor\|gimbal\|hinge/.test(w)), J(bad.warnings));
  ok('G9: an instance naming a frame that was never sent is dropped - it could not be aimed at anyway',
    bad.warnings.some((w) => /v999\.photo/.test(w) && /was not sent/.test(w)));
  ok('G9: a box beyond the frame it was drawn on is STILL dropped - it is neither convention, and repairing it would aim a camera at a place nobody indicated',
    bad.warnings.some((w) => /no usable regionBox/.test(w))
    && bad.expectation.instances.every((i) => (i.regionBox || []).every((v) => v >= 0 && v <= 1)), J(bad.warnings));
  ok('G9: an absurd count is capped and a non-object instance is dropped, each with its own warning',
    bad.expectation.instances.find((i) => i.type === 'gimbal')?.count === MAX_INSTANCE_COUNT
    && bad.warnings.some((w) => /capped to/.test(w)) && bad.warnings.some((w) => /was not an object/.test(w)),
    J(bad.expectation.instances.map((i) => `${i.type}:${i.count}`)));
  ok('G9: a confidence outside 0..1 is clamped, not believed',
    bad.expectation.confidence === 1, `conf=${bad.expectation.confidence}`);
  ok('G9: a reply that is not JSON at all degrades to NO prior, with the reason recorded',
    (() => { const p = parseExpectation('I think it is probably a drone.', { frameIds: sentIds }); return p.expectation.category === '' && p.expectation.instances.length === 0 && p.warnings.length > 0; })(),
    J(parseExpectation('I think it is probably a drone.', { frameIds: sentIds }).warnings));

  // UNITS. The category turn was the one place where a model slipping between
  // fractions and pixels used to cost something: its box was dropped outright,
  // and a dropped instance is not a no-op - it removes a place from round 2's
  // close-up plan and a term from the expected-vs-found count. The discovery
  // turn has always inferred the convention through normBox; now both do,
  // through the SAME function, so the inference cannot drift between them.
  const units = parseExpectation(J({
    category: 'quadrotor drone', confidence: 0.9,
    instances: [
      { type: 'rotor', count: 4, frameId: surveyFrames[0].id, regionBox: [205, 256, 410, 461] },
      { type: 'gimbal', count: 1, frameId: surveyFrames[0].id, regionBox: [0.6, 0.7, 0.2, 0.3] },
    ],
  }), { frameIds: sentIds, viewport: VIEWPORT });
  ok('G9: a regionBox drawn in PIXELS is normalized to fractions instead of dropped - and the repair is announced, never absorbed',
    units.expectation.instances.length === 2
    && units.expectation.instances[0].regionBox[0] === 205 / VIEWPORT.w
    && units.expectation.instances[0].regionBox[2] === 410 / VIEWPORT.w
    && units.expectation.instances[0].regionBox.every((v) => v >= 0 && v <= 1)
    && units.warnings.some((w) => /in pixels/.test(w) && /normalized to fractions/.test(w)),
    `${J(units.expectation.instances.map((i) => i.regionBox))} ${J(units.warnings)}`);
  ok('G9: an inverted box is SORTED rather than dropped - the same leniency the discovery turn has always had',
    J(units.expectation.instances[1].regionBox) === J([0.2, 0.3, 0.6, 0.7])
    && !units.warnings.some((w) => /no usable regionBox/.test(w)),
    J(units.expectation.instances[1].regionBox));
  ok('G9: a fraction reply is left exactly alone - normalization is idempotent, because grounding applies normBox to this same box again downstream',
    (() => {
      const p = parseExpectation(goodReply, { frameIds: sentIds, viewport: VIEWPORT });
      return J(p.expectation.instances[0].regionBox) === J(box0) && p.warnings.length === 0;
    })(),
    J(parseExpectation(goodReply, { frameIds: sentIds, viewport: VIEWPORT }).expectation.instances[0].regionBox));
  ok('G9: pixels are divided by the frame they were drawn on, so a round planned at another size normalizes to a different place',
    parseExpectation(J({
      category: 'quadrotor drone', confidence: 0.9,
      instances: [{ type: 'rotor', count: 4, frameId: surveyFrames[0].id, regionBox: [205, 256, 410, 461] }],
    }), { frameIds: sentIds, viewport: { w: 512, h: 512 } }).expectation.instances[0].regionBox[0] === 205 / 512);

  ok('G9: a low-confidence, nameless or empty prior is NOT usable - and then the campaign behaves exactly as it did before this lane existed',
    expectationIsUsable(parsed.expectation) === true
    && expectationIsUsable({ ...parsed.expectation, confidence: 0.2 }) === false
    && expectationIsUsable({ ...parsed.expectation, category: '' }) === false
    && expectationIsUsable({ ...parsed.expectation, instances: [] }) === false
    && expectationIsUsable(null) === false);

  const books = [
    { type: 'rotor', status: 'needs-verdict' }, { type: 'rotor', status: 'auto-accepted' },
    { type: 'rotor', status: 'rejected' }, { type: 'gimbal', status: 'needs-verdict' },
  ];
  const gaps = expectationGap(parsed.expectation, books);
  ok('G9: the gap detector compares the count with what the project believes, and a REJECTED record is not a joint',
    gaps.find((x) => x.type === 'rotor')?.expected === 4 && gaps.find((x) => x.type === 'rotor')?.found === 2
    && gaps.find((x) => x.type === 'rotor')?.missing === 2 && gaps.find((x) => x.type === 'gimbal')?.missing === 0,
    J(gaps));
  ok('G9: grounding MORE than the category expected is reported as a surplus, not quietly absorbed',
    expectationGap({ instances: [{ type: 'rotor', count: 2 }] },
      [{ type: 'rotor', status: 'auto-accepted' }, { type: 'rotor', status: 'auto-accepted' }, { type: 'rotor', status: 'needs-verdict' }])[0]?.surplus === 1);
  ok('G9: no prior, no gaps - the detector never invents an expectation for the project to fail',
    expectationGap(null, books).length === 0 && expectationGap({ instances: [] }, books).length === 0);

  const groundedBox = { frameId: surveyFrames[0].id, grounding: { box: { x0: box0[0], y0: box0[1], x1: box0[2], y1: box0[3] } } };
  ok('G9: an instance the discovery turn already pointed at is VERIFIED, so round 2 does not re-ask a settled question',
    J(verifiedInstances(parsed.expectation, [groundedBox])) === '[0]', J(verifiedInstances(parsed.expectation, [groundedBox])));
  ok('G9: the same box on a DIFFERENT frame verifies nothing - a place is a place in a view',
    verifiedInstances(parsed.expectation, [{ ...groundedBox, frameId: surveyFrames[1].id }]).length === 0);
  ok('G9: a box that barely clips the expectation does not verify it either',
    verifiedInstances(parsed.expectation, [{ frameId: surveyFrames[0].id, grounding: { box: { x0: 0.9, y0: 0.9, x1: 1, y1: 1 } } }]).length === 0);

  // THE BOUNDARY: a confident, specific prior and a discovery turn that says
  // NOTHING. If any part of a guess could reach the manifest, this is where it
  // would show up.
  const f9 = makeFakes(() => '[]');
  const turns = [];
  const savedExp = [];
  const beats9 = [];
  const man9 = [];
  let discoveryPrompt = null;
  const res9 = await runVisionRound(g, [], man9, {
    plan: f9.plan, capture: f9.capture,
    propose: async (text) => {
      const isExp = isExpectationPrompt(text);
      const isLoc = isLocalizationPrompt(text);
      turns.push(isExp ? 'category' : isLoc ? 'localization' : 'discovery');
      if (isExp) return { reply: goodReply, model: 'fake-vlm', ms: 3 };
      // The localization turn fires here: the prior is usable AND a dictionary
      // hit. It comes back empty too, so the boundary below covers hints
      // exactly as it covers free proposals.
      if (isLoc) return { reply: '[]', model: 'fake-vlm', ms: 4 };
      discoveryPrompt = text;
      return { reply: '[]', model: 'fake-vlm', ms: 4 };
    },
    persist: { ...f9.persist, expectation: (e) => savedExp.push(e) },
    expectation: true, emit: (kind, payload) => beats9.push({ kind, payload }),
  });
  ok('G9: a round asks the category turn FIRST, the localization turn SECOND and the discovery turn THIRD, over the SAME rendered frames',
    J(turns) === '["category","localization","discovery"]' && f9.calls.capture > 0, J(turns));
  ok('G9: THE BOUNDARY - a confident prior whose localization AND discovery replies both come back empty produces NO joint at all',
    res9.ok === true && res9.added === 0 && man9.length === 0 && res9.proposals.length === 0 && res9.hinted === 0,
    J({ ok: res9.ok, added: res9.added, manifest: man9.length, hinted: res9.hinted }));
  ok('G9: the prior reaches turn B as a HYPOTHESIS TO FALSIFY, in its own words and with its own counts',
    /HYPOTHESIS TO FALSIFY/.test(discoveryPrompt || '') && /quadrotor drone/.test(discoveryPrompt || '')
    && /expects 4 x rotor/.test(discoveryPrompt || '') && /look for the missing 4/.test(discoveryPrompt || ''),
    (discoveryPrompt || '').split('\n').filter((l) => /HYPOTHESIS|expects |missing/.test(l)).slice(0, 3).join(' | ').slice(0, 150));
  ok('G9: the prior and its outcome ride on the round result, with gaps recomputed AFTER the merge',
    res9.expectation?.category === 'quadrotor drone' && res9.expectationUsable === true
    && res9.gaps?.find((x) => x.type === 'rotor')?.expected === 4 && J(res9.expectationVerified) === '[]',
    J(res9.gaps));
  ok('G9: the prior is persisted beside the frames that produced it - prompt, reply, gaps and warnings',
    savedExp.length === 1 && !!savedExp[0].prompt?.text && savedExp[0].reply === goodReply
    && savedExp[0].expectation?.category === 'quadrotor drone' && Array.isArray(savedExp[0].gaps),
    J(Object.keys(savedExp[0] || {})));
  const b9 = beats9.find((b) => b.kind === 'vision:expect');
  ok('G9: the beat wire carries the category, the counts, the gaps and the verbatim exchange',
    !!b9 && b9.payload.usable === true && b9.payload.category === 'quadrotor drone'
    && b9.payload.instances.length === 2 && b9.payload.instances[0].count === 4
    && Array.isArray(b9.payload.gaps) && !!b9.payload.prompt && !!b9.payload.reply,
    J(b9?.payload && { category: b9.payload.category, instances: b9.payload.instances.length, gaps: b9.payload.gaps.length }));
  ok('G9: the beat order puts the prior and the localization beat between the plan and the discovery question',
    (() => {
      const k = beats9.map((b) => b.kind);
      return k.indexOf('vision:expect') > k.indexOf('vision:plan') && k.indexOf('vision:expect') < k.indexOf('vision:localize')
        && k.indexOf('vision:localize') < k.indexOf('vision:ask')
        && k.indexOf('vision:ask') < k.indexOf('vision:reply') && k.indexOf('vision:reply') < k.indexOf('vision:verdict');
    })(), J(beats9.map((b) => b.kind)));

  const f10 = makeFakes(() => '[]');
  let prompt10 = null;
  const res10 = await runVisionRound(g, [], [], {
    plan: f10.plan, capture: f10.capture,
    propose: async (text) => {
      if (isExpectationPrompt(text)) {
        return { reply: J({ category: 'possibly a drone', confidence: 0.1, instances: [{ type: 'rotor', count: 4, frameId: surveyFrames[0].id, regionBox: box0 }] }), model: 'fake-vlm' };
      }
      prompt10 = text;
      return { reply: '[]', model: 'fake-vlm' };
    },
    expectation: true,
  });
  ok('G9: a low-confidence prior leaves turn B EXACTLY as it was before this lane existed - a guess is never load-bearing',
    res10.ok === true && res10.expectationUsable === false && res10.expectation?.category === 'possibly a drone'
    && !/HYPOTHESIS TO FALSIFY/.test(prompt10 || ''),
    J({ usable: res10.expectationUsable, confidence: res10.expectation?.confidence }));

  const f11 = makeFakes(() => '[]');
  const res11 = await runVisionRound(g, [], [], {
    plan: f11.plan, capture: f11.capture,
    propose: async (text) => { if (isExpectationPrompt(text)) throw new Error('rate limited'); return { reply: '[]', model: 'fake-vlm' }; },
    expectation: true,
  });
  ok('G9: a category turn that FAILS costs nothing - the round carries on with no prior and says why',
    res11.ok === true && res11.expectation === null && res11.expectationUsable === false && res11.gaps === null
    && res11.warnings.some((w) => /category turn: the model call failed/.test(w)),
    J(res11.warnings.filter((w) => /category/.test(w)).slice(0, 1)));

  let turns12 = 0;
  const f12 = makeFakes(() => '[]');
  const res12 = await runVisionRound(g, [], [], {
    plan: f12.plan, capture: f12.capture,
    propose: async () => { turns12 += 1; return { reply: '[]', model: 'fake-vlm' }; },
  });
  ok('G9: a round that did not ask for a prior makes exactly ONE turn, as it always did',
    turns12 === 1 && res12.expectation === null && res12.gaps === null && res12.expectationVerified === null,
    `turns=${turns12}`);

  // Round 2's aim list: the prior's UNVERIFIED places, resolved through the same
  // grounding channel a claim uses, and REPORTED when they cannot be resolved.
  const sv = bigPlan.views.find((v) => v.spec?.kind === 'survey');
  const aimName = (sv.sees || []).find((nm) => nameOfMesh.has(nm));
  const aimRect = rectOf(nodeBox(nameOfMesh.get(aimName)), sv.cam);
  const aimBox = [aimRect.x0 / sv.cam.w, aimRect.y0 / sv.cam.h, aimRect.x1 / sv.cam.w, aimRect.y1 / sv.cam.h];
  const frameRefs = bigPlan.views.filter((v) => v.mode !== 'ghost').map((v) => ({ id: frameKey(v.id, 'photo'), viewId: v.id, mode: 'photo' }));
  const exp = {
    category: 'quadrotor drone', confidence: 0.9, summary: '', doubts: [], alternatives: [],
    instances: [
      { type: 'rotor', count: 4, frameId: frameKey(sv.id, 'photo'), regionBox: aimBox, symmetry: null, note: null },
      { type: 'gimbal', count: 1, frameId: 'v999.photo', regionBox: [0.1, 0.1, 0.4, 0.4], symmetry: null, note: null },
    ],
  };
  const aim = (over = {}) => regionsFromExpectations(g, exp, {
    plan: bigPlan, frames: frameRefs, verified: [], gaps: [{ type: 'rotor', expected: 4, found: 1, missing: 3 }], ...over,
  });
  const aimed = aim();
  ok('G9: an expected place resolves through the SAME grounding channel a claim uses',
    aimed.regions.length === 1 && aimed.regions[0].origin === 'expectation' && aimed.regions[0].type === 'rotor'
    && aimed.regions[0].names.length > 0 && aimed.regions[0].expectedCount === 4
    && Number.isFinite(aimed.regions[0].radius) && aimed.regions[0].anchor.every(Number.isFinite),
    J(aimed.regions.map((r) => ({ id: r.id, names: r.names.length, radius: +r.radius.toFixed(1) }))));
  ok('G9: it is aimed from a DIFFERENT bearing than the frame it was read from - the same azimuth reproduces the same occlusion',
    aimed.regions[0].azimuth !== sv.spec.azimuth, `view=${sv.spec.azimuth} region=${aimed.regions[0].azimuth}`);
  ok('G9: an expectation that cannot be resolved is REPORTED, never approximated into a place to aim',
    aimed.unresolved.length === 1 && aimed.unresolved[0].origin === 'expectation'
    && aimed.unresolved[0].type === 'gimbal' && /v999\.photo/.test(aimed.unresolved[0].why || ''),
    J(aimed.unresolved));
  ok('G9: a type whose expected count is already met is SKIPPED rather than aimed at',
    (() => {
      const r2 = aim({ gaps: [{ type: 'rotor', expected: 4, found: 4, missing: 0 }] });
      return r2.regions.length === 0 && r2.skipped.some((s) => s.origin === 'expectation' && s.type === 'rotor');
    })(), J(aim({ gaps: [{ type: 'rotor', expected: 4, found: 4, missing: 0 }] }).skipped));
  ok('G9: an instance the discovery turn already pointed at is skipped as well',
    aim({ verified: [0] }).skipped.some((s) => s.index === 0 && s.origin === 'expectation'));
  ok('G9: NOTHING this module returns is a record - it returns places to look and nothing else',
    aimed.regions.every((r) => r.op === undefined && r.nodes === undefined && r.confidence === undefined && r.status === undefined)
    && aimed.unresolved.every((u) => u.op === undefined && u.nodes === undefined));
  ok('G9: with no parse table or no prior it returns nothing at all, rather than throwing',
    regionsFromExpectations(null, exp, { plan: bigPlan, frames: frameRefs }).regions.length === 0
    && regionsFromExpectations(g, null, { plan: bigPlan, frames: frameRefs }).regions.length === 0);

  // Campaign level: round 1 is the only round with a survey tier, so it is the
  // only round that can name a category.
  const f13 = makeFakes((loc) => J([{
    op: 'new', type: 'rotor', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1],
    uncertainties: ['blade count unclear'],
    suggestView: { target: 'the same rotor from below', reason: 'the hub is hidden' },
  }]));
  const kinds = [];
  const res13 = await runVisionCampaign(g, [], [], {
    plan: f13.plan, capture: f13.capture, rounds: 2, extraViews: 2,
    propose: async (text, images) => { kinds.push(isExpectationPrompt(text) ? 'category' : 'discovery'); return f13.propose(text, images); },
  });
  ok('G9: a campaign asks for the prior in round 1 ONLY - round 2 has no whole-machine frame to read one from',
    kinds[0] === 'category' && kinds.filter((k) => k === 'category').length === 1 && kinds.length >= 2
    && res13.roundCount >= 1, J(kinds));

  const f14 = makeFakes(() => '[]');
  const kinds14 = [];
  await runVisionCampaign(g, [], [], {
    plan: f14.plan, capture: f14.capture, rounds: 1, expectation: false,
    propose: async (text, images) => { kinds14.push(isExpectationPrompt(text) ? 'category' : 'discovery'); return f14.propose(text, images); },
  });
  ok('G9: a caller can switch the prior off and get the single-turn round back',
    J(kinds14) === '["discovery"]', J(kinds14));
}

// ---- G10) expectation hints: landing, physics, supersession --------------------
// The localization turn asks one question PER EXPECTED PART and parses the reply
// through the same gate as the discovery turn, under the hint profile. Three
// disciplines keep a hint honest: it LANDS even when nobody can supply a spin
// axis (a steered wheel's grounded cloud is too round to derive one from — the
// gap is announced, never invented); the BATTERY, not the hint, disposes of the
// scope the box selects; and for a part the dictionary covers, a tighter hint
// SUPERSEDES the geometry lane's overlapping record — the geometry demotes to
// corroboration instead of the pre-hint reverse.
{
  // What B proved the default gate drops — a box with no derivable axis — the
  // hint profile must ADMIT: dropping it made the geometry lane's spinAxleAxis
  // gate the final word on a part the dictionary says is there.
  const hintGate = visionPropose({
    reply: J([{ op: 'new', type: 'rotor', frameId: view.id, regionBox: subjectBox }]),
    g, manifest: [], frames: [photoFrame], plan, profile: HINT_GATE_PROFILE,
  });
  ok('G10: the box the default gate drops for want of an axis LANDS under the hint profile, axis null',
    hintGate.records.length === 1 && hintGate.records[0].axis === null, J(hintGate.warnings));
  ok('G10: ...and the missing axis is ANNOUNCED as an uncertainty, never silently invented',
    (hintGate.records[0]?.uncertainties || []).some((u) => u.includes('no axis')),
    J(hintGate.records[0]?.uncertainties?.slice(-1)));
  ok('G10: the hint profile stamps provenance onto the record itself',
    hintGate.records[0]?.origin === 'expectation-hint' && hintGate.records[0]?.evidence?.[0] === 'expectation-hint'
    && hintGate.records[0]?.id === 'rotor_hint_0' && isHintRecord(hintGate.records[0]),
    `${hintGate.records[0]?.id} — ${hintGate.records[0]?.label}`);

  // The supersede rule, unit-level. reconcileLanes' prefer option is the staged
  // pipeline's copy of it; the campaign path's copy runs inside the round below.
  const geoLane = (over = {}) => ({
    id: 'wheel_geo_0', type: 'rotor', nodes: ['a', 'b', 'c'], origin: 'L1-geometry', verdict: null, ...over,
  });
  const hintLane = (nodes, over = {}) => ({
    id: 'rotor_hint_0', type: 'rotor', nodes, hinted: true, origin: 'expectation-hint', ...over,
  });
  const sup = reconcileLanes([geoLane()], { records: [hintLane(['a', 'b'])] }, { prefer: isHintRecord });
  ok('G10: a tighter hint SUPERSEDES the overlapping geometry record, which is reported with what it gave up',
    sup.records.length === 1 && sup.records[0].id === 'rotor_hint_0' && sup.confirms.length === 0
    && sup.superseded.length === 1 && sup.superseded[0].id === 'wheel_geo_0' && sup.superseded[0].by === 'rotor_hint_0'
    && sup.superseded[0].origin === 'L1-geometry' && sup.superseded[0].match === 'overlap'
    && J(sup.superseded[0].laneOnly) === '["c"]', J(sup.superseded));
  const verdicted = reconcileLanes([geoLane({ verdict: { decision: 'reject' } })], { records: [hintLane(['a', 'b'])] }, { prefer: isHintRecord });
  ok('G10: ...but a record carrying ANY human verdict is off-limits — a person\'s "no" ranks as high as a "yes"',
    verdicted.superseded.length === 0 && verdicted.records.length === 0
    && verdicted.confirms.length === 1 && verdicted.confirms[0].targetId === 'wheel_geo_0');
  const bigger = reconcileLanes([geoLane()], { records: [hintLane(['a', 'b', 'c', 'd'])] }, { prefer: isHintRecord });
  ok('G10: a hint LARGER than the record it overlaps corroborates instead of replacing — a sloppy box never eats a truthful scope',
    bigger.superseded.length === 0 && bigger.records.length === 0 && bigger.confirms.length === 1);
  const plainLane = reconcileLanes([geoLane()], { records: [{ id: 'rotor_vis_0', type: 'rotor', nodes: ['a', 'b'], origin: 'L2-vision' }] }, { prefer: isHintRecord });
  ok('G10: a non-hint record never supersedes, prefer rule or not',
    plainLane.superseded.length === 0 && plainLane.confirms.length === 1);
  const noPrefer = reconcileLanes([geoLane()], { records: [hintLane(['a', 'b'])] });
  ok('G10: with no prefer rule the lane keeps its pre-hint behaviour — agreement is corroboration',
    noPrefer.superseded.length === 0 && noPrefer.confirms.length === 1);
  const exactSup = reconcileLanes([geoLane()], { records: [hintLane(['a', 'b', 'c'])] }, { prefer: isHintRecord });
  ok('G10: an exact-set hint supersedes too, reported as an exact match with nothing given up',
    exactSup.superseded.length === 1 && exactSup.superseded[0].match === 'exact' && exactSup.superseded[0].laneOnly.length === 0);

  // The round, fully faked: a car prior, five pointed boxes (four wheels and a
  // door — the hinge no prompt offers any more, faked here to prove the gate
  // refuses one that arrives anyway), and one extra the discovery turn finds.
  const sv10 = bigPlan.views.find((v) => v.spec?.kind === 'survey');
  const cam10 = sv10.cam;
  const frame10 = {
    id: frameKey(sv10.id, 'photo'), viewId: sv10.id, mode: 'photo', pose: sv10.pose,
    spec: sv10.spec, covers: sv10.covers, sees: sv10.sees,
  };
  const probeable10 = (sv10.sees || []).filter((nm) => nameOfMesh.has(nm));
  // Six parts whose boxes ground to MUTUALLY DISJOINT node sets: disjointness is
  // what keeps the battery's cross-joint isolation check clean, so the physics
  // assertions below measure scopes, not overlaps. Grounding is deterministic, so
  // what this picker measures is exactly what the round below will ground.
  const pointed = [];
  for (const nm of probeable10) {
    if (pointed.length >= 6) break;
    const r = rectOf(nodeBox(nameOfMesh.get(nm)), cam10);
    if (!r) continue;
    const box = [r.x0 / cam10.w, r.y0 / cam10.h, r.x1 / cam10.w, r.y1 / cam10.h];
    const grounded = visionPropose({
      reply: J([{ op: 'new', type: 'rotor', frameId: frame10.id, regionBox: box }]),
      g, manifest: [], frames: [frame10], plan: bigPlan, profile: HINT_GATE_PROFILE,
    }).records[0];
    if (!grounded) continue;
    if (pointed.some((p) => p.nodes.some((n) => grounded.nodes.includes(n)))) continue;
    pointed.push({ nm, box, nodes: grounded.nodes });
  }
  ok('G10: fixture — six parts whose boxes ground to mutually disjoint node sets exist to point at',
    pointed.length === 6, pointed.map((p) => `${p.nm}:${p.nodes.length}n`).join(', '));

  // The door entry stays a hinge on purpose: the dictionary no longer asks a
  // car for one, so this is a stale model proposing it anyway — the gate must
  // refuse it, and only the four wheels land as hints.
  const locReply = J(pointed.slice(0, 5).map((p, i) => ({
    op: 'new', type: i < 4 ? 'rotor' : 'hinge', part: i < 4 ? 'wheel' : 'door',
    frameId: frame10.id, regionBox: p.box,
    reasoning: `the ${i < 4 ? `wheel ${i + 1} of 4` : 'door'} at this spot`,
  })));
  const carReply = J({
    category: 'a sports car', confidence: 0.9, summary: 'four wheels at the corners, doors on the sides',
    instances: [{ type: 'rotor', count: 4, frameId: frame10.id, regionBox: [0.1, 0.1, 0.5, 0.5], symmetry: 'one per corner', note: 'wheels' }],
    doubts: [], alternatives: [],
  });
  const extraReply = J([{
    op: 'new', type: 'rotor', part: 'turret', frameId: frame10.id, regionBox: pointed[5]?.box,
    axis: [0, 0, 1], reasoning: 'a rotating ring on the spine that a car does not usually have',
  }]);

  const fh = makeFakes(() => '[]');
  const beatsH = [];
  const turnsH = [];
  const manh = [];
  const jh = [];
  const resh = await runVisionRound(g, jh, manh, {
    plan: fh.plan, capture: fh.capture, persist: fh.persist,
    propose: async (text) => {
      const kind = isExpectationPrompt(text) ? 'category' : isLocalizationPrompt(text) ? 'localization' : 'discovery';
      turnsH.push(kind);
      if (kind === 'category') return { reply: carReply, model: 'fake-vlm', ms: 3 };
      if (kind === 'localization') return { reply: locReply, model: 'fake-vlm', ms: 4 };
      return { reply: extraReply, model: 'fake-vlm', ms: 4 };
    },
    expectation: true, emit: (kind, payload) => beatsH.push({ kind, payload }),
  });
  ok('G10: a dictionary-backed prior runs the three turns in order — category, localization, discovery',
    J(turnsH) === '["category","localization","discovery"]', J(turnsH));
  ok('G10: the four wheels land as hints and the door\'s hinge is REFUSED, announced — plus the discovery turn\'s extra',
    resh.ok === true && resh.added === 5 && resh.hinted === 4 && manh.length === 5
    && resh.warnings.some((w) => /is a hinge/.test(w)),
    J({ added: resh.added, hinted: resh.hinted, manifest: manh.length, w: resh.warnings.slice(0, 2) }));
  const wheels = manh.filter((r) => r.part === 'wheel');
  ok('G10: the four wheels are FOUR records — one entry per instance, never one box around all four',
    wheels.length === 4 && wheels.every((r) => r.hinted === true && r.origin === 'expectation-hint'
      && r.type === 'rotor' && (r.evidence || []).includes('dictionary:car')),
    J(wheels.map((r) => r.id)));
  ok('G10: every wheel hint grounds to the part it was pointed at',
    wheels.every((r, i) => (r.nodes || []).includes(pointed[i].nm)),
    J(manh.map((r) => `${r.id}:${(r.nodes || []).length}n`)));
  const door = manh.find((r) => r.part === 'door');
  ok('G10: the hinge box mints NO record and is never grounded — a type refusal at the gate, not a grounding failure',
    !door && resh.warnings.some((w) => /proposal\[4\] is a hinge/.test(w)),
    J({ door: door?.id, records: manh.map((r) => `${r.id}:${r.part ?? '?'}:${r.type}`) }));
  ok('G10: a hint whose cloud yields no axis lands anyway, with the gap announced (the steered-wheel case)',
    manh.filter((r) => r.hinted).every((r) => r.axis !== null
      || (r.uncertainties || []).some((u) => u.includes('no axis'))),
    J(manh.filter((r) => r.hinted).map((r) => `${r.id}:axis=${r.axis ? 'derived' : 'null'}`)));
  ok('G10: the battery runs on hints exactly as on any proposal — physics, not the pointing, disposes',
    manh.every((r) => (r.tests || []).length === 4 && [0.7, 0.75, 0.8].includes(r.confidence)),
    J(manh.map((r) => `${r.id}:${r.confidence}`)));
  ok('G10: disjoint pointed scopes keep the isolation check clean across the whole merged set',
    manh.every((r) => (r.tests || []).find((t) => t.name === 'isolation')?.pass === true),
    J(manh.map((r) => (r.tests || []).find((t) => t.name === 'isolation')?.detail).filter(Boolean)));
  ok('G10: the recognition gate lists the hints as EXPECTED parts of a car',
    resh.recognition?.dict === 'car' && resh.recognition?.listed === 5
    && manh.filter((r) => r.hinted).every((r) => r.listed === true && r.expected === true && r.extra === false),
    J(resh.recognition && { dict: resh.recognition.dict, listed: resh.recognition.listed }));
  ok('G10: ...and the extra the discovery turn found is still gated — listed, flagged, announced',
    resh.recognition?.extras === 1 && resh.recognition?.excluded === 0
    && manh.find((r) => r.part === 'turret')?.extra === true
    && resh.warnings.some((w) => /recognition gate: .*turret.*EXTRA/.test(w)),
    J(resh.recognition?.notes));
  ok('G10: the gap check closes on the hints — the wheels the prior expected are FOUND, the turret is a surplus',
    resh.gaps?.find((x) => x.type === 'rotor')?.expected === 4
    && resh.gaps.find((x) => x.type === 'rotor')?.found === 5
    && resh.gaps.find((x) => x.type === 'rotor')?.missing === 0
    && resh.gaps.find((x) => x.type === 'rotor')?.surplus === 1,
    J(resh.gaps));
  ok('G10: the parts nobody pointed at stay missing — and a car is no longer expected to HAVE hinges at all',
    !resh.gaps?.some((x) => x.type === 'hinge')
    && resh.gaps?.find((x) => x.type === 'gimbal')?.missing === 4,
    J(resh.gaps));
  const locBeat = beatsH.find((b) => b.kind === 'vision:localize');
  ok('G10: the localization beat carries the dictionary key, the ask count and the landed hints',
    !!locBeat && locBeat.payload.dictKey === 'car' && locBeat.payload.asked === 8
    && (locBeat.payload.hints || []).length === 4 && !!locBeat.payload.prompt && !!locBeat.payload.reply,
    J(locBeat?.payload && { dictKey: locBeat.payload.dictKey, asked: locBeat.payload.asked, hints: locBeat.payload.hints?.length }));
  const verdictBeatH = beatsH.find((b) => b.kind === 'vision:verdict');
  ok('G10: the verdict beat reports no supersession when the manifest held nothing the hints overlap',
    !!verdictBeatH && J(verdictBeatH.payload.superseded) === '[]' && resh.superseded?.length === 0,
    J(verdictBeatH?.payload?.superseded));

  // A box around the WHOLE machine is the cabin-swallowing case. The hint gate
  // must still LAND it — gating on scope would re-blind the lane the way
  // spinAxleAxis did — and the battery is the instrument that rejects it.
  const fm = makeFakes(() => '[]');
  const manm = [];
  const resm = await runVisionRound(g, [], manm, {
    plan: fm.plan, capture: fm.capture,
    propose: async (text) => {
      if (isExpectationPrompt(text)) return { reply: carReply, model: 'fake-vlm', ms: 3 };
      if (isLocalizationPrompt(text)) {
        return {
          reply: J([{ op: 'new', type: 'rotor', part: 'wheel', frameId: frame10.id, regionBox: [0.02, 0.02, 0.98, 0.98], reasoning: 'a wheel, somewhere in here' }]),
          model: 'fake-vlm', ms: 4,
        };
      }
      return { reply: '[]', model: 'fake-vlm', ms: 4 };
    },
    expectation: true,
  });
  const monster = manm[0];
  ok('G10: the cabin-swallowing hint LANDS — its scope is physics\' business, not the gate\'s',
    resm.ok === true && resm.hinted === 1 && !!monster && monster.hinted === true,
    J({ hinted: resm.hinted, nodes: monster?.nodes?.length }));
  ok('G10: ...and the battery REJECTS the swallowed scope — the same ruler that kills the FR-rotor cluster',
    monster?.tests?.find((t) => t.name === 'scope-spread')?.pass === false
    && monster.confidence === 0.7 && monster.status === 'needs-verdict',
    monster?.tests?.find((t) => t.name === 'scope-spread')?.detail);

  // A geometry record already in the manifest, overlapping a hint the dictionary
  // covers: the hint's per-part scope REPLACES it, and the geometry record
  // demotes to corroboration evidence on the hint that replaced it.
  const stray = probeable10.find((nm) => !pointed.some((p) => p.nm === nm || p.nodes.includes(nm)));
  const geoWheel = rec({
    id: 'wheel_geo_0', label: 'wheel (geometry)', type: 'rotor',
    nodes: [...pointed[0].nodes, stray], origin: 'L1-geometry',
  });
  const fs = makeFakes(() => '[]');
  const beatsS = [];
  const mans = [geoWheel];
  const js = [{ ...geoWheel }];
  const ress = await runVisionRound(g, js, mans, {
    plan: fs.plan, capture: fs.capture,
    propose: async (text) => {
      if (isExpectationPrompt(text)) return { reply: carReply, model: 'fake-vlm', ms: 3 };
      if (isLocalizationPrompt(text)) {
        return {
          reply: J([{ op: 'new', type: 'rotor', part: 'wheel', frameId: frame10.id, regionBox: pointed[0].box, reasoning: 'wheel 1 of 4' }]),
          model: 'fake-vlm', ms: 4,
        };
      }
      return { reply: '[]', model: 'fake-vlm', ms: 4 };
    },
    expectation: true, emit: (kind, payload) => beatsS.push({ kind, payload }),
  });
  ok('G10: the hint SUPERSEDES the overlapping geometry record — the manifest swaps, it does not duplicate',
    ress.ok === true && mans.length === 1 && mans[0].id === 'rotor_hint_0' && mans[0].hinted === true
    && !mans.some((r) => r.id === 'wheel_geo_0') && !js.some((j) => j.id === 'wheel_geo_0'),
    J({ manifest: mans.map((r) => r.id), joints: js.map((j) => j.id) }));
  ok('G10: the supersession is reported with how the two claims matched',
    ress.superseded?.length === 1 && ress.superseded[0].id === 'wheel_geo_0'
    && ress.superseded[0].by === 'rotor_hint_0' && ress.superseded[0].origin === 'L1-geometry'
    && ress.superseded[0].shared === pointed[0].nodes.length && ress.superseded[0].containment === 1,
    J(ress.superseded));
  ok('G10: the hint carries the demotion as evidence and history — corroboration, not disappearance',
    mans[0].evidence.includes('supersedes:wheel_geo_0') && mans[0].evidence.includes('cross-producer:L1-geometry')
    && (mans[0].history || []).some((h) => h.event === 'superseded' && /wheel_geo_0/.test(h.note || '')),
    J(mans[0].evidence));
  const beatS = beatsS.find((b) => b.kind === 'vision:verdict');
  ok('G10: the verdict beat announces the supersession',
    J(beatS?.payload?.superseded) === J([{ id: 'wheel_geo_0', by: 'rotor_hint_0' }]),
    J(beatS?.payload?.superseded));
}

// ---- H) every failure path leaves the manifest untouched ----------------------
{
  const untouched = async (label, effects, expectCode) => {
    const man = [];
    const joints = [];
    const res = await runVisionRound(g, joints, man, effects);
    ok(`H: ${label} bails without touching the manifest`,
      res.ok === false && man.length === 0 && joints.length === 0 && res.manifestUntouched === true
      && (!expectCode || res.code === expectCode) && res.warnings.length > 0,
      `${res.code || '?'} — ${res.reason}`);
    return res;
  };

  await untouched('no capture effect wired', { plan: bigPlan }, 'NO_RENDERER');
  await untouched('no views in the plan', { plan: { views: [] } }, 'NO_VIEWS');
  await untouched('a planner that throws', {
    plan: () => { throw new Error('kd blew up'); },
  }, 'PLAN_FAILED');
  await untouched('no renderer connected', {
    plan: bigPlan,
    capture: async () => { throw Object.assign(new Error('no renderer'), { code: 'NO_RENDERER' }); },
  }, 'NO_RENDERER');
  await untouched('a renderer with no model loaded', {
    plan: bigPlan,
    capture: async () => { throw Object.assign(new Error('no model'), { code: 'NO_MODEL' }); },
  }, 'NO_MODEL');
  await untouched('every capture returning nothing', {
    plan: bigPlan, capture: async () => null,
  }, 'NO_FRAMES');
  await untouched('no vision provider wired', {
    plan: bigPlan, capture: async (v, m) => ({ id: frameKey(v.id, m), viewId: v.id, mode: m, pose: v.pose, dataBase64: PNG, mediaType: 'image/png' }),
  }, 'NO_VISION_AGENT');

  // A provider that refuses must still persist the exchange: "we asked and got
  // nothing" is evidence, and without it the round leaves no trace of the prompt.
  const dead = {
    savedReply: null,
    persist: { reply: (r) => { dead.savedReply = r; } },
  };
  await untouched('a provider that refuses', {
    plan: bigPlan,
    capture: async (v, m) => ({ id: frameKey(v.id, m), viewId: v.id, mode: m, pose: v.pose, dataBase64: PNG, mediaType: 'image/png' }),
    propose: async () => { throw Object.assign(new Error('stub agent'), { code: 'NO_VISION_AGENT' }); },
    persist: dead.persist,
  }, 'NO_VISION_AGENT');
  ok('H: a failed turn still persists the prompt that was sent',
    !!dead.savedReply && dead.savedReply.reply === null && !!dead.savedReply.prompt?.text,
    `${dead.savedReply?.prompt?.text?.length || 0} chars of prompt kept`);

  // A degraded (stub) reply must not be parsed into confident proposals.
  await untouched('a model that degraded mid-turn', {
    plan: bigPlan,
    capture: async (v, m) => ({ id: frameKey(v.id, m), viewId: v.id, mode: m, pose: v.pose, dataBase64: PNG, mediaType: 'image/png' }),
    propose: async () => { throw Object.assign(new Error('degraded to stub'), { code: 'VISION_DEGRADED' }); },
  }, 'VISION_DEGRADED');

  // An empty answer is a VALID answer, not a failure: the round succeeded and the
  // model simply found nothing. Distinguishing these two is what stops a caller
  // from retrying forever or from reporting a healthy round as broken.
  const empty = makeFakes(() => '[]');
  const manE = [];
  const resE = await runVisionRound(g, [], manE, { plan: empty.plan, capture: empty.capture, propose: empty.propose });
  ok('H: an empty reply is a successful round that added nothing',
    resE.ok === true && resE.added === 0 && manE.length === 0
    && resE.reason === 'the model proposed nothing' && resE.frames > 0,
    `frames=${resE.frames} reason="${resE.reason}"`);

  const junk = makeFakes(() => 'I see a drone but I cannot tell what moves.');
  const resJ = await runVisionRound(g, [], [], { plan: junk.plan, capture: junk.capture, propose: junk.propose });
  ok('H: an unparseable reply is a successful round with a warning, not a crash',
    resJ.ok === true && resJ.added === 0 && resJ.warnings.some((w) => w.includes('no JSON array')),
    J(resJ.warnings.slice(0, 1)));

  // Replay from disk: preset frames must bypass capture entirely.
  const preset = [{
    id: 'p0', viewId: bigPlan.views[0].id, mode: 'photo', pose: bigPlan.views[0].pose,
    spec: bigPlan.views[0].spec, dataBase64: PNG, mediaType: 'image/png', colorMap: null,
  }];
  const rp = makeFakes(() => '[]');
  let captureCalls = 0;
  const resR = await runVisionRound(g, [], [], {
    plan: bigPlan,
    capture: async () => { captureCalls += 1; return null; },
    propose: rp.propose,
    frames: preset,
  });
  ok('H: preset frames replay a round with NO capture at all',
    resR.ok === true && captureCalls === 0 && resR.frames === 1
    && resR.warnings.some((w) => w.includes('replayed')),
    `capture calls=${captureCalls}`);

  // Rejections are recorded, so "the model said X and we refused it because Y"
  // is an audit trail rather than a silent disappearance.
  const rej = makeFakes((loc) => J([
    { op: 'new', type: 'rotor', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1] },
    { op: 'new', type: 'wobble', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1] },
    { op: 'new', type: 'hinge', frameId: 'v999', regionBox: [0.1, 0.1, 0.5, 0.5], axis: [0, 0, 1] },
    // Rejected as a duplicate node set, yet its ask for another view is still
    // real and still worth aiming round 2 at.
    {
      op: 'new', type: 'gimbal', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1],
      suggestView: { target: 'the same hub from below', reason: 'the mount is hidden behind the arm' },
    },
  ]));
  const manR = [];
  const resRej = await runVisionRound(g, [], manR, { plan: rej.plan, capture: rej.capture, propose: rej.propose, persist: rej.persist });
  ok('H: accepted and rejected proposals are both accounted for',
    resRej.ok === true && resRej.added === 1 && resRej.rejected.length === 3
    && manR.length === 1,
    `admitted=${resRej.admitted.length} rejected=${resRej.rejected.length}`);
  ok('H: the persisted proposals keep the rejection reasons',
    rej.seen.proposals?.rejected?.length === 3 && rej.seen.proposals?.records?.length === 1);
  ok('H: a REJECTED proposal still contributes its suggestView',
    resRej.suggestViews.some((s) => s.target.includes('from below') && s.origin === 'model'),
    J(resRej.suggestViews));
  // The other half of the rule: a frameId that never existed is a hallucination,
  // not a coverage gap, so it must NOT manufacture a re-aim request. Letting it
  // would send round 2 chasing a frame no planner ever produced.
  ok('H: a hallucinated frameId does NOT invent a re-aim request',
    !resRej.suggestViews.some((s) => s.frameId === 'v999'),
    J(resRej.suggestViews.map((s) => s.frameId)));
}

// ---- I) the model's words reach the human ------------------------------------
// The entire justification for keeping a human gate is that a person can read
// WHAT the model thought and WHERE it told us it was unsure. That chain crosses a
// process boundary (loop -> kernel -> jointSummary -> wire -> chip tooltip), and
// it is the one link that can break SILENTLY: a field dropped in the serializer
// costs nothing at runtime, breaks no test that only counts records, and quietly
// removes the reason to trust any verdict.
{
  const f = makeFakes((loc) => J([{
    op: 'new', type: 'rotor', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1],
    reasoning: 'a central hub with four radial blades',
    uncertainties: ['blade count unclear', 'the hub may be behind the arm'],
  }]));
  const joints = [];
  const man = [];
  const res = await runVisionRound(g, joints, man, { plan: f.plan, capture: f.capture, propose: f.propose });
  ok('I: the round put its record on the joint list the UI reads',
    res.ok === true && joints.length === 1 && man.length === 1, `${joints.length} joints, ${man.length} records`);

  const wire = jointSummary(joints[0]);
  ok('I: jointSummary passes the model reasoning through to the wire',
    typeof wire.reasoning === 'string' && wire.reasoning.includes('central hub'),
    wire.reasoning || 'MISSING');
  ok('I: jointSummary passes every uncertainty through, model doubts in order',
    Array.isArray(wire.uncertainties)
    && wire.uncertainties.indexOf('blade count unclear') >= 0
    && wire.uncertainties.indexOf('the hub may be behind the arm') > wire.uncertainties.indexOf('blade count unclear'),
    J(wire.uncertainties));
  // Stronger than "the model's doubts survive": the system's OWN doubt about how
  // it grounded the claim is recorded too, and recorded FIRST. A human reading
  // the chip should meet the machine's uncertainty before the model's, because
  // the machine's is the one that is definitely true.
  ok('I: the grounding layer\'s own doubt is recorded ahead of the model\'s',
    wire.uncertainties.length === 3 && wire.uncertainties[0].includes('grounding by colour only'),
    `first="${wire.uncertainties[0]?.slice(0, 48)}..."`);
  ok('I: the wire says WHICH PRODUCER made the claim',
    wire.origin === 'L2-vision', `${wire.origin}`);
  // The chip tooltip is presentation and lives in a Vue SFC, so it is covered by
  // the build rather than here. What IS asserted is that the three field names it
  // reads are exactly the three the serializer emits — the contract between them.
  ok('I: the fields the chip reads are the fields the serializer emits',
    ['reasoning', 'uncertainties', 'origin'].every((k) => k in wire));

  // Conditional spread: a phase-1/2 joint must not grow three empty fields, or
  // every existing chip tooltip would acquire blank "model:" and "unsure:" lines
  // and the new information would become noise on 5 records to save 3 keys.
  const plain = jointSummary({ id: 'p', label: 'p', type: 'rotor', nodes: ['a'], confidence: 0.8 });
  ok('I: a non-vision joint gains NO empty reasoning fields',
    !('reasoning' in plain) && !('uncertainties' in plain) && !('origin' in plain),
    J(Object.keys(plain).filter((k) => ['reasoning', 'uncertainties', 'origin'].includes(k))));
  ok('I: a non-vision joint still carries its phase-1 verdict fields',
    plain.status === 'candidate' && plain.confidence === 0.8 && Array.isArray(plain.evidence),
    `${plain.status} conf=${plain.confidence}`);
}

// ---- J) the bounded ACTIVE loop: round 2 goes and looks ----------------------
// Round 1 declares where it was unsure; round 2 turns that sentence back into a
// camera pose and looks. Everything here is faked — no browser, no model — which
// is the only way to prove the BOUNDS: that the ceiling is hard, that the extra
// frames really are close-ups of the disputed part, and that a campaign stops
// when another look would repeat a question.
// A CATEGORY PRIOR reply the parser reads as "nothing usable": no category, no
// instances. The lane then degrades to the single-turn round, which is what every
// J assertion below was written against — the suggestView edge has to be measured
// on its own, not through a prior that also aims round 2.
const NO_PRIOR = '{"category":"","confidence":0,"summary":"","instances":[],"doubts":["cannot tell what this is"],"alternatives":[]}';

// `expectReply` is what the category turn answers with. Round 1 now makes TWO
// model calls, so a fake that counted calls would report the prior's turn as a
// round and every round-indexed assertion would measure the wrong round.
function makeCampaignFakes(replyOf, { expectReply = null } = {}) {
  const state = {
    plan: 0, capture: 0, propose: 0, expect: 0,
    prompts: [], expectPrompts: [], asked: [], saved: {},
  };
  return {
    state,
    plan: () => { state.plan += 1; return bigPlan; },
    capture: async (view, mode, focusNodes, round) => {
      state.capture += 1;
      // The campaign passes the round index as the FOURTH argument. Reading it
      // instead of inferring it from a propose counter is what keeps these
      // assertions true across a two-turn round.
      const r = Number.isFinite(round) ? round : state.propose;
      state.asked.push({
        round: r, viewId: view.id, kind: view.spec?.kind ?? null,
        mode, focus: focusNodes?.length ?? 0, sees: view.sees || [],
      });
      const colorMap = {};
      if (mode === 'colorId') (focusNodes || []).forEach((nm, i) => { colorMap[hexOf(i)] = nm; });
      return {
        id: frameKey(view.id, mode), viewId: view.id, mode, pose: view.pose, spec: view.spec,
        covers: view.covers, sees: view.sees, focus: focusNodes, mediaType: 'image/png',
        dataBase64: PNG, colorMap: mode === 'colorId' ? colorMap : null,
      };
    },
    propose: async (text, images) => {
      // The two turns of a round are told apart by CONTENT, using the sentinel
      // expectation.mjs exports for exactly this: a call counter would silently
      // shift every round index the campaign is keyed on.
      if (isExpectationPrompt(text)) {
        const round = state.expect;
        state.expect += 1;
        state.expectPrompts.push(text);
        return {
          reply: typeof expectReply === 'function' ? expectReply(text, images, round) : (expectReply ?? NO_PRIOR),
          model: 'fake-vlm', ms: 4, mode: 'live',
        };
      }
      const round = state.propose;
      state.propose += 1;
      state.prompts.push(text);
      const m = text.match(/LEGEND for "([^"]+)":\s*(#[0-9a-f]{6})=(\S+)/);
      return {
        reply: replyOf(m ? { frameId: m[1], color: m[2], name: m[3] } : null, images, round),
        model: 'fake-vlm', ms: 5, mode: 'live',
      };
    },
    // A FACTORY, because a campaign persists per round: an object-shaped persist
    // belongs to round 1 only, and reusing it would write round 2's evidence over
    // the frames a human may already be looking at.
    persist: (r) => {
      if (!state.saved[r]) state.saved[r] = { plan: 0, frame: 0, reply: null, proposals: null, expectation: null };
      const b = state.saved[r];
      return {
        plan: () => { b.plan += 1; },
        frame: () => { b.frame += 1; },
        reply: (x) => { b.reply = x; },
        proposals: (x) => { b.proposals = x; },
        expectation: (x) => { b.expectation = x; },
      };
    },
  };
}

// A reply that grounds by exact colour AND names a real part it wants seen again.
const askAgain = (loc, images, round) => J([{
  op: 'new', type: 'rotor', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1],
  reasoning: 'a central hub with radial blades',
  uncertainties: ['blade count unclear'],
  suggestView: { target: subject, reason: 'the hub is hidden by the arm' },
}]);
// A reply that is sure of itself: exact colour, no doubt, no request.
const askNothing = (loc) => J([{
  op: 'new', type: 'rotor', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1],
  reasoning: 'a central hub with four radial blades',
}]);
const wire = (f) => ({ plan: f.plan, capture: f.capture, propose: f.propose, persist: f.persist });

{
  const f = makeCampaignFakes(askAgain);
  const joints = []; const man = [];
  const res = await runVisionCampaign(g, joints, man, wire(f));
  const r2 = f.state.asked.filter((a) => a.round === 1);
  const r1 = f.state.asked.filter((a) => a.round === 0);

  ok('J: the campaign runs BOTH rounds and asks the model twice',
    res.ok === true && res.roundCount === 2 && f.state.propose === 2 && res.rounds.length === 2,
    `${res.roundCount} rounds, ${f.state.propose} turns, added=${res.added}`);
  ok('J: round 2 aimed at the region round 1 ASKED for, and says how it resolved',
    res.rounds[1].regions?.length >= 1 && res.rounds[1].regions[0].how === 'name'
      && res.rounds[1].regions[0].names >= 1,
    J(res.rounds[1].regions?.map((x) => `${x.id}:${x.how}:${x.names}`)));
  ok('J: round 2 shoots CLOSE-UPS, never another whole-model survey',
    r2.length > 0 && r2.every((a) => a.kind === 'close-up'),
    J([...new Set(r2.map((a) => a.kind))]));
  ok('J: round 1 shot the survey and round 2 did not repeat it',
    r1.length > 0 && r1.some((a) => a.kind !== 'close-up'),
    `${r1.length} survey frames, ${r2.length} close-up frames`);
  // The whole justification for round 2: the part the model could not make out is
  // actually IN one of the new frames. A close-up that misses it is a wasted turn.
  ok('J: the disputed part is actually FRAMED by round 2',
    r2.some((a) => a.sees.includes(subject)), `${subject} in ${r2.filter((a) => a.sees.includes(subject)).length}/${r2.length} frames`);
  ok('J: round 2 masks stay focused, so their legend stays readable',
    r2.filter((a) => a.mode === 'colorId').every((a) => a.focus > 0),
    J(r2.filter((a) => a.mode === 'colorId').map((a) => `${a.viewId}:${a.focus}`)));
  ok('J: round 2 sends a DIFFERENT turn, not the same images again',
    f.state.prompts.length === 2 && f.state.prompts[1] !== f.state.prompts[0]
      && f.state.prompts[1].includes('close-up'),
    `${f.state.prompts[0].length} vs ${f.state.prompts[1].length} chars`);
  ok('J: BOTH rounds persisted their own plan, reply and proposals',
    [0, 1].every((r) => f.state.saved[r]?.plan === 1 && f.state.saved[r]?.reply && f.state.saved[r]?.proposals),
    J(Object.fromEntries(Object.entries(f.state.saved).map(([k, v]) => [k, { plan: v.plan, reply: !!v.reply, proposals: !!v.proposals }]))));
  ok('J: the round ceiling and the extra-view ceiling are reported',
    res.maxRounds === MAX_VISION_ROUNDS && res.extraBudget === MAX_EXTRA_VIEWS
      && res.extraViews <= MAX_EXTRA_VIEWS && res.rounds[1].frames <= MAX_EXTRA_VIEWS,
    `extraViews spent ${res.extraViews} of ${res.extraBudget}`);
  ok('J: the campaign aggregates what its rounds found',
    res.added >= 1 && man.length >= 1 && res.frames === r1.length + r2.length
      && res.grounded.every((x) => Number.isFinite(x.round)),
    `added=${res.added} frames=${res.frames} grounded tagged ${[...new Set(res.grounded.map((x) => x.round))].join(',')}`);
  ok('J: a campaign that merged something reports the manifest as touched',
    res.manifestUntouched === false);
}

// The bounds are HARD: they may be lowered by a caller, never raised. A knob that
// could raise them would undo the bounded-auto decision the whole design rests on.
{
  const f = makeCampaignFakes(askAgain);
  const res = await runVisionCampaign(g, [], [], { ...wire(f), rounds: 9, extraViews: 99 });
  ok('J: asking for 9 rounds buys MAX_VISION_ROUNDS, and says so',
    res.maxRounds === MAX_VISION_ROUNDS && res.roundCount <= MAX_VISION_ROUNDS
      && res.warnings.some((w) => /rounds=9 was capped/.test(w)),
    `${res.roundCount} rounds; ${res.warnings.find((w) => /capped/.test(w)) || 'no warning'}`);
  ok('J: asking for 99 extra views buys MAX_EXTRA_VIEWS, and says so',
    res.extraBudget === MAX_EXTRA_VIEWS && res.extraViews <= MAX_EXTRA_VIEWS
      && res.warnings.some((w) => /extraViews=99 was capped/.test(w)),
    `${res.extraViews} of ${res.extraBudget}`);
  const one = makeCampaignFakes(askAgain);
  const r1 = await runVisionCampaign(g, [], [], { ...wire(one), rounds: 1 });
  ok('J: rounds:1 is honoured — a caller may narrow the loop',
    r1.maxRounds === 1 && r1.roundCount === 1 && one.state.propose === 1
      && r1.suggestViews.length > 0, `${r1.roundCount} round, ${r1.suggestViews.length} suggestions left unspent`);
  const zero = makeCampaignFakes(askAgain);
  const r0 = await runVisionCampaign(g, [], [], { ...wire(zero), extraViews: 0 });
  ok('J: with no extra-view budget there is no round 2',
    r0.roundCount === 1 && r0.extraBudget === 0 && /budget/.test(r0.stop || ''), r0.stop);
}

// Early termination. A second look is only worth six frames if it could answer
// something the first one could not.
{
  const sure = makeCampaignFakes(askNothing);
  const res = await runVisionCampaign(g, [], [], wire(sure));
  ok('J: a round that asks for nothing earns no second look',
    res.roundCount === 1 && sure.state.propose === 1 && /asked for nothing/.test(res.stop || ''),
    res.stop);

  // Seed the doubts round 1 is about to declare, then require that they earn
  // nothing. This is the reachable form of "no new uncertainties": the seed
  // normally comes from the manifest, not from a caller.
  const probe = makeCampaignFakes(askAgain);
  const p = await runVisionCampaign(g, [], [], { ...wire(probe), rounds: 1 });
  const known = [
    ...(p.rounds[0].grounded || []).flatMap((e) => (e.uncertainties || []).map((u) => `u:${u}`)),
    ...(p.rounds[0].suggestViews || []).map((s) => `s:${s.target ?? ''}|${s.reason ?? ''}`),
  ];
  const seeded = makeCampaignFakes(askAgain);
  const res2 = await runVisionCampaign(g, [], [], { ...wire(seeded), knownDoubts: known });
  ok('J: a round that only repeats a doubt already on the books earns no second look',
    known.length > 0 && res2.roundCount === 1 && /no NEW uncertainty/.test(res2.stop || ''),
    `${known.length} known doubts; ${res2.stop}`);

  // The REAL form of the same rule: records carry the doubts that produced them,
  // so pressing the button twice does not photograph the same hidden hub twice.
  const a = makeCampaignFakes(askAgain);
  const joints = []; const man = [];
  const first = await runVisionCampaign(g, joints, man, wire(a));
  ok('J: round 1 records carry the doubt they declared, onto the manifest',
    man.some((r) => Array.isArray(r.uncertainties) && r.uncertainties.length)
      && man.some((r) => r.suggestView?.target === subject),
    J(man.map((r) => ({ u: (r.uncertainties || []).length, sv: r.suggestView?.target ?? null }))));
  const b = makeCampaignFakes(askAgain);
  const second = await runVisionCampaign(g, joints, man, wire(b));
  ok('J: a SECOND campaign over the same manifest does not re-chase the same doubt',
    first.roundCount === 2 && second.roundCount === 1 && /no NEW uncertainty/.test(second.stop || ''),
    `${first.roundCount} rounds then ${second.roundCount}; ${second.stop}`);
}

// Replay: a preset frame list must drive round 1 with NO renderer attached, and
// must NOT be handed to round 2 — feeding round 1's pixels to round 2's prompt
// would look like a working active loop and answer nothing.
{
  const pv = bigPlan.views.find((v) => Array.isArray(v.sees) && v.sees.length);
  const focus = pv.sees.slice(0, 5);
  const colorMap = {};
  focus.forEach((nm, i) => { colorMap[hexOf(i)] = nm; });
  const preset = [{
    id: frameKey(pv.id, 'colorId'), viewId: pv.id, mode: 'colorId',
    pose: pv.pose, spec: pv.spec, covers: pv.covers, sees: pv.sees, focus,
    mediaType: 'image/png', dataBase64: PNG, colorMap,
  }];
  const f = makeCampaignFakes(askAgain);
  const res = await runVisionCampaign(g, [], [], { ...wire(f), frames: preset });
  const perRound = (r) => f.state.asked.filter((a) => a.round === r).length;
  ok('J: a preset frame list replays round 1 without touching the renderer',
    res.rounds[0].frames === 1 && perRound(0) === 0,
    `${perRound(0)} captures in round 1`);
  ok('J: the preset is NOT reused for round 2, which captures for real',
    res.roundCount === 2 && perRound(1) > 0 && res.rounds[1].frames === perRound(1),
    `${perRound(1)} captures in round 2`);
  ok('J: round 2 still resolves its regions from the REPLAYED frames',
    res.rounds[1].regions?.length >= 1,
    J(res.rounds[1].regions?.map((x) => `${x.how}:${x.names}`)));

  // The full replay claim: a per-round factory is asked once per round, and with
  // frames supplied for BOTH the entire active loop runs with no renderer and no
  // model attached — which is what makes a persisted run resumable.
  const askedRounds = [];
  const g2 = makeCampaignFakes(askAgain);
  const res2 = await runVisionCampaign(g, [], [], {
    ...wire(g2),
    frames: (r) => { askedRounds.push(r); return preset; },
  });
  const replayed = (r) => g2.state.asked.filter((a) => a.round === r).length;
  ok('J: a per-round preset factory can replay the WHOLE campaign with no renderer',
    askedRounds.join() === '0,1' && replayed(0) === 0 && replayed(1) === 0
      && res2.roundCount === 2 && res2.frames === 2,
    `preset asked for rounds ${askedRounds.join(',')}; ${replayed(0) + replayed(1)} captures`);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? 'VISION_PROBE_FAILED' : 'VISION_PROBE_OK');
process.exit(fail ? 1 : 0);
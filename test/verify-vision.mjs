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
//   H) every failure path bails with the manifest provably untouched, and an
//      empty reply counts as success rather than as a crash
//   I) the model's reasoning and doubts survive the trip to the wire the UI reads
//
// Usage: node test/verify-vision.mjs
import { parseGlb } from '../src/lib/gltf.mjs';
import { makeCamera, namedIndex, nodeBox, planViews, rectOf, renderTargets } from '../src/plugins/discovery/views.mjs';
import {
  cloudAnchor, cloudAxis, visionPropose, L2_VISION_BASE_CONFIDENCE,
} from '../src/plugins/discovery/vision-propose.mjs';
import { MAX_EXTRA_VIEWS, MAX_VISION_ROUNDS, runVisionCampaign, runVisionRound, selectShots } from '../src/plugins/discovery/loop.mjs';
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
  // The derived anchor must actually be near the part that was pointed at.
  const bb = nodeBox(nameOfMesh.get(subject));
  const d = rec0 ? Math.hypot(rec0.anchor.x - bb.c[0], rec0.anchor.y - bb.c[1], rec0.anchor.z - bb.c[2]) : Infinity;
  ok('B: the geometry anchor is near the pointed-at part', d < 40, `d=${d.toFixed(2)} units`);
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
      const r = bad(J([{ op: 'new', type: 'hinge', nodeIds: [other, third], axis: [0, 0, 1] }]), manifest());
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
  ok('G: EVERY mask is paired with a PHOTO OF THE SAME POSE',
    of('colorId').every((s) => {
      const i = shots.indexOf(s);
      return i > 0 && shots[i - 1].mode === 'photo' && shots[i - 1].viewId === s.viewId;
    }),
    J(of('colorId').map((s) => `${shots[shots.indexOf(s) - 1]?.viewId}/${shots[shots.indexOf(s) - 1]?.mode}+${s.viewId}/${s.mode}`)));
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
    man[0]?.tests?.length === 3, J((man[0]?.tests || []).map((t) => `${t.name}:${t.pass}`)));
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
function makeCampaignFakes(replyOf) {
  const state = { plan: 0, capture: 0, propose: 0, prompts: [], asked: [], saved: {} };
  return {
    state,
    plan: () => { state.plan += 1; return bigPlan; },
    capture: async (view, mode, focusNodes) => {
      state.capture += 1;
      // `propose` runs once per round AFTER every capture, so its count is the
      // round index while frames are being drawn.
      state.asked.push({
        round: state.propose, viewId: view.id, kind: view.spec?.kind ?? null,
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
      if (!state.saved[r]) state.saved[r] = { plan: 0, frame: 0, reply: null, proposals: null };
      const b = state.saved[r];
      return {
        plan: () => { b.plan += 1; },
        frame: () => { b.frame += 1; },
        reply: (x) => { b.reply = x; },
        proposals: (x) => { b.proposals = x; },
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
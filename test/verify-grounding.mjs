// Grounding proof — the automated answer to "when a vision model points at a
// region of a frame, do we resolve it to the RIGHT graph nodes, and do we notice
// when we cannot?"
//
// Five legs, exit 0 only if all hold:
//   A) box normalization absorbs the shapes a model actually emits (fractions,
//      pixels, xywh, reversed corners) and refuses a degenerate region
//   B) boxToNodes grounds real geometry: the part a box was drawn around comes
//      back FIRST, and still comes back first when the box carries VLM slop
//   C) a big background part behind the subject does not outrank the subject —
//      the inside/fill weighting is what prevents that specific error
//   D) colorIdToNodes is an exact lookup: near-miss colours are reported unknown
//      rather than approximated to the nearest painted id
//   E) reconcile/groundRegion treat disagreement as evidence — the colour channel
//      wins, and the clash is carried out as an uncertainty, never averaged away
//
// Usage: node test/verify-grounding.mjs
import { parseGlb } from '../src/lib/gltf.mjs';
import { makeCamera, namedIndex, nodeBox, planViews, rectOf, renderTargets } from '../src/plugins/discovery/views.mjs';
import {
  BOX_DILATE, boxToNodes, colorIdToNodes, dilateBox, groundRegion, normBox,
  normalizeColor, reconcile,
} from '../src/plugins/discovery/grounding.mjs';

const GLB = 'samples/drone_dji_inspire3.glb';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}${extra ? ' \u2014 ' + extra : ''}`); } else { fail += 1; console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
};

console.log('\nProving vision grounding\n');

// ---- A) box normalization ----------------------------------------------------
{
  const frac = normBox([0.2, 0.3, 0.6, 0.7]);
  ok('A: a fractional box is accepted as-is',
    frac && !frac.pixels && frac.x0 === 0.2 && frac.y1 === 0.7, JSON.stringify(frac));

  // Models switch between 0..1 and pixel conventions without warning. Values that
  // divide the 1024 frame exactly, so the assertion is exact rather than tolerant.
  const px = normBox([256, 384, 640, 768]);
  ok('A: a pixel box is auto-detected and normalized',
    px && px.pixels === true && px.x0 === 0.25 && px.y0 === 0.375 && px.x1 === 0.625 && px.y1 === 0.75,
    `${px?.x0},${px?.y0} -> ${px?.x1},${px?.y1}`);

  // The failure this guards: a sloppy FRACTIONAL box with one coordinate past 1
  // must not be misread as pixels and divided by 1024 into a speck.
  const sloppy = normBox([-0.5, 0.1, 1.9, 0.8]);
  ok('A: a sloppy fractional box is not misread as pixels',
    sloppy && sloppy.pixels === false && sloppy.x0 === 0 && sloppy.x1 === 1 && sloppy.y0 === 0.1 && sloppy.y1 === 0.8,
    JSON.stringify(sloppy));

  ok('A: coordinates beyond the frame in EITHER convention are refused, not clamped',
    normBox([0, 0, 5000, 5000]) === null, 'clamping junk would ground to the whole model');

  const xywh = normBox({ x: 0.2, y: 0.3, w: 0.4, h: 0.4 });
  ok('A: an xywh box is converted to corners',
    xywh && Math.abs(xywh.x1 - 0.6) < 1e-9 && Math.abs(xywh.y1 - 0.7) < 1e-9, JSON.stringify(xywh));

  const rev = normBox([0.6, 0.7, 0.2, 0.3]);
  ok('A: reversed corners are sorted, not rejected',
    rev && rev.x0 === 0.2 && rev.x1 === 0.6 && rev.y0 === 0.3 && rev.y1 === 0.7);

  const oob = normBox([-0.2, 0.1, 1.1, 0.8]);
  ok('A: mildly out-of-frame coordinates are clamped into the frame',
    oob && oob.x0 === 0 && oob.x1 === 1, JSON.stringify(oob));

  ok('A: a degenerate region is refused rather than grounding everything',
    normBox([0.5, 0.5, 0.5, 0.5]) === null && normBox([0.5, 0.5, 0.50001, 0.6]) === null);
  ok('A: junk is refused, not coerced',
    normBox(null) === null && normBox('rotor') === null && normBox([1, 2]) === null && normBox({}) === null);

  const d = dilateBox({ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }, BOX_DILATE);
  ok('A: dilation grows proportionally to the box, not absolutely',
    Math.abs(d.x0 - 0.38) < 1e-9 && Math.abs(d.x1 - 0.62) < 1e-9, `10% of a 0.2 box -> ${d.x0.toFixed(3)}..${d.x1.toFixed(3)}`);
  ok('A: dilation never leaves the frame',
    (() => { const e = dilateBox({ x0: 0, y0: 0, x1: 1, y1: 1 }, 0.5); return e.x0 === 0 && e.x1 === 1 && e.y0 === 0 && e.y1 === 1; })());
}

// ---- B/C) box grounding against real geometry --------------------------------
const g = await parseGlb(GLB);
const plan = planViews(g, { maxViews: 4 });
const named = namedIndex(g);
const targets = renderTargets(g);
const nameOfMesh = new Map();
for (const n of targets) if (!nameOfMesh.has(named.get(n.i))) nameOfMesh.set(named.get(n.i), n);

// A deterministic jitter, because "still grounds with slop" must be reproducible.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

{
  const v = plan.views[0];
  const cam = makeCamera(v.pose.eye, v.pose.target);
  ok('B: the plan yields a pose to ground against',
    !!v && v.pose?.eye?.length === 3 && (v.sees || []).length > 0,
    `${v?.id} d=${v?.spec?.distance?.toFixed?.(1)} sees=${v?.sees?.length}`);

  // Ground the planner's OWN predicted parts: for each, build the exact box its
  // projection occupies and require it to come back first. This is the strongest
  // available oracle — if the box that a part really projects to does not ground
  // to that part, the scoring is wrong.
  const probe = (v.sees || []).slice(0, 12).map((nm) => nameOfMesh.get(nm)).filter(Boolean);
  let top1 = 0; let top3 = 0; const ranks = [];
  for (const n of probe) {
    const r = rectOf(nodeBox(n), cam);
    if (!r) continue;
    const res = boxToNodes([r.x0 / cam.w, r.y0 / cam.h, r.x1 / cam.w, r.y1 / cam.h], v, g, {});
    const rank = res.candidates.findIndex((c) => c.i === n.i || c.name === named.get(n.i));
    ranks.push(rank);
    if (rank === 0) top1 += 1;
    if (rank >= 0 && rank < 3) top3 += 1;
  }
  ok('B: an exact box over a part grounds to that part FIRST',
    top1 === probe.length && probe.length > 5, `${top1}/${probe.length} top-1`);
  ok('B: grounding returns a ranked candidate set, not a single guess',
    top3 === probe.length, `${top3}/${probe.length} within top-3; worst rank ${Math.max(...ranks)}`);

  // VLM slop: 10% dilation is the default because models are routinely off by
  // that much, and thin parts (blades, arms) are worse.
  let slopTop1 = 0; let slopAny = 0;
  for (const n of probe) {
    const r = rectOf(nodeBox(n), cam);
    if (!r) continue;
    const w = (r.x1 - r.x0) / cam.w; const h = (r.y1 - r.y0) / cam.h;
    const jx = (rnd() - 0.5) * 0.12 * Math.max(w, 0.02);
    const jy = (rnd() - 0.5) * 0.12 * Math.max(h, 0.02);
    const res = boxToNodes([r.x0 / cam.w + jx, r.y0 / cam.h + jy, r.x1 / cam.w + jx, r.y1 / cam.h + jy], v, g, {});
    const rank = res.candidates.findIndex((c) => c.name === named.get(n.i));
    if (rank === 0) slopTop1 += 1;
    if (rank >= 0 && rank < 5) slopAny += 1;
  }
  ok('B: a box carrying realistic VLM slop still grounds the right part',
    slopAny === probe.length && slopTop1 >= probe.length * 0.7,
    `${slopTop1}/${probe.length} top-1, ${slopAny}/${probe.length} within top-5`);

  // C) the backdrop error: a big part BEHIND the subject contains the whole box,
  // so `fill` alone would rank it first. `inside` must dominate.
  const small = probe.map((n) => ({ n, r: rectOf(nodeBox(n), cam) })).find((x) => x.r && x.r.area < 4000);
  if (small) {
    const res = boxToNodes([small.r.x0 / cam.w, small.r.y0 / cam.h, small.r.x1 / cam.w, small.r.y1 / cam.h], v, g, {});
    const winner = res.candidates[0];
    const bigger = res.candidates.find((c) => c.name !== winner.name && c.fill > 0.5 && c.rect.area > winner.rect.area * 4);
    ok('C: a large backdrop behind the subject does not outrank the subject',
      !!winner && winner.inside >= (bigger ? bigger.inside : 0) && (!bigger || winner.score > bigger.score),
      bigger
        ? `subject ${winner.name} inside=${winner.inside.toFixed(2)} score=${winner.score.toFixed(2)} vs backdrop ${bigger.name} inside=${bigger.inside.toFixed(2)} fill=${bigger.fill.toFixed(2)} score=${bigger.score.toFixed(2)}`
        : `subject ${winner?.name} inside=${winner?.inside?.toFixed(2)} (no larger high-fill backdrop in this box)`);
  } else {
    ok('C: a large backdrop behind the subject does not outrank the subject', false, 'no small part in this pose to test against');
  }

  // Depth ordering: a model points at a visible surface, so among comparable
  // scores the nearer part must come first.
  const anyBox = boxToNodes([0.2, 0.2, 0.8, 0.8], v, g, {});
  ok('C: candidates are ranked by score then depth',
    anyBox.candidates.every((c, i) => i === 0
      || anyBox.candidates[i - 1].score > c.score
      || (Math.abs(anyBox.candidates[i - 1].score - c.score) < 1e-12 && anyBox.candidates[i - 1].depth <= c.depth)),
    `${anyBox.candidates.length} candidates, depth ${anyBox.candidates[0]?.depth?.toFixed(0)}..${anyBox.candidates.at(-1)?.depth?.toFixed(0)}`);

  ok('C: an empty region of the frame grounds to nothing, with a reason',
    (() => { const r = boxToNodes([0.0, 0.0, 0.02, 0.02], v, g, {}); return r.candidates.length === 0 && r.warnings.length > 0; })());
  ok('C: a malformed box is refused, not grounded to the whole model',
    boxToNodes(null, v, g, {}).candidates.length === 0 && boxToNodes('rotor', v, g, {}).candidates.length === 0);
  ok('C: a box with no pose is refused', boxToNodes([0.2, 0.2, 0.8, 0.8], {}, g, {}).candidates.length === 0);
  ok('C: grounding collapses mesh fragments to the named part',
    anyBox.candidates.every((c) => !/^Object_\d+$/.test(c.name)),
    `${new Set(anyBox.candidates.map((c) => c.name)).size} distinct names`);
}

// ---- D) colour id channel ----------------------------------------------------
{
  // A map shaped exactly like the one captureAt() stores beside a colorId frame.
  const colorMap = { '#9ec091': '65_6_109', '#3c8224': '66_3_112', '#da43b5': '65_2_249', '#4040f1': 'rotor_fl_3' };

  const one = colorIdToNodes(colorMap, '#9ec091');
  ok('D: a painted colour resolves to exactly one node name',
    one.names.length === 1 && one.names[0] === '65_6_109' && one.unknown.length === 0, JSON.stringify(one.names));

  const many = colorIdToNodes(colorMap, ['#3c8224', '#da43b5']);
  ok('D: several colours resolve to several names',
    many.names.length === 2 && many.names.includes('66_3_112') && many.names.includes('65_2_249'));

  ok('D: colour notation is normalized, not string-matched',
    colorIdToNodes(colorMap, '9EC091').names[0] === '65_6_109'
    && colorIdToNodes(colorMap, '0x9ec091').names[0] === '65_6_109'
    && colorIdToNodes(colorMap, '#9e9').names.length === 0,
    `#9e9 -> ${normalizeColor('#9e9')} (a 3-digit id is NOT the same colour)`);

  // The critical case: an antialiased edge blends two ids into a colour that was
  // never painted. Approximating it to the nearest id would ground the wrong part
  // and look like success, so it must come back unknown.
  const blend = colorIdToNodes(colorMap, '#6da15c');
  ok('D: an unpainted blend colour is reported unknown, never approximated',
    blend.names.length === 0 && blend.unknown.length === 1 && /not painted/.test(blend.unknown[0].reason),
    `${blend.unknown[0]?.color} ${blend.unknown[0]?.reason}`);

  ok('D: junk colour input is reported, not thrown',
    colorIdToNodes(colorMap, 'the red one').names.length === 0
    && colorIdToNodes(colorMap, 'the red one').unknown[0].reason === 'not a colour');
  ok('D: a mixed batch keeps the exact hits and reports the misses',
    (() => { const r = colorIdToNodes(colorMap, ['#4040f1', '#000000', 'nonsense']); return r.names.length === 1 && r.names[0] === 'rotor_fl_3' && r.unknown.length === 2; })());
  ok('D: an empty map grounds nothing but still reports what it was asked',
    (() => { const r = colorIdToNodes({}, ['#9ec091']); return r.names.length === 0 && r.painted === 0 && r.unknown.length === 1; })());
  ok('D: a duplicate colour does not duplicate the name',
    colorIdToNodes(colorMap, ['#9ec091', '#9EC091', '9ec091']).names.length === 1);
}

// ---- E) reconcile + the combined entry point ---------------------------------
{
  const agree = reconcile(['a', 'b', 'c'], ['a', 'b', 'c']);
  ok('E: identical channels reconcile as full agreement',
    agree.verdict === 'agree' && agree.score === 1 && agree.jaccard === 1 && agree.both.length === 3);

  // The asymmetry that matters: the box channel is DILATED ON PURPOSE and expected
  // to over-include, so a precise claim naming a subset of it is agreement, not a
  // clash. Jaccard here would be 0.5 and read as disagreement.
  const coarse = reconcile(['a', 'b', 'c', 'd'], ['a', 'b']);
  ok('E: a precise claim contained in a coarse box set reconciles as agreement',
    coarse.verdict === 'agree' && coarse.score === 1 && coarse.jaccard === 0.5
    && coarse.boxOnly.join() === 'c,d' && coarse.colorOnly.length === 0,
    `score=${coarse.score.toFixed(2)} jaccard=${coarse.jaccard.toFixed(2)} boxOnly=[${coarse.boxOnly}] (expected extras)`);

  // The signal that actually matters: a colour-identified part lying OUTSIDE the
  // region the model pointed at.
  const partial = reconcile(['a', 'b'], ['a', 'b', 'x']);
  ok('E: a colour-identified part outside the box reconciles as partial, naming it',
    partial.verdict === 'partial' && Math.abs(partial.score - 2 / 3) < 1e-9 && partial.colorOnly.join() === 'x',
    `score=${partial.score.toFixed(2)} colorOnly=[${partial.colorOnly}]`);

  const clash = reconcile(['a', 'b'], ['x', 'y']);
  ok('E: disjoint channels reconcile as a disagreement, not as a low score to ignore',
    clash.verdict === 'disagree' && clash.score === 0 && clash.both.length === 0
    && clash.boxOnly.join() === 'a,b' && clash.colorOnly.join() === 'x,y');

  ok('E: a missing channel is named, and an absent box is not a clash',
    reconcile(['a'], []).verdict === 'box-only' && reconcile([], ['a']).verdict === 'color-only'
    && reconcile([], []).verdict === 'empty');

  // The combined path: colour wins, and the clash is carried out as an uncertainty.
  const v = plan.views[0];
  const cam = makeCamera(v.pose.eye, v.pose.target);
  const subject = (v.sees || []).map((nm) => nameOfMesh.get(nm)).find((n) => n && rectOf(nodeBox(n), cam));
  const r = rectOf(nodeBox(subject), cam);
  const box = [r.x0 / cam.w, r.y0 / cam.h, r.x1 / cam.w, r.y1 / cam.h];
  const subjectName = named.get(subject.i);

  const boxOnly = groundRegion({ box, view: v, g });
  ok('E: box-only grounding resolves the region and says it is geometric',
    boxOnly.names.includes(subjectName) && boxOnly.source === 'box'
    && boxOnly.uncertainties.some((u) => /box only/.test(u)),
    `${boxOnly.names.length} names via ${boxOnly.source}, top=${boxOnly.candidates[0]?.name}`);

  const both = groundRegion({ box, colors: ['#112233'], view: v, g, colorMap: { '#112233': subjectName } });
  ok('E: agreeing channels ground exactly and report agreement',
    both.names.length === 1 && both.names[0] === subjectName && both.source === 'colorId+box'
    && both.agreement.verdict === 'agree' && both.uncertainties.length === 0,
    `verdict=${both.agreement.verdict} score=${both.agreement.score.toFixed(2)}`);

  // The case that matters most: the model read a colour from a DIFFERENT part than
  // the one its box encloses. Silently preferring either would hide a real error.
  const clashRegion = groundRegion({ box, colors: ['#aabbcc'], view: v, g, colorMap: { '#aabbcc': 'some_other_part' } });
  ok('E: on a clash the exact colour channel wins AND the clash is recorded',
    clashRegion.names.length === 1 && clashRegion.names[0] === 'some_other_part'
    && clashRegion.agreement.verdict === 'disagree'
    && clashRegion.uncertainties.some((u) => /clash/.test(u)),
    `names=[${clashRegion.names}] verdict=${clashRegion.agreement.verdict} — "${clashRegion.uncertainties[0]?.slice(0, 90)}"`);
  ok('E: a clash still carries the box candidates so a human can adjudicate',
    clashRegion.candidates.length > 0 && clashRegion.candidates.some((c) => c.name === subjectName),
    `${clashRegion.candidates.length} box candidates retained`);

  const nothing = groundRegion({ box: [0, 0, 0.001, 0.001], view: v, g });
  ok('E: an ungroundable region says so instead of returning an empty joint',
    nothing.names.length === 0 && nothing.source === 'none'
    && nothing.uncertainties.some((u) => /could not be grounded/.test(u)));
  ok('E: grounding with no inputs at all is a clean empty result, not a throw',
    (() => { const e = groundRegion({}); return e.names.length === 0 && e.source === 'none' && e.agreement.verdict === 'empty'; })());
}

console.log(`\n${fail === 0 ? 'GROUNDING_PROBE_OK' : 'GROUNDING_PROBE_FAILED'} \u2014 ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

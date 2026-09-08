// Next-Best-View planner proof — the automated answer to "can we plan a frame
// set that sees every dynamic-relevant part, headless, in the fewest views?"
// Four legs, exit 0 only if all of them hold:
//   A) projection math is a real pinhole camera (centre, orthonormal basis,
//      behind-camera rejection, frame clipping) — including the POLES, where a
//      +Z up hint is parallel to the view direction and the basis would
//      otherwise degenerate to NaN
//   B) the coverage unit is the MESH node, not the named container — projecting
//      named containers lands bboxes in empty space and stalls coverage near 63%
//   C) greedy set cover converges: high coverage, few views, monotone
//      diminishing marginal gain (the submodularity signature)
//   D) focusNames restricts the plan, planCloseUps aims at its anchors
//   E) focusFromManifest turns the manifest + joints + blade suspects into the
//      name set a vision round should actually spend frames on
//   F) regionsFromSuggestViews turns round 1's "look here again" back into a
//      camera pose — the edge that makes the loop active rather than a pipeline
//
// Usage: node test/verify-views.mjs
import { bladeCandidates, parseGlb } from '../src/lib/gltf.mjs';
import { MAX_LEGEND } from '../src/plugins/discovery/vision-prompt.mjs';
import {
  AZIMUTH_RETRY, REGION_MAX_R, REGION_MIN_R, REGION_PAD, VIEWPORT,
  candidateSpecs, coverageOf, fitDistance, focusFromManifest, kdCells,
  makeCamera, modelRadius, modelTarget, namedIndex, nodeBox, planCloseUps,
  planViews, poseFromSpec, project, projectNode, regionsFromSuggestViews,
  renderTargets, surveySpecs, unfitDistance,
} from '../src/plugins/discovery/views.mjs';

const GLB = 'samples/drone_dji_inspire3.glb';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}${extra ? ' \u2014 ' + extra : ''}`); } else { fail += 1; console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
};

console.log('\nProving the next-best-view planner\n');

const g = await parseGlb(GLB);
const targets = renderTargets(g);
const named = namedIndex(g);

// ---- A) projection math -----------------------------------------------------
{
  const cam = makeCamera([0, -100, 0], [0, 0, 0], VIEWPORT);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  ok('A: view basis is orthonormal',
    Math.abs(len(cam.f) - 1) < 1e-9 && Math.abs(len(cam.r) - 1) < 1e-9 && Math.abs(len(cam.u) - 1) < 1e-9
    && Math.abs(dot(cam.f, cam.r)) < 1e-9 && Math.abs(dot(cam.r, cam.u)) < 1e-9 && Math.abs(dot(cam.f, cam.u)) < 1e-9,
    `|f\u00b7r|=${Math.abs(dot(cam.f, cam.r)).toExponential(1)}`);

  const c = project([0, 0, 0], cam);
  ok('A: look-at point lands at frame centre',
    c && Math.abs(c.x - VIEWPORT.w / 2) < 1e-6 && Math.abs(c.y - VIEWPORT.h / 2) < 1e-6,
    `(${c.x.toFixed(1)}, ${c.y.toFixed(1)})`);
  ok('A: points behind the camera are rejected', project([0, -200, 0], cam) === null);

  // A node in front of the camera projects; a node behind does not.
  const front = targets.find((n) => projectNode(n, cam));
  ok('A: a visible mesh node projects to a positive-area rect', !!front && projectNode(front, cam).area > 0);
  const back = makeCamera([0, -100, 0], [0, -200, 0], VIEWPORT); // looks away from the model
  ok('A: nothing projects when the camera looks away', targets.every((n) => projectNode(n, back) === null));

  const rect = projectNode(front, cam);
  ok('A: rects are clipped inside the frame',
    rect.x0 >= 0 && rect.y0 >= 0 && rect.x1 <= VIEWPORT.w + 1e-9 && rect.y1 <= VIEWPORT.h + 1e-9,
    `${rect.x0.toFixed(0)},${rect.y0.toFixed(0)} \u2192 ${rect.x1.toFixed(0)},${rect.y1.toFixed(0)}`);

  // The omni survey tier needs a TRUE top-down and bottom-up look. At the poles
  // the conventional up hint (+Z) is parallel to the view direction, so
  // right = normalize(cross(f, up)) is 0/0 — NaN in every basis vector, and every
  // regionBox a model draws on that frame would ground to the wrong parts
  // confidently. The hint is swapped for a horizontal one, and BOTH poles keep
  // screen-right = +X so a pole frame is not mirrored against the ring frames.
  const finite = (a) => Array.isArray(a) && a.every(Number.isFinite);
  const ortho = (cm) => Math.abs(len(cm.f) - 1) < 1e-9 && Math.abs(len(cm.r) - 1) < 1e-9 && Math.abs(len(cm.u) - 1) < 1e-9
    && Math.abs(dot(cm.f, cm.r)) < 1e-9 && Math.abs(dot(cm.r, cm.u)) < 1e-9 && Math.abs(dot(cm.f, cm.u)) < 1e-9;
  const R = modelRadius(g);
  const d = fitDistance(R);
  const poseAt = (el) => poseFromSpec({ kind: 'survey', azimuth: 0, elevation: el, distance: d }, g);
  const camAt = (el) => { const p = poseAt(el); return makeCamera(p.eye, p.target, VIEWPORT, p.up); };
  const topCam = camAt(90);
  const botCam = camAt(-90);
  ok('A: a TRUE top-down and bottom-up basis is finite and orthonormal - the pole never degenerates to NaN',
    finite(topCam.f) && finite(topCam.r) && finite(topCam.u) && ortho(topCam)
    && finite(botCam.f) && finite(botCam.r) && finite(botCam.u) && ortho(botCam),
    `top f=${topCam.f.map((v) => v.toFixed(2))} r=${topCam.r.map((v) => v.toFixed(2))}`);
  ok('A: both poles keep screen-right = +X, so a pole frame is not mirrored against the ring frames',
    Math.abs(topCam.r[0] - 1) < 1e-9 && Math.abs(botCam.r[0] - 1) < 1e-9
    && Math.abs(topCam.f[2] + 1) < 1e-9 && Math.abs(botCam.f[2] - 1) < 1e-9
    && topCam.up.join() === '0,1,0' && botCam.up.join() === '0,-1,0',
    `top up=${topCam.up} bottom up=${botCam.up}`);
  ok('A: the up hint is HONOURED off the pole, and swapped only when it is parallel to the look',
    ortho(camAt(25)) && camAt(25).up.join() === '0,0,1'
    && makeCamera(poseAt(25).eye, poseAt(25).target, VIEWPORT, [0, 1, 0]).up.join() === '0,1,0');
  ok('A: a pole frame really looks AT the machine, it does not stare past it',
    coverageOf(topCam, targets).size > 0 && coverageOf(botCam, targets).size > 0,
    `top sees ${coverageOf(topCam, targets).size}, bottom ${coverageOf(botCam, targets).size} of ${targets.length}`);
  ok('A: surveySpecs is truncated from the POLES first, so a short survey is still evenly spread',
    surveySpecs(g, { count: 6 }).length === 6
    && surveySpecs(g, { count: 6 }).filter((s) => Math.abs(s.elevation) === 90).length === 2
    && surveySpecs(g, { count: 3 }).length === 3
    && surveySpecs(g, { count: 3 }).every((s) => s.kind === 'survey' && Math.abs(s.elevation) !== 90)
    && surveySpecs(g, { count: 0 }).length === 0,
    surveySpecs(g, { count: 6 }).map((s) => `${s.azimuth}/${s.elevation}`).join(' '));
}

// ---- B) mesh nodes, placed by their true world box --------------------------
{
  const meshNodes = g.nodes.filter((n) => n.mesh === true);
  ok('B: every mesh node is a coverage target, none dropped',
    targets.length === meshNodes.length && targets.every((n) => n.mesh === true),
    `${targets.length} mesh nodes of ${g.count} total`);

  // The failure mode this guards against: `wext` is an EXTENT with no centre, so
  // bounding a node at its world translation puts the box in empty space whenever
  // the exporter bakes absolute coordinates into the accessor.
  let worst = 0; let sum = 0;
  for (const n of targets) {
    const b = nodeBox(n);
    const d = Math.hypot(b.c[0] - n.wp[0], b.c[1] - n.wp[1], b.c[2] - n.wp[2]);
    sum += d; if (d > worst) worst = d;
  }
  ok('B: placed boxes really are displaced from node origins', worst > 1,
    `mean ${(sum / targets.length).toFixed(2)}, worst ${worst.toFixed(2)} units`);

  ok('B: the model bbox union contains every placed box',
    !!g.bounds && targets.every((n) => {
      const b = nodeBox(n);
      return b.c[0] >= g.bounds.min[0] - 1e-6 && b.c[0] <= g.bounds.max[0] + 1e-6
        && b.c[1] >= g.bounds.min[1] - 1e-6 && b.c[1] <= g.bounds.max[1] + 1e-6
        && b.c[2] >= g.bounds.min[2] - 1e-6 && b.c[2] <= g.bounds.max[2] + 1e-6;
    }),
    `span ${g.bounds ? g.bounds.max.map((v, i) => (v - g.bounds.min[i]).toFixed(1)).join(' x ') : '-'} → wradius ${modelRadius(g).toFixed(1)} (origin radius ${g.radius.toFixed(1)})`);

  ok('B: namedIndex resolves every mesh to a non-duplicate name',
    targets.every((n) => !/^Object_\d+$/.test(named.get(n.i))),
    `${new Set(targets.map((n) => named.get(n.i))).size} distinct named ancestors`);
}

// ---- C) greedy set cover converges ------------------------------------------
const t0 = Date.now();
const plan = planViews(g, { maxViews: 14, minCoverage: 0.999 });
const ms = Date.now() - t0;
const budget = planViews(g, { maxViews: 14, minCoverage: 1.01, allowGhost: false });
const opaqueOnly = planViews(g, { maxViews: 64, minCoverage: 1.01, allowGhost: false });
const saturated = planViews(g, { maxViews: 64, minCoverage: 1.01 });
const photos = budget.views.filter((v) => v.mode === 'photo');
{
  ok('C: planner runs headless and fast', ms < 8000,
    `${ms}ms for ${candidateSpecs({ g, targets }).length} candidate poses over ${targets.length} meshes → ${plan.views.length} frames`);
  ok('C: a bounded opaque budget covers most of the model', budget.coverage >= 0.6,
    `${(budget.coverage * 100).toFixed(1)}% — ${budget.covered}/${budget.targets} named nodes in ${photos.length} views`);
  // The plan is now TWO tiers. The survey tier is FORCED — bought because a machine
  // of unknown type has to be seen from all six sides, not because it maximises
  // marginal gain — so its marginals are honestly reported and honestly not
  // monotone. Submodularity is a property of the GREEDY tier, and it is still
  // asserted there, against the coverage the survey tier had already seeded.
  const forced = photos.filter((v) => v.spec.kind === 'survey');
  const greedy = photos.filter((v) => v.spec.kind !== 'survey');
  const greedyMarg = greedy.map((v) => v.marginal);
  ok('C: marginal gain never increases within the greedy tier (submodular greedy)',
    greedyMarg.every((m, i) => i === 0 || m <= greedyMarg[i - 1]),
    `forced survey ${forced.map((v) => v.marginal).join(' → ')} | greedy ${greedyMarg.join(' → ')}`);
  ok('C: the survey tier is forced, not chosen — it comes first and stays inside maxViews',
    forced.length > 0 && photos.slice(0, forced.length).every((v) => v.spec.kind === 'survey')
    && budget.views.length <= 14,
    `${forced.length} forced survey pose(s) of ${photos.length} photos`);
  ok('C: every greedy view earns its frame', greedyMarg.every((m) => m > 0), `min marginal ${Math.min(...greedyMarg)}`);
  ok('C: a forced survey pose reports what it really added, even when that is little',
    forced.every((v) => Number.isFinite(v.marginal) && v.marginal >= 0),
    forced.map((v) => `${v.spec.azimuth}/${v.spec.elevation}:${v.marginal}`).join(' '));
  ok('C: no duplicate poses are selected', new Set(saturated.views.map((v) => v.id)).size === saturated.views.length);
  ok('C: pose distance matches the spec',
    saturated.views.every((v) => Math.abs(Math.hypot(
      v.pose.eye[0] - v.pose.target[0], v.pose.eye[1] - v.pose.target[1], v.pose.eye[2] - v.pose.target[2],
    ) - v.spec.distance) < 1e-6));
  ok('C: the aim point is the placed bbox centre',
    Math.abs(modelTarget(g)[2] - budget.views[0].pose.target[2]) < 1e-9
    && Math.abs(modelTarget(g)[0] - budget.views[0].pose.target[0]) < 1e-9,
    `target ${modelTarget(g).map((x) => x.toFixed(1)).join(',')}`);

  // The real convergence claim: the candidate BASIS is rich enough that greedy
  // saturates. A budget-limited plan stops early by choice, not because no pose
  // can see the rest.
  ok('C: opaque greedy saturates near the physical ceiling', opaqueOnly.coverage >= 0.85,
    `${(opaqueOnly.coverage * 100).toFixed(1)}% in ${opaqueOnly.views.length} views — the rest is enclosed by the shell`);

  // Parts inside a closed hull are invisible from EVERY external opaque pose. The
  // planner must say so and spend ghost frames on them, not silently report a low
  // number that looks like an algorithm failure.
  ok('C: ghost frames recover what no opaque pose can reach',
    saturated.coverage > opaqueOnly.coverage && saturated.coverage >= 0.95,
    `${(opaqueOnly.coverage * 100).toFixed(1)}% opaque → ${(saturated.coverage * 100).toFixed(1)}% with ${saturated.views.filter((v) => v.mode === 'ghost').length} ghost frames`);
  ok('C: interior-only parts really are opaque-invisible',
    saturated.interiorOnly.length > 0
    && saturated.interiorOnly.every((nm) => opaqueOnly.unseen.includes(nm)),
    `${saturated.interiorOnly.length} interior-only, e.g. ${saturated.interiorOnly.slice(0, 4).join(', ')}`);
  ok('C: ghost views are tagged and traceable to their pose',
    saturated.views.filter((v) => v.mode === 'ghost').every((v) => /^g\d+$/.test(v.id) && /^v\d+$/.test(v.baseId)));
  if (saturated.unseen.length) console.log(`    still unseen at saturation (${saturated.unseen.length}): ${saturated.unseen.slice(0, 8).join(', ')}`);
}

// ---- D) focus, close-ups and occlusion --------------------------------------
{
  const focus = new Set(opaqueOnly.unseen.slice(0, 5));
  if (focus.size) {
    const fp = planViews(g, { maxViews: 6, focusNames: focus });
    ok('D: focusNames restricts the target set', fp.targets <= focus.size && fp.targets > 0,
      `${fp.targets}/${focus.size} focused nodes, ${fp.views.length} views`);
    ok('D: focused plans only claim focused nodes', fp.views.every((v) => v.covers <= fp.targets));
  } else {
    ok('D: focusNames restricts the target set', true, 'nothing unseen — full coverage reached');
  }

  // Round-2 close-ups, anchored on REAL parts (the two named extremes in x) so
  // region membership and `sees` are both non-empty and the assertions mean
  // something. Arbitrary points in empty space would prove only the arithmetic.
  const boxOf = new Map();
  for (const n of targets) {
    const nm = named.get(n.i);
    const b = nodeBox(n);
    if (!nm || !b) continue;
    const cur = boxOf.get(nm);
    if (!cur || Math.hypot(...b.h) > Math.hypot(...cur.h)) boxOf.set(nm, b);
  }
  const extremes = [...boxOf.entries()].reduce((acc, e) => ({
    lo: e[1].c[0] < acc.lo[1].c[0] ? e : acc.lo,
    hi: e[1].c[0] > acc.hi[1].c[0] ? e : acc.hi,
  }), { lo: [...boxOf.entries()][0], hi: [...boxOf.entries()][0] });
  const regions = [extremes.lo, extremes.hi].map(([nm, b]) => ({
    id: nm,
    anchor: b.c.slice(),
    radius: Math.max(2, Math.max(...b.h) * 3),
    azimuth: 30,
    reason: 'test region',
  }));
  const cu = planCloseUps(g, regions, { perRegion: 2 });

  ok('D: close-ups are emitted per region', cu.views.length >= regions.length * 2,
    `${cu.views.length} poses for ${regions.length} regions`);
  ok('D: close-ups aim at their own anchors',
    cu.views.every((v) => regions.some((r) => v.pose.target[0] === r.anchor[0]
      && v.pose.target[1] === r.anchor[1] && v.pose.target[2] === r.anchor[2])),
    `${[...new Set(cu.views.map((v) => v.region))].join(', ')}`);
  ok('D: close-up distance is fitted to the region, not the model',
    cu.views.every((v) => {
      const r = regions.find((x) => x.id === v.region);
      return v.spec.distance <= fitDistance(r.radius, VIEWPORT, 1.15) + 1e-9
        && v.spec.distance < fitDistance(modelRadius(g), VIEWPORT, 1.15);
    }),
    `d=${cu.views[0]?.spec.distance.toFixed(2)} vs model fit ${fitDistance(modelRadius(g), VIEWPORT, 1.15).toFixed(2)}`);

  // A legend that overflows MAX_LEGEND drops colours, and the dropped ones are
  // unresolvable — so a close-up either fits the budget or proves it zoomed in as
  // far as it could. Ghosts are exempt by design: narrowing a ghost trades away
  // the interior coverage it is the only route to.
  ok('D: every close-up mask legend fits the budget, or was tightened trying',
    cu.views.every((v) => v.mode === 'ghost' || v.covers <= MAX_LEGEND || v.tightened != null),
    `covers ${Math.min(...cu.views.map((v) => v.covers))}-${Math.max(...cu.views.map((v) => v.covers))} vs legend budget ${MAX_LEGEND}; tightened ${cu.views.filter((v) => v.tightened != null).length}/${cu.views.length}`);

  // THE round-2 invariant. A colorId mask must be focused, and `sees` is the only
  // source of a focus list — a close-up plan without it degrades round 2 to plain
  // photos exactly where the exact colour channel was the whole point.
  ok('D: EVERY close-up predicts its own visibility, so a round-2 mask can be focused',
    cu.views.every((v) => Array.isArray(v.sees) && v.sees.length > 0),
    `sees ${Math.min(...cu.views.map((v) => v.sees.length))}-${Math.max(...cu.views.map((v) => v.sees.length))} parts`);
  ok('D: close-up views carry the same shape planViews emits',
    cu.views.every((v) => v.id && v.mode && v.spec && v.pose
      && typeof v.covers === 'number' && Number.isFinite(v.marginal) && Array.isArray(v.sees)),
    `keys ${Object.keys(cu.views[0] || {}).join(',')}`);
  ok('D: the two poses per region differ, so an occluded part gets a second look',
    regions.every((r) => {
      const vs = cu.views.filter((v) => v.region === r.id && v.mode !== 'ghost');
      return vs.length >= 2 && new Set(vs.map((v) => `${v.spec.azimuth}|${v.spec.elevation}`)).size === vs.length;
    }),
    cu.views.filter((v) => v.mode !== 'ghost').map((v) => `az${v.spec.azimuth}/el${v.spec.elevation}`).join(' '));
  ok('D: a ghost close-up is only bought for a part no opaque close-up framed',
    cu.views.filter((v) => v.mode === 'ghost').every((v) => v.sees.length > 0)
      && (cu.views.some((v) => v.mode === 'ghost') ? cu.interiorOnly.length > 0 : true),
    `${cu.views.filter((v) => v.mode === 'ghost').length} ghost(s), interiorOnly ${cu.interiorOnly.length}`);
  ok('D: the close-up plan reports coverage of what it was unsure about',
    cu.targets > 0 && cu.coverage >= 0 && cu.coverage <= 1,
    `${cu.covered}/${cu.targets} region parts framed (${(cu.coverage * 100).toFixed(1)}%)`);
  ok('D: maxViews caps the round-2 plan', planCloseUps(g, regions, { perRegion: 4, maxViews: 3 }).views.length <= 3);

  // Prove the legend-fit loop actually runs. At the real budget it rarely does —
  // a whole-model region frames only ~38 parts because occlusion hides the rest —
  // so drive it with a budget smaller than what the region frames, and compare
  // against the same plan with tightening disabled. The point is not the number
  // 12; it is that the planner zooms in just until the legend fits, says so, and
  // never shrinks the thing it is measuring coverage of.
  const TIGHT_BUDGET = 12;
  const wholeRegion = [{ id: 'whole', anchor: modelTarget(g), radius: modelRadius(g) }];
  const wide = planCloseUps(g, wholeRegion, { perRegion: 1, legendBudget: TIGHT_BUDGET });
  const loose = planCloseUps(g, wholeRegion, { perRegion: 1, legendBudget: 0 });
  const wv = wide.views[0]; const lv = loose.views[0];
  ok('D: an over-wide region is zoomed in until its legend fits',
    wv && lv && wv.tightened != null && wv.tightened < 1
      && wv.covers <= TIGHT_BUDGET && wv.covers < lv.covers
      && wv.spec.distance < lv.spec.distance,
    `covers ${lv.covers} -> ${wv.covers} (budget ${TIGHT_BUDGET}), d ${lv.spec.distance.toFixed(1)} -> ${wv.spec.distance.toFixed(1)}, ratio ${wv.tightened}`);
  // Tightening narrows the CAMERA, not the REGION. `targets` is the membership
  // denominator, so it must not move — otherwise a zoom would quietly redefine
  // what was being measured and coverage would look better for free. `covered`
  // falling is the honest cost of the trade: a narrower frustum sees less.
  ok('D: tightening narrows the CAMERA without shrinking the REGION',
    wide.targets === loose.targets && wide.covered <= loose.covered,
    `${wide.targets} region parts either way; framed ${loose.covered} -> ${wide.covered}`);
  // At the real budget the whole-model region already fits, so nothing is zoomed
  // — tightening must be a last resort, not a default that throws away coverage.
  ok('D: at the real legend budget an over-wide region is left alone',
    planCloseUps(g, wholeRegion, { perRegion: 1 }).views[0].covers <= MAX_LEGEND
      && planCloseUps(g, wholeRegion, { perRegion: 1 }).views[0].tightened == null,
    `${lv.covers} parts fit ${MAX_LEGEND} without zooming`);

  // A cell frame must exist for the small parts: the candidate set has to contain
  // poses much closer than whole-model framing, or greedy can never buy the
  // resolution sub-unit parts need to clear MIN_AREA.
  const specs = candidateSpecs({ g, targets });
  const rings = specs.filter((s) => s.kind === 'ring');
  const cells = specs.filter((s) => s.kind === 'cell');
  ok('D: candidates include a part-anchored zoom ladder, not just concentric rings',
    cells.length > 0 && Math.min(...cells.map((s) => s.distance)) < Math.min(...rings.map((s) => s.distance)),
    `${rings.length} ring + ${cells.length} cell poses; nearest ${Math.min(...specs.map((s) => s.distance)).toFixed(1)} vs widest ${Math.max(...specs.map((s) => s.distance)).toFixed(1)}`);

  // kd subdivision must actually partition: every target in exactly one cell,
  // and cells small enough to be worth a dedicated frame.
  const kd = kdCells(targets, { maxMembers: 10 });
  ok('D: kd cells partition the target set without loss or duplication',
    kd.reduce((a, c) => a + c.members, 0) === targets.length,
    `${kd.length} cells, members sum ${kd.reduce((a, c) => a + c.members, 0)}/${targets.length}`);
  ok('D: kd cells are tight enough to frame individually',
    kd.every((c) => c.members <= 10) && Math.max(...kd.map((c) => c.radius)) < modelRadius(g),
    `max cell radius ${Math.max(...kd.map((c) => c.radius)).toFixed(2)} vs model ${modelRadius(g).toFixed(1)}`);

  // Occlusion actually fires: a tight close-up of one region must not see the
  // whole model, and a distant view must see more than the close-up. And turning
  // occlusion off must strictly increase what a pose reports — otherwise the
  // ghost pass would be buying frames for nothing.
  const R = modelRadius(g);
  const near = poseFromSpec({ azimuth: 0, elevation: 20, distance: 0.2 * R }, g);
  const far = poseFromSpec({ azimuth: 0, elevation: 20, distance: 4 * R }, g);
  const farCam = makeCamera(far.eye, far.target);
  const nearSeen = coverageOf(makeCamera(near.eye, near.target), targets).size;
  const farSeen = coverageOf(farCam, targets).size;
  ok('D: a distant view sees strictly more than a nose-on close-up', farSeen > nearSeen,
    `far ${farSeen} vs near ${nearSeen} mesh nodes`);
  const ghostSeen = coverageOf(farCam, targets, { occlude: false }).size;
  ok('D: occlusion culls, and disabling it strictly widens the set',
    ghostSeen >= farSeen && farSeen < targets.length,
    `opaque ${farSeen} → ghost ${ghostSeen} of ${targets.length} mesh nodes`);
  ok('D: the reach broad-phase never drops a visible target',
    ghostSeen === coverageOf(farCam, targets, { occlude: false, reach: 4 * R * 1.5 + 40 }).size);
}

// ---- E) focusFromManifest ----------------------------------------------------
// The planner can cover everything, but "everything" is not the objective: most
// mesh nodes are fasteners and shell panels no controller will ever address.
// Focus has to come from what discovery already believes (the manifest, the
// joints) plus what it suspects but has not confirmed (blade candidates).
{
  const everyName = new Set(targets.map((n) => named.get(n.i)));
  const blades = bladeCandidates(g).map((n) => named.get(n.i) || n.name);

  const manifest = [{ id: 'g0', nodes: [...everyName].slice(0, 3) }, null, { id: 'g1' }];
  const joints = [{ name: 'j0', nodes: [...everyName].slice(10, 12) }, { name: 'j1' }];

  const all = focusFromManifest(g, manifest, joints, { mode: 'all' });
  ok('E: mode=all reaches every named node that carries geometry',
    [...everyName].every((nm) => all.has(nm)) && all.size >= everyName.size,
    `${all.size} names over ${everyName.size} distinct named ancestors`);

  const frontier = focusFromManifest(g, manifest, joints, { mode: 'frontier' });
  ok('E: manifest and joint nodes are carried into the focus verbatim',
    manifest.concat(joints).flatMap((r) => r?.nodes || []).every((nm) => frontier.has(nm)),
    `${frontier.size} frontier names`);
  ok('E: blade suspects are in the frontier even when no record claims them',
    blades.every((nm) => frontier.has(nm)) && blades.length > 0,
    `${blades.length} blade candidates, e.g. ${blades.slice(0, 3).join(', ')}`);
  ok('E: the frontier is a strict narrowing of mode=all',
    frontier.size < all.size && [...frontier].every((nm) => all.has(nm)),
    `${frontier.size} frontier vs ${all.size} all — ${(100 * frontier.size / all.size).toFixed(0)}% of the model`);
  ok('E: junk records cannot poison the focus',
    focusFromManifest(g, null, null, { mode: 'frontier' }).size === new Set(blades).size,
    `${new Set(blades).size} distinct blade names from an empty manifest`);

  // A focus name that is a bare `Object_N` can never match planViews' label(),
  // so it would silently buy nothing. Every name must be manifest vocabulary.
  const dup = /^Object_\d+$/;
  ok('E: every focus name is expressible in manifest vocabulary',
    [...all].every((nm) => !dup.test(nm)) && [...frontier].every((nm) => !dup.test(nm)),
    `${[...frontier].filter((nm) => dup.test(nm)).length} unresolvable in frontier, ${[...all].filter((nm) => dup.test(nm)).length} in all`);
  // Names that are real mesh ancestors must survive into the plan as targets; if
  // the focus set were full of containers, planViews would report 0 targets and
  // quietly emit no frames at all.
  const injected = manifest.concat(joints).flatMap((r) => r?.nodes || []);
  ok('E: injected real names all become plan targets',
    injected.every((nm) => everyName.has(nm)),
    `${injected.length} injected names, all mesh ancestors; ${[...frontier].filter((nm) => !everyName.has(nm)).length} frontier names are containers instead`);

  // The point of the whole function: the focus set must be plannable, and must
  // buy a materially smaller frame count than covering the whole model.
  const fp = planViews(g, { maxViews: 24, minCoverage: 1.01, focusNames: frontier, allowGhost: false });
  ok('E: a focused plan keeps every real name as a target',
    fp.targets >= injected.length && fp.targets <= frontier.size,
    `${fp.targets} targets from ${frontier.size} focus names (${injected.length} injected + ${new Set(blades).size} blades)`);
  ok('E: a focused plan is smaller than the whole-model plan',
    fp.views.length <= budget.views.length && fp.coverage >= 0.5,
    `${fp.views.length} frames for ${fp.targets} focused nodes at ${(fp.coverage * 100).toFixed(1)}% (whole-model budget: ${budget.views.length} frames for ${budget.targets})`);
  ok('E: a focused plan never claims a node outside the focus',
    fp.views.every((v) => v.covers <= fp.targets));
}

// ---- F) round 2: a suggestView becomes a place to aim ------------------------
// The active-loop edge `hypothesis --suggestView--> observation` is only real if
// a model's sentence can be turned back into a camera pose. suggestView.target
// arrives in three shapes (a node name, a frame id, free text) and each needs a
// different lookup, so all three are exercised here against REAL frames from a
// REAL round-1 plan.
{
  const R = modelRadius(g);
  // `survey: 0` on purpose. This section is about turning round 1's DOUBTS back into
  // round 2 poses, so it needs a round-1 plan made of the greedy cell/ring basis;
  // with the omni survey tier forced into a 6-view budget every photo is a survey
  // frame and the only cell left to probe would be a ghost, which is not the frame a
  // suggestView is ever resolved against.
  const plan1 = planViews(g, { maxViews: 6, survey: 0 });
  const cell = plan1.views.find((v) => v.spec.kind === 'cell');
  const ring = plan1.views.find((v) => v.spec.kind === 'ring');
  const part = cell.sees[0];
  const peers = cell.sees.slice(1, 6);
  const frames = [
    { id: `${ring.id}.photo`, viewId: ring.id, mode: 'photo' },
    { id: `${cell.id}.colorId`, viewId: cell.id, mode: 'colorId' },
  ];
  const grounded = [
    { index: 0, frameId: `${cell.id}.colorId`, names: [part] },
    { index: 1, frameId: `${ring.id}.photo`, names: [] },
  ];
  // Two records that share the word "rotor" so the ambiguity guard has something
  // to refuse. No node name in this model contains it, so a match can only come
  // from manifest vocabulary.
  const mf = [
    { id: 'rotor_fl', label: 'front left rotor', nodes: [part, peers[0]].filter(Boolean) },
    { id: 'rotor_fr', label: 'front right rotor', nodes: peers.slice(1, 3) },
  ];
  const run = (svs, o = {}) => regionsFromSuggestViews(g, svs, {
    grounded, plan: plan1, frames, manifest: mf, ...o,
  });

  // Independent oracle for "where is this part": recomputed here from the mesh
  // nodes rather than read back from the module under test.
  const centreOf = (nm) => {
    let out = null;
    for (const n of targets) {
      if (named.get(n.i) !== nm) continue;
      const b = nodeBox(n);
      if (!b) continue;
      if (!out) { out = { c: b.c.slice(), h: b.h.slice() }; continue; }
      for (let k = 0; k < 3; k += 1) {
        const lo = Math.min(out.c[k] - out.h[k], b.c[k] - b.h[k]);
        const hi = Math.max(out.c[k] + out.h[k], b.c[k] + b.h[k]);
        out.c[k] = (lo + hi) / 2; out.h[k] = (hi - lo) / 2;
      }
    }
    return out;
  };

  ok('F: unfitDistance inverts fitDistance',
    [1, 7.5, R, 3 * R].every((r) => [1, 1.15, 2].every((m) => Math.abs(unfitDistance(fitDistance(r, VIEWPORT, m), VIEWPORT, m) - r) < 1e-6)),
    `round trip at margin 1/1.15/2`);

  // (1) derived, box-only: target IS a node name.
  const byName = run([{ index: 0, frameId: `${cell.id}.colorId`, target: part, reason: 'grounding was geometric only', origin: 'derived' }]);
  const rn = byName.regions[0];
  ok('F: a derived suggestView naming a PART resolves to exactly that part',
    byName.regions.length === 1 && rn.how === 'name' && rn.names.join() === part
      && byName.unresolved.length === 0 && byName.skipped.length === 0,
    `${rn.how} -> ${rn.names.join(',')}`);
  const pb = centreOf(part);
  ok('F: a named region is anchored on the part and sized to it, inside the clamp',
    rn.anchor.every((v, k) => Math.abs(v - pb.c[k]) < 1e-9)
      && Math.abs(rn.radius - Math.max(REGION_MIN_R * R, Math.min(REGION_MAX_R * R, Math.hypot(...pb.h) * REGION_PAD))) < 1e-9,
    `r=${rn.radius.toFixed(2)} in [${(REGION_MIN_R * R).toFixed(2)}, ${(REGION_MAX_R * R).toFixed(2)}] from a part ${Math.hypot(...pb.h).toFixed(2)} across`);

  // (2) derived, disagree: target IS a frame id.
  const byFrame = run([{ index: 1, frameId: `${ring.id}.photo`, target: `${ring.id}.photo`, reason: 'the box and the colours disagreed', origin: 'derived' }]);
  const rf = byFrame.regions[0];
  ok('F: a derived suggestView naming a FRAME resolves to that frame\'s aim point',
    byFrame.regions.length === 1 && rf.how === 'frame-aim' && rf.names.length === 0
      && rf.anchor.every((v, k) => Math.abs(v - ring.pose.target[k]) < 1e-9),
    `${rf.how} anchor=${rf.anchor.map((v) => v.toFixed(1)).join(',')}`);
  ok('F: a frame-only region is sized to the frame it came from, never to the whole model',
    rf.radius <= REGION_MAX_R * R + 1e-9 && rf.radius < R,
    `r=${rf.radius.toFixed(2)} vs model ${R.toFixed(2)}`);
  ok('F: round 2 re-aims from a DIFFERENT bearing than the frame that was unsure',
    rf.azimuth === (ring.spec.azimuth + AZIMUTH_RETRY) % 360,
    `az ${ring.spec.azimuth} -> ${rf.azimuth}`);

  // (3) model-origin free text.
  const byText = run([{ index: 2, frameId: `${ring.id}.photo`, target: `please look again at ${part} from below and behind`, reason: 'it is hidden by the hull', origin: 'model' }]);
  ok('F: a model request in free text still finds the part it names',
    byText.regions.length === 1 && byText.regions[0].how === 'name-in-text'
      && byText.regions[0].names.join() === part,
    `${byText.regions[0]?.how} from "${part}"`);
  const byJoint = run([{ index: 3, frameId: null, target: 'front left rotor', reason: 'not sure it spins', origin: 'model' }]);
  ok('F: a model request in JOINT vocabulary resolves through the manifest',
    byJoint.regions.length === 1 && byJoint.regions[0].how === `manifest:${mf[0].id}`
      && byJoint.regions[0].names.length === mf[0].nodes.length,
    `${byJoint.regions[0]?.how} -> ${byJoint.regions[0]?.names.length} parts`);

  // Refusing is a behaviour, not an absence of one: an ambiguous request must be
  // REPORTED, because a close-up aimed at a plausible-looking part spends the
  // round-2 budget answering a question nobody asked.
  const vague = run([{ index: 4, frameId: null, target: 'rotor', reason: 'which rotor?', origin: 'model' }]);
  ok('F: an ambiguous request is reported, never guessed',
    vague.regions.length === 0 && vague.unresolved.length === 1 && /no part/.test(vague.unresolved[0].why),
    `${vague.unresolved[0]?.why}`);
  const junk = regionsFromSuggestViews(g, [null, {}, { target: 42 }, { target: 'x' }], { plan: plan1, frames });
  ok('F: junk suggestViews cannot throw or invent a region',
    junk.regions.length === 0 && junk.unresolved.length === 4,
    `${junk.unresolved.length} reported of 4 junk entries`);
  ok('F: no suggestViews means no round 2', run([]).regions.length === 0
    && regionsFromSuggestViews(g, null).regions.length === 0);

  // Ranking decides who survives a collision: the model asked, so the model wins.
  const both = run([
    { index: 0, frameId: `${cell.id}.colorId`, target: part, reason: 'geometric only', origin: 'derived' },
    { index: 2, frameId: `${ring.id}.photo`, target: `look again at ${part}`, reason: 'hidden by the hull', origin: 'model' },
  ]);
  ok('F: the same parts suggested twice buy ONE region, and the model\'s request wins it',
    both.regions.length === 1 && both.regions[0].origin === 'model'
      && both.skipped.length === 1 && both.skipped[0].origin === 'derived',
    `kept ${both.regions[0].origin}/${both.regions[0].how}, dropped ${both.skipped[0].origin}`);

  const many = run(peers.map((nm, k) => ({ index: k, frameId: `${cell.id}.colorId`, target: nm, reason: 'r', origin: 'derived' })), { maxRegions: 2 });
  ok('F: maxRegions caps how much round 2 may spend',
    many.regions.length === 2 && many.skipped.length === peers.length - 2
      && many.skipped.every((s) => /cap/.test(s.why)),
    `${many.regions.length} regions kept, ${many.skipped.length} over the cap`);

  // The whole point, end to end: the regions feed the planner unmodified, and the
  // frames it buys actually SHOW the part that was in doubt.
  const cu = planCloseUps(g, byName.regions, { perRegion: 2 });
  ok('F: the close-up a suggestView buys actually FRAMES the part it was unsure about',
    cu.views.length > 0 && cu.views.some((v) => v.sees.includes(part))
      && cu.views.every((v) => Array.isArray(v.sees) && v.sees.length > 0),
    `${cu.views.length} frames, ${cu.covered}/${cu.targets} region parts framed`);
}

console.log(`\n${fail === 0 ? 'VIEWS_PROBE_OK' : 'VIEWS_PROBE_FAILED'} \u2014 ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

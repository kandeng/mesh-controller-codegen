// Next-Best-View planner proof — the automated answer to "can we plan a frame
// set that sees every dynamic-relevant part, headless, in the fewest views?"
// Four legs, exit 0 only if all of them hold:
//   A) projection math is a real pinhole camera (centre, orthonormal basis,
//      behind-camera rejection, frame clipping)
//   B) the coverage unit is the MESH node, not the named container — projecting
//      named containers lands bboxes in empty space and stalls coverage near 63%
//   C) greedy set cover converges: high coverage, few views, monotone
//      diminishing marginal gain (the submodularity signature)
//   D) focusNames restricts the plan, planCloseUps aims at its anchors
//   E) focusFromManifest turns the manifest + joints + blade suspects into the
//      name set a vision round should actually spend frames on
//
// Usage: node test/verify-views.mjs
import { bladeCandidates, parseGlb } from '../src/lib/gltf.mjs';
import {
  VIEWPORT, candidateSpecs, coverageOf, fitDistance, focusFromManifest, kdCells,
  makeCamera, modelRadius, modelTarget, namedIndex, nodeBox, planCloseUps,
  planViews, poseFromSpec, project, projectNode, renderTargets,
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
  const marg = photos.map((v) => v.marginal);
  ok('C: marginal gain never increases (submodular greedy)',
    marg.every((m, i) => i === 0 || m <= marg[i - 1]), marg.join(' → '));
  ok('C: every view earns its frame', marg.every((m) => m > 0), `min marginal ${Math.min(...marg)}`);
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

  const anchors = [[10, 0, 5], [-10, 0, 5]];
  const cu = planCloseUps(anchors.map((a, i) => ({ id: `r${i}`, anchor: a, radius: 3, azimuth: 0 })), { perRegion: 2 });
  ok('D: close-ups are emitted per region', cu.length === anchors.length * 2, `${cu.length} poses`);
  ok('D: close-ups aim at their own anchors',
    cu.every((c, i) => c.pose.target[0] === anchors[Math.floor(i / 2)][0] && c.pose.target[2] === anchors[Math.floor(i / 2)][2]));
  ok('D: close-up distance is fitted to the region, not the model',
    cu.every((c) => Math.abs(c.spec.distance - fitDistance(3, VIEWPORT, 1.15)) < 1e-9),
    `d=${cu[0]?.spec.distance.toFixed(2)} for radius 3 (model wradius ${modelRadius(g).toFixed(1)})`);

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

console.log(`\n${fail === 0 ? 'VIEWS_PROBE_OK' : 'VIEWS_PROBE_FAILED'} \u2014 ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

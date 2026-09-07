// Next-Best-View planner — pure math over the parse table, no renderer and no
// GPU. Answers "which camera poses see every dynamic-relevant node, using the
// fewest frames?"
//
// The objective is COVERAGE, which is submodular (adding a view has diminishing
// marginal returns), so greedy selection is within (1 - 1/e) ~ 63% of optimal —
// in practice one or two views of it. Greedy is therefore the right algorithm,
// not a compromise.
//
// Occlusion is analytic and approximate: a node is hidden when some NEARER node
// whose silhouette covers this node's screen centre is at least as large. This
// needs only projected rects and depths, so the whole planner runs headless —
// the browser is needed only to rasterize the poses it chooses.
//
// Coordinate space: everything here is parseGlb WORLD space (Z-up, XY
// horizontal). The browser scene equals world minus its bbox centre, so poses
// travel as absolute world eye/target and the viewer subtracts its own offset.

// bladeCandidates is the phase-1 plate heuristic (wide, flat, out at the rotor
// ring). Reused rather than restated so the frontier focus and the tier-1 gate
// cannot drift apart. gltf.mjs is server-side only, and so is this module —
// geometry.mjs already imports it the same way.
import { bladeCandidates } from '../../lib/gltf.mjs';

// Frames are planned against this virtual viewport; the renderer is asked for
// the same size so projected pixel areas match what the model actually sees.
export const VIEWPORT = { w: 1024, h: 1024, fov: 45 };

// A node must paint at least this much to be "seen": a 2px sliver carries no
// recognisable shape. Calibrated for a 1024px frame of a drone-scale model.
export const MIN_AREA = 24;
export const MIN_SIDE = 2;

// Per-view cap on the recorded prediction of what the pose shows. Wide frames
// can see 200+ parts; keeping all of them would make plan.json bigger than the
// frames it describes, and the first few dozen are the ones grounding reconciles.
export const SEES_CAP = 80;

// Coverage targets are the MESH nodes (`Object_N`), not the named nodes. This
// matters: in the Inspire export every one of the 383 named nodes is a
// container (zero leaves) and hundreds of them sit more than a unit from their
// own children. Names are recovered by walking up to the nearest named ancestor
// — that is the vocabulary the manifest, the joints and the generator speak in.
const isDup = (n) => /^Object_\d+$/.test(n.name);

// The placed world box of a node: `wb` is the local accessor AABB pushed through
// the full world matrix (gltf.mjs), so it lands where the geometry actually is.
// Falling back to `wp` + `wext` would centre the box on the node ORIGIN, which
// for CAD exports that bake absolute vertex coordinates is empty space.
export function nodeBox(n) {
  if (n.wb) return { c: n.wb.c, h: n.wb.h };
  if (n.wp && n.wext) return { c: n.wp, h: [n.wext.ex / 2, n.wext.ey / 2, n.wext.ez / 2] };
  return null;
}

export function renderTargets(g) {
  return g.nodes.filter((n) => n.mesh && nodeBox(n) && Math.max(...nodeBox(n).h) > 1e-6);
}

// mesh-node index -> nearest named ancestor name (the vocabulary the manifest,
// the joints and the generator all speak in).
export function namedIndex(g) {
  const name = new Map();
  for (const n of g.nodes) {
    let cur = n;
    let guard = 0;
    while (cur && isDup(cur) && cur.parent >= 0 && guard < 64) { cur = g.nodes[cur.parent]; guard += 1; }
    name.set(n.i, cur ? cur.name : n.name);
  }
  return name;
}

// Orthonormal view basis. Up is +Z (the model is Z-up); elevation is clamped by
// the caller so `forward` never aligns with `up` and the cross product vanishes.
export function makeCamera(eye, target, vp = VIEWPORT) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const f = norm(sub(target, eye));
  const r = norm(cross(f, [0, 0, 1]));
  const u = cross(r, f);
  return {
    eye, target, f, r, u,
    fov: vp.fov, aspect: vp.w / vp.h, w: vp.w, h: vp.h,
    tanHalfY: Math.tan((vp.fov * Math.PI / 180) / 2),
    _dot: dot,
  };
}

// World point -> screen pixels (y down), or null when behind the camera.
export function project(p, cam) {
  const dx = p[0] - cam.eye[0]; const dy = p[1] - cam.eye[1]; const dz = p[2] - cam.eye[2];
  const depth = dx * cam.f[0] + dy * cam.f[1] + dz * cam.f[2];
  if (depth <= 1e-6) return null;
  const x = dx * cam.r[0] + dy * cam.r[1] + dz * cam.r[2];
  const y = dx * cam.u[0] + dy * cam.u[1] + dz * cam.u[2];
  const sy = depth * cam.tanHalfY;
  const sx = sy * cam.aspect;
  return { x: (x / sx * 0.5 + 0.5) * cam.w, y: (0.5 - y / sy * 0.5) * cam.h, depth };
}

// Project a placed box's 8 corners and take the screen hull. Returns null when
// the box is entirely behind the camera or off-frame.
export function rectOf(b, cam) {
  if (!b) return null;
  const [hx, hy, hz] = b.h;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  let seen = 0;
  for (let i = 0; i < 8; i += 1) {
    const p = project([
      b.c[0] + (i & 1 ? hx : -hx),
      b.c[1] + (i & 2 ? hy : -hy),
      b.c[2] + (i & 4 ? hz : -hz),
    ], cam);
    if (!p) continue;
    seen += 1;
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  if (!seen) return null;
  // Clip to the frame: a node hanging off the edge is only partly visible.
  const cx0 = Math.max(0, x0); const cy0 = Math.max(0, y0);
  const cx1 = Math.min(cam.w, x1); const cy1 = Math.min(cam.h, y1);
  if (cx1 <= cx0 || cy1 <= cy0) return null;
  const w = cx1 - cx0; const h = cy1 - cy0;
  return {
    x0: cx0, y0: cy0, x1: cx1, y1: cy1, w, h, area: w * h,
    cx: (cx0 + cx1) / 2, cy: (cy0 + cy1) / 2,
    depth: Math.hypot(b.c[0] - cam.eye[0], b.c[1] - cam.eye[1], b.c[2] - cam.eye[2]),
  };
}

export function projectNode(n, cam) {
  return rectOf(nodeBox(n), cam);
}

const contains = (r, x, y) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

// Which targets this pose actually sees: big enough to recognise, inside the
// frame, and not hidden behind a nearer, larger silhouette. `label` chooses the
// unit of coverage — mesh name by default, nearest named ancestor when the
// caller thinks in manifest terms (the objective greedy then optimises).
//
// `reach` is an optional broad-phase cutoff: no point closer to the eye than
// this can be missed, and a tight frame aimed at one corner of the model has no
// business projecting the other 300 parts. Conservative by construction.
//
// `occlude:false` models a GHOST (transparent-shell) render: the part is counted
// as seen whenever it is in frame at recognisable size, regardless of what is in
// front of it. Interior parts enclosed by a closed shell are unreachable by any
// external opaque viewpoint, so ghost frames are the only way to show them.
export function coverageOf(cam, targets, {
  minArea = MIN_AREA, minSide = MIN_SIDE, label = null, reach = 0, occlude = true,
} = {}) {
  const rects = [];
  for (const n of targets) {
    const b = nodeBox(n);
    if (!b) continue;
    if (reach > 0) {
      const dEye = Math.hypot(b.c[0] - cam.eye[0], b.c[1] - cam.eye[1], b.c[2] - cam.eye[2]);
      if (dEye > reach) continue;
    }
    const r = rectOf(b, cam);
    if (r && r.area >= minArea && r.w >= minSide && r.h >= minSide) rects.push({ n, r });
  }
  const seen = new Set();
  if (!occlude) {
    for (const { n } of rects) seen.add(label ? label(n) : n.name);
    return seen;
  }
  // Depth-sort once so the occlusion scan can stop early at farther nodes.
  rects.sort((a, b) => a.r.depth - b.r.depth);
  for (let i = 0; i < rects.length; i += 1) {
    const { n, r } = rects[i];
    let hidden = false;
    for (let j = 0; j < i; j += 1) {           // j is strictly nearer
      const o = rects[j].r;
      if (o.area >= r.area && contains(o, r.cx, r.cy)) { hidden = true; break; }
    }
    if (!hidden) seen.add(label ? label(n) : n.name);
  }
  return seen;
}

// Look-at point for a whole-model view: the centre of the PLACED world bbox.
// `g.center` is the centroid of node ORIGINS and is XY-only, so it can be far
// from the geometry for exports that bake vertex coordinates.
export function modelTarget(g) {
  if (Array.isArray(g.bcenter)) return g.bcenter.slice();
  let z0 = Infinity; let z1 = -Infinity;
  for (const n of g.nodes) { if (n.wp[2] < z0) z0 = n.wp[2]; if (n.wp[2] > z1) z1 = n.wp[2]; }
  if (!Number.isFinite(z0)) z0 = 0;
  if (!Number.isFinite(z1)) z1 = z0;
  return [g.center[0], g.center[1], (z0 + z1) / 2];
}

// Framing radius: half the placed bbox diagonal. `g.radius` spreads node origins
// only, which under-frames a model whose geometry sits far from its origins.
export const modelRadius = (g) => Math.max(1e-6, Number(g.wradius) || Number(g.radius) || 1);

// Spherical pose -> absolute world eye/target. Distance is in WORLD units (use
// multiples of modelRadius(g) so framing scales with the model).
export function poseFromSpec(spec, g) {
  const R = modelRadius(g);
  const el = Math.max(-80, Math.min(80, Number(spec.elevation ?? 20))) * Math.PI / 180;
  const az = (Number(spec.azimuth ?? 0) * Math.PI) / 180;
  const d = Math.max(1e-3, Number(spec.distance ?? 2.5 * R));
  const target = Array.isArray(spec.target) && spec.target.length === 3
    ? spec.target
    : modelTarget(g);
  const ce = Math.cos(el);
  return {
    eye: [target[0] + d * ce * Math.cos(az), target[1] + d * ce * Math.sin(az), target[2] + d * Math.sin(el)],
    target,
  };
}

// Distance at which a sphere of radius `r` centred on the aim point is fully
// inside the frame. sin (not tan) is the right function: the binding constraint
// is the tangent cone from the eye to the sphere, and the vertical half-fov is
// the narrow one for any aspect >= 1.
export function fitDistance(r, vp = VIEWPORT, margin = 1.0) {
  const half = (Math.max(1, Math.min(170, vp.fov)) * Math.PI / 180) / 2;
  return Math.max(1e-3, (Math.max(1e-6, r) / Math.sin(half)) * margin);
}

// Whole-model candidate ring: azimuth x elevation x zoom, all aimed at the model
// centre. These buy the big parts (fuselage, arms, landing gear) cheaply.
function ringSpecs(g, { azimuths, elevations, distances }) {
  const R = modelRadius(g);
  const specs = [];
  for (let a = 0; a < azimuths; a += 1) {
    for (const el of elevations) {
      for (const d of distances) specs.push({ kind: 'ring', azimuth: (a * 360) / azimuths, elevation: el, distance: d });
    }
  }
  return specs.map((s) => ({ ...s, distance: s.distance * R }));
}

// Adaptive spatial subdivision: split the target set by its longest axis at the
// median until each cell holds at most `maxMembers` boxes (or the depth/size
// floor is hit). Median splits rather than a full octree because a drone is
// elongated — an octree over an 88 x 52 x 72 volume spends most of its cells on
// empty space, and a fixed 2x2x2 grid leaves cells far too coarse to resolve a
// sub-unit part.
export function kdCells(targets, { maxMembers = 10, maxDepth = 8, minRadius = 1e-3 } = {}) {
  const boxes = targets.map((n) => ({ n, b: nodeBox(n) })).filter((x) => x.b);
  const bound = (items) => {
    let x0 = Infinity; let y0 = Infinity; let z0 = Infinity;
    let x1 = -Infinity; let y1 = -Infinity; let z1 = -Infinity;
    for (const { b } of items) {
      x0 = Math.min(x0, b.c[0] - b.h[0]); x1 = Math.max(x1, b.c[0] + b.h[0]);
      y0 = Math.min(y0, b.c[1] - b.h[1]); y1 = Math.max(y1, b.c[1] + b.h[1]);
      z0 = Math.min(z0, b.c[2] - b.h[2]); z1 = Math.max(z1, b.c[2] + b.h[2]);
    }
    return { x0, y0, z0, x1, y1, z1 };
  };
  const cells = [];
  const stack = [{ items: boxes, depth: 0 }];
  while (stack.length) {
    const cell = stack.pop();
    const b = bound(cell.items);
    const ex = b.x1 - b.x0; const ey = b.y1 - b.y0; const ez = b.z1 - b.z0;
    const rad = 0.5 * Math.hypot(ex, ey, ez);
    const axis = ex >= ey && ex >= ez ? 0 : (ey >= ez ? 1 : 2);
    const spread = Math.max(ex, ey, ez);
    if (cell.items.length <= maxMembers || cell.depth >= maxDepth || rad < minRadius || spread < 1e-6) {
      cells.push({
        anchor: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2],
        radius: rad, members: cell.items.length, depth: cell.depth,
      });
      continue;
    }
    const key = (x) => x.b.c[axis];
    const sorted = cell.items.slice().sort((p, q) => key(p) - key(q));
    const mid = Math.floor(sorted.length / 2);
    // Degenerate split (everything at one coordinate) would loop forever.
    if (mid === 0 || mid === sorted.length || key(sorted[mid]) === key(sorted[0])) {
      cells.push({
        anchor: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2],
        radius: rad, members: cell.items.length, depth: cell.depth,
      });
      continue;
    }
    stack.push({ items: sorted.slice(0, mid), depth: cell.depth + 1 });
    stack.push({ items: sorted.slice(mid), depth: cell.depth + 1 });
  }
  return cells;
}

// Cell-anchored candidates: one tight frame per (cell, azimuth, elevation), at a
// distance fitted to that cell's own radius.
//
// This is what makes full coverage reachable at all. A concentric zoom ladder
// cannot do it: tightening the distance still looks at the model centre, so the
// periphery never gets a tight frame — and at whole-model framing a sub-unit
// part paints a couple of pixels, below MIN_AREA, no matter how many ring poses
// we try. Anchoring on the parts themselves buys resolution where they are.
function cellSpecs(targets, { azimuths, elevations, margin, viewport, maxMembers, maxDepth }) {
  const specs = [];
  kdCells(targets, { maxMembers, maxDepth }).forEach((cell, i) => {
    const d = fitDistance(cell.radius, viewport, margin);
    for (let a = 0; a < azimuths; a += 1) {
      for (const el of elevations) {
        specs.push({
          kind: 'cell', cell: i, members: cell.members, radius: cell.radius,
          azimuth: (a * 360) / azimuths, elevation: el, distance: d, target: cell.anchor,
        });
      }
    }
  });
  return specs;
}

// Candidate pose set = whole-model ring + part-anchored cells. Deliberately
// coarse: greedy only needs a good basis, and every candidate costs a coverage
// pass (cheap for cells, thanks to the `reach` broad-phase).
export function candidateSpecs({
  azimuths = 8, elevations = [-10, 15, 40, 70], distances = [2.6, 1.6],
  cellAzimuths = 4, cellElevations = [15, 45], cellMargin = 1.15,
  maxMembers = 10, maxDepth = 8, targets = null, maxCandidates = 800,
  viewport = VIEWPORT, g,
} = {}) {
  const list = targets || renderTargets(g);
  const specs = ringSpecs(g, { azimuths, elevations, distances });
  specs.push(...cellSpecs(list, {
    azimuths: cellAzimuths, elevations: cellElevations, margin: cellMargin,
    viewport, maxMembers, maxDepth,
  }));
  return specs.length > maxCandidates ? specs.slice(0, maxCandidates) : specs;
}

// Eye-distance cutoff for a spec's broad phase. A point at depth z is in frame
// only if it is within z*sqrt(1 + tanY^2 + tanX^2) of the eye, so 1.5x the aim
// distance plus the largest target radius is safely conservative.
export function reachOf(spec, g, maxTargetRadius) {
  return Number(spec.distance ?? 2.5 * modelRadius(g)) * 1.5 + maxTargetRadius;
}

// Greedy set-cover selection. Coverage is a submodular function of the chosen
// view set, so greedy is within (1 - 1/e) of optimal — the right algorithm, not
// a compromise. Shared by the opaque and the ghost pass.
function greedySelect(cand, total, { maxViews, minCoverage }) {
  const covered = new Set();
  const used = new Set();
  const views = [];
  while (views.length < maxViews && covered.size / Math.max(1, total) < minCoverage) {
    let best = null;
    for (const c of cand) {
      if (used.has(c.id)) continue;
      let gain = 0;
      for (const name of c.covers) if (!covered.has(name)) gain += 1;
      if (!best || gain > best.gain) best = { c, gain };
    }
    if (!best || best.gain === 0) break;               // nothing more to see
    used.add(best.c.id);
    for (const name of best.c.covers) covered.add(name);
    views.push({ ...best.c, marginal: best.gain });
  }
  return { views, covered };
}

// Plan the frame set. Two passes over the same candidate poses:
//
//   1. OPAQUE (`mode:'photo'`) — what an ordinary outside-the-hull render shows.
//   2. GHOST (`mode:'ghost'`) — spent ONLY on the residual the opaque pass could
//      not reach. Parts enclosed by a closed shell are invisible from every
//      external viewpoint, so no amount of opaque planning will ever cover them;
//      transparency is not a nice-to-have but the only route.
//
// `focusNames` restricts the target set — pass the manifest frontier plus the
// unclaimed nodes to spend views only where uncertainty lives, instead of
// covering static geometry nobody will ask about.
export function planViews(g, {
  maxViews = 12, minCoverage = 0.99, viewport = VIEWPORT, specs = null, minArea = MIN_AREA,
  focusNames = null, maxMembers = 10, maxDepth = 8, cellMargin = 1.15,
  allowGhost = true, ghostViews = 4,
} = {}) {
  const named = namedIndex(g);
  const allTargets = renderTargets(g);
  const targets = focusNames
    ? allTargets.filter((n) => focusNames.has(named.get(n.i)))
    : allTargets;
  // The unit of coverage is the NAMED node — that is the vocabulary the manifest,
  // the joints and the generator speak in, so it is what greedy must optimise.
  const label = (n) => named.get(n.i);
  const want = new Set(targets.map(label));
  const total = want.size;
  const maxRad = targets.reduce((m, n) => Math.max(m, Math.max(...nodeBox(n).h)), 0);

  const cand = (specs || candidateSpecs({
    g, targets, viewport, maxMembers, maxDepth, cellMargin,
  })).map((spec, i) => {
    const pose = poseFromSpec(spec, g);
    return {
      id: `v${i}`, spec, pose,
      cam: makeCamera(pose.eye, pose.target, viewport),
      reach: reachOf(spec, g, maxRad),
    };
  });
  for (const c of cand) c.covers = coverageOf(c.cam, targets, { minArea, label, reach: c.reach });

  const first = greedySelect(cand, total, { maxViews, minCoverage });
  const views = first.views.map((v) => ({ ...v, mode: 'photo' }));
  const covered = new Set(first.covered);

  // Pass 2: ghost frames for the unreachable residual, scored only against that
  // residual so a ghost pose is never bought for something an opaque pose shows.
  const residual = new Set([...want].filter((nm) => !covered.has(nm)));
  let interiorOnly = [];
  if (allowGhost && ghostViews > 0 && residual.size) {
    const resTargets = targets.filter((n) => residual.has(label(n)));
    const gcand = cand.map((c) => ({
      ...c, id: `${c.id}g`, covers: coverageOf(c.cam, resTargets, { minArea, label, reach: c.reach, occlude: false }),
    }));
    const second = greedySelect(gcand, residual.size, { maxViews: ghostViews, minCoverage: 1.01 });
    interiorOnly = [...second.covered];
    second.views.forEach((v, k) => {
      // Ids stay unique across both passes; `baseId` ties a ghost frame back to
      // the pose it shares with the opaque candidate list.
      views.push({ ...v, id: `g${k}`, baseId: v.id.replace(/g$/, ''), mode: 'ghost' });
      for (const nm of v.covers) covered.add(nm);
    });
  }

  const unseen = [...want].filter((nm) => !covered.has(nm));
  return {
    views: views.map((v) => ({
      id: v.id, mode: v.mode, spec: v.spec, pose: v.pose, marginal: v.marginal, covers: v.covers.size,
      // The planner's own PREDICTION of what this pose shows, capped so plan.json
      // stays readable. Grounding reconciles the model's answer against this:
      // a part the planner says is visible but the model does not name is a
      // disagreement worth a second frame, and a part the model names that is not
      // on this list is a hallucination. Without the list neither is detectable.
      sees: [...v.covers].slice(0, SEES_CAP),
      ...(v.baseId ? { baseId: v.baseId } : {}),
    })),
    meshes: targets.length,
    targets: total,
    covered: covered.size,
    coverage: total ? covered.size / total : 1,
    // Parts that ONLY a transparent-shell frame can show. Surfaced because it is
    // a real physical fact about the model, not a planner shortfall.
    interiorOnly,
    unseen,
  };
}

// Which named nodes a vision round should actually spend frames on.
//
// Covering all 345 mesh nodes is not the objective — most of them are fasteners
// and shell panels no controller will ever address. The objective is the parts a
// joint could plausibly be built from, so frames go where uncertainty lives:
//   frontier — every node a manifest record already claims (the model gets to
//              see and critique our own hypotheses), every node a joint already
//              drives, plus every blade candidate
//              discovery raised but has not yet confirmed.
//   all      — frontier widened to every named node that carries geometry, for
//              the "what did we miss entirely" question.
// Returns a Set of NAMES, matching planViews' `focusNames` contract. `all` is
// always a superset of `frontier`.
export function focusFromManifest(g, manifest, joints, { mode = 'frontier' } = {}) {
  const named = namedIndex(g);
  const want = new Set();
  const add = (nm) => { if (nm) want.add(nm); };

  for (const rec of manifest || []) for (const nm of rec?.nodes || []) add(nm);
  for (const j of joints || []) for (const nm of j?.nodes || []) add(nm);

  // Blade suspects go in unconditionally, in BOTH modes: they are wide, flat,
  // out at the rotor ring, and they are exactly the parts whose grouping decides
  // whether a rotor is one joint or four — the question phase 1/2 keeps failing.
  // bladeCandidates can return bare `Object_N` mesh nodes, so each name is run
  // through namedIndex — otherwise the focus set contains labels planViews' own
  // `label()` can never produce and the frame is wasted on nothing.
  for (const n of bladeCandidates(g)) add(named.get(n.i) || n.name);

  // `all` is a strict superset of `frontier`: it additionally pulls in every
  // named ancestor of every mesh node, so a round can answer "what did we miss
  // entirely" rather than only "is what we claimed right".
  if (mode === 'all') for (const n of renderTargets(g)) add(named.get(n.i));
  return want;
}

// Round-2 close-ups: tight poses aimed at a region the model said it was unsure
// about. Same spherical grammar, but the target is the region anchor and the
// distance is fitted to the region's own radius, not the whole model's.
export function planCloseUps(regions, { perRegion = 2, elevations = [15, 45], margin = 1.15, viewport = VIEWPORT } = {}) {
  const out = [];
  (regions || []).forEach((reg, i) => {
    const anchor = Array.isArray(reg.anchor) ? reg.anchor : [reg.anchor?.x ?? 0, reg.anchor?.y ?? 0, reg.anchor?.z ?? 0];
    const rad = Math.max(1e-3, Number(reg.radius ?? 1));
    const d = fitDistance(rad, viewport, margin);
    elevations.slice(0, perRegion).forEach((el, k) => {
      const az = (reg.azimuth ?? 0) + k * 60;
      const spec = { kind: 'close-up', azimuth: az, elevation: el, distance: d, target: anchor };
      out.push({
        id: `cu${i}_${k}`, kind: 'close-up', region: reg.id || reg.target || `region${i}`,
        spec, pose: poseFromSpec(spec, { wradius: rad }),
      });
    });
  });
  return out;
}

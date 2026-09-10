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
import { MAX_LEGEND } from './vision-prompt.mjs';

// Legend-fit search for a round-2 close-up: how many times to zoom in, and by how
// much, when the first framing predicts more parts than a readable colour legend
// can list. Geometric rather than a solved inverse, because "how many parts fit"
// is not a smooth function of distance once occlusion is in it.
const LEGEND_FIT_TRIES = 4;
const LEGEND_FIT_STEP = 0.6;

// Frames are planned against this virtual viewport; the renderer is asked for
// the same size so projected pixel areas match what the model actually sees.
export const VIEWPORT = { w: 1024, h: 1024, fov: 45 };

// Motion fans (task 18) are drawn SMALLER than survey frames on purpose: the
// question is SEMANTIC ("what is this moving thing, is the motion sensible"), not
// a pixel-exact measurement — the rigidity gate already measures which nodes move
// and by how much. A smaller frame keeps a 3-pose fan plus its swept composite
// comfortably inside one upload, and 768px is ample for a judgement.
export const MOTION_VIEWPORT = { w: 768, h: 768, fov: 45 };
// The default fan: rest, then two equal steps. Enough to show an arc; few enough
// that the whole multi-image turn is a rounding error against the context window.
export const MOTION_ANGLES = [0, 30, 60];

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

// How close `forward . up` may get to ±1 before the two are considered parallel.
// At a TRUE top-down or bottom-up look the world +Z that the default up hint is
// made of IS the view axis, so `cross(f, up)` vanishes and `right` becomes NaN —
// every projection from that pose would be NaN with it.
export const POLE_PARALLEL = 0.999;

// Orthonormal view basis. Up is +Z (the model is Z-up) except at the poles, where
// the caller may pass an explicit `up` and a parallel hint is replaced by a
// horizontal one: +Y looking down, -Y looking up. Both keep screen-right = +X, so
// a pole frame is not mirrored relative to the ring frames.
//
// The choice is NOT free, and that is why it lives here rather than in the
// renderer: the browser draws the pose with `camera.up = pose.up` and three.js
// builds its basis the same way (right = up x backward, up = backward x right), so
// the basis this function returns is pixel-for-pixel the basis the frame was drawn
// in. Were the two allowed to differ by a roll — three.js nudges a degenerate
// lookAt by an arbitrary 0.0001 — every regionBox a model draws on a pole frame
// would ground to the wrong parts, confidently.
export function makeCamera(eye, target, vp = VIEWPORT, up = null) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const f = norm(sub(target, eye));
  const hinted = Array.isArray(up) && up.length === 3 && up.every(Number.isFinite) ? norm(up) : [0, 0, 1];
  const u0 = Math.abs(dot(f, hinted)) > POLE_PARALLEL ? (f[2] > 0 ? [0, -1, 0] : [0, 1, 0]) : hinted;
  const r = norm(cross(f, u0));
  const u = cross(r, f);
  return {
    eye, target, f, r, u, up: u0,
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

// The up vector a spec will be drawn with. +Z everywhere except at the poles,
// where it has to be horizontal or the view basis degenerates (see makeCamera).
// An explicit `spec.up` always wins: a caller that wants a rolled frame may ask
// for one, and the pose carries the answer either way so neither the renderer nor
// the prompt builder has to re-derive it.
export function poseUp(spec, elRad) {
  const up = spec?.up;
  if (Array.isArray(up) && up.length === 3 && up.every(Number.isFinite)) return up.map(Number);
  const s = Math.sin(elRad);
  if (Math.abs(s) > POLE_PARALLEL) return s > 0 ? [0, 1, 0] : [0, -1, 0];
  return [0, 0, 1];
}

// Spherical pose -> absolute world eye/target/up. Distance is in WORLD units (use
// multiples of modelRadius(g) so framing scales with the model).
export function poseFromSpec(spec, g) {
  const R = modelRadius(g);
  // ±90, not ±80. The omni survey tier needs a TRUE top-down and bottom-up look:
  // the underside of a machine is where its landing gear, its payload bay and its
  // belly turret live, and a clamp at 80° turns "look underneath" into "look at
  // the flank from slightly below" — the one question a ground vehicle cannot
  // answer from any oblique frame.
  const el = Math.max(-90, Math.min(90, Number(spec.elevation ?? 20))) * Math.PI / 180;
  const az = (Number(spec.azimuth ?? 0) * Math.PI) / 180;
  const d = Math.max(1e-3, Number(spec.distance ?? 2.5 * R));
  const target = Array.isArray(spec.target) && spec.target.length === 3
    ? spec.target
    : modelTarget(g);
  const ce = Math.cos(el);
  return {
    eye: [target[0] + d * ce * Math.cos(az), target[1] + d * ce * Math.sin(az), target[2] + d * Math.sin(el)],
    target,
    up: poseUp(spec, el),
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

// The omni survey tier: whole-machine looks that are NOT chosen by coverage.
// Four ORTHOGONAL side views 90° apart at eye level, plus a true top-down and a
// true bottom-up — the six frames a person would take before saying anything
// about an object whose type nobody knows yet (drone? tank? robot arm?).
//
// Greedy coverage will happily spend a whole round on whichever flank carries the
// most parts and never look underneath, because marginal gain is a statement about
// OUR node table, not about understanding the machine. Forcing this tier costs
// frames the greedy pass would have spent on resolution, and buys a coherent set
// the model can reason about as a whole — which is also the only view set a
// category expectation can honestly be read from.
//
// Elevation is ZERO, not a flattering oblique: the survey is the orthographic
// six-side convention (front / back / left / right / top / bottom) that a human
// reads without having to infer where the camera was, and a model can compare
// part-to-part across frames because the four side views share one horizon. The
// cost is real — an eye-level ring cannot see the top of a rotor hub or the deck
// of a hull — and it is paid for by the two poles plus the greedy tier, which
// buys oblique poses as soon as they earn coverage the six orthogonals missed.
export const SURVEY_ELEVATION = 0;
export const SURVEY_MAX = 6;

export function surveySpecs(g, {
  count = SURVEY_MAX, elevation = SURVEY_ELEVATION, viewport = VIEWPORT, margin = 1.0,
} = {}) {
  const n = Math.max(0, Math.min(SURVEY_MAX, count | 0));
  if (!n) return [];
  // Fitted to the model's own bounding radius, so the whole machine is in frame at
  // any scale — the same framing the ring tier's widest zoom uses (R/sin 22.5°).
  const d = fitDistance(modelRadius(g), viewport, margin);
  // A truncated survey is still a SURVEY: the ring azimuths stay evenly spread and
  // the poles are dropped first, so asking for three buys three looks 120° apart
  // rather than three looks at one flank.
  const ring = Math.min(4, n);
  const poles = n - ring;
  const specs = [];
  for (let a = 0; a < ring; a += 1) {
    specs.push({ kind: 'survey', azimuth: (a * 360) / ring, elevation, distance: d });
  }
  if (poles >= 1) specs.push({ kind: 'survey', pole: 'top', azimuth: 0, elevation: 90, distance: d });
  if (poles >= 2) specs.push({ kind: 'survey', pole: 'bottom', azimuth: 0, elevation: -90, distance: d });
  return specs;
}

// The panel-framed survey: twelve fixed directions, ONE framing. The human owns
// the 3D view panel — they orbit and zoom it until the machine looks right — and
// this plan reproduces exactly what they framed: the panel's own aim point, eye
// distance and FOV, looked at from twelve bearings. No fit, no greedy, no cell
// pass: the size of the machine in every frame is the size the human chose, and
// the only thing the planner contributes is WHERE around the model to stand.
//
// `framing` is { target, distance, fov } in parseGlb world space, read live from
// the renderer that will draw the frames (server/render-farm.mjs `framing()`).
// A framing with no usable distance or fov is rejected (null) so the caller
// falls back to the coverage planner instead of drawing twelve guesses.
//
// The twelve directions: four eye-level orthogonals (the survey convention),
// four upper obliques and two lower obliques on the diagonals (deck and belly
// context the orthogonals cannot see), and a true top and bottom pole each.
// Elevation is capped below the poles so no two directions nearly coincide.
export const PANEL_ANGLES = [
  { azimuth: 0, elevation: 0 }, { azimuth: 90, elevation: 0 },
  { azimuth: 180, elevation: 0 }, { azimuth: 270, elevation: 0 },
  { azimuth: 45, elevation: 35 }, { azimuth: 135, elevation: 35 },
  { azimuth: 225, elevation: 35 }, { azimuth: 315, elevation: 35 },
  { azimuth: 45, elevation: -35 }, { azimuth: 225, elevation: -35 },
  { azimuth: 0, elevation: 90, pole: 'top' }, { azimuth: 0, elevation: -90, pole: 'bottom' },
];

// Accepted panel framing, or null. Distance and fov must be finite and positive;
// the aim point defaults to the model centre when the panel never reported one.
export function panelFramingOf(framing, g) {
  const distance = Number(framing?.distance);
  const fov = Number(framing?.fov);
  if (!Number.isFinite(distance) || distance <= 1e-3) return null;
  if (!Number.isFinite(fov) || fov < 1 || fov > 170) return null;
  const t = framing?.target;
  const target = Array.isArray(t) && t.length === 3 && t.every(Number.isFinite) ? t.map(Number) : modelTarget(g);
  return { target, distance, fov };
}

// Views come out in the SAME shape planViews emits ({id, mode, spec, pose,
// marginal, covers, sees, cam}) so selectShots, the prompt builder, grounding
// and the theater treat a panel plan exactly like a coverage plan. `spec.kind`
// is 'panel' — its own tier in selectShots (survey-classed: never masked, since
// a whole-machine legend is unreadable) — and it carries `fov` because this is
// the one plan whose FOV is the human's, not the viewport default's.
export function planPanelViews(g, framing, {
  count = PANEL_ANGLES.length, viewport = VIEWPORT, minArea = MIN_AREA,
} = {}) {
  const f = panelFramingOf(framing, g);
  if (!f) return null;
  const named = namedIndex(g);
  const targets = renderTargets(g);
  const label = (n) => named.get(n.i);
  const want = new Set(targets.map(label));
  const maxRad = targets.reduce((m, n) => Math.max(m, Math.max(...nodeBox(n).h)), 0);
  const vp = { ...viewport, fov: f.fov };

  const n = Math.max(1, Math.min(PANEL_ANGLES.length, count | 0));
  const covered = new Set();
  const views = [];
  for (let i = 0; i < n; i += 1) {
    const a = PANEL_ANGLES[i];
    const spec = {
      kind: 'panel', azimuth: a.azimuth, elevation: a.elevation,
      ...(a.pole ? { pole: a.pole } : {}),
      distance: f.distance, target: f.target.slice(), fov: f.fov,
    };
    const pose = poseFromSpec(spec, g);
    const cam = makeCamera(pose.eye, pose.target, vp, pose.up);
    const covers = coverageOf(cam, targets, { minArea, label, reach: reachOf(spec, g, maxRad) });
    let marginal = 0;
    for (const nm of covers) if (!covered.has(nm)) marginal += 1;
    for (const nm of covers) covered.add(nm);
    views.push({
      id: `p${i}`, mode: 'photo', spec, pose, marginal, covers: covers.size,
      cam, sees: [...covers].slice(0, SEES_CAP),
    });
  }

  const total = want.size;
  return {
    views,
    meshes: targets.length,
    targets: total,
    covered: covered.size,
    coverage: total ? covered.size / total : 1,
    // Same fields planViews reports. A panel plan buys no ghost frames — the
    // human chose an opaque look — so parts only a transparent shell can show
    // are listed here exactly as the coverage plan lists them: a fact about the
    // model, reported not hidden.
    interiorOnly: [],
    unseen: [...want].filter((nm) => !covered.has(nm)),
    // Recorded so plan.json and the response can say the frames were the
    // human's framing, and with what numbers.
    framing: f,
  };
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
//
// `covered`/`used` are injectable so a caller can FORCE a tier first and let greedy
// continue from what that tier already saw: the forced views then genuinely reduce
// the residual instead of being paid for twice, and greedy's own marginals stay
// monotone because they are measured against the seeded set.
function greedySelect(cand, total, {
  maxViews, minCoverage, covered = new Set(), used = new Set(),
}) {
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
//
// `survey` force-includes the omni survey tier (see surveySpecs) BEFORE greedy
// runs: those frames are bought because a machine of unknown type has to be seen
// from all six sides at least once, not because they maximise marginal gain. Pass
// `survey: 0` for a plan that is purely coverage-driven.
export function planViews(g, {
  maxViews = 12, minCoverage = 0.99, viewport = VIEWPORT, specs = null, minArea = MIN_AREA,
  focusNames = null, maxMembers = 10, maxDepth = 8, cellMargin = 1.15,
  allowGhost = true, ghostViews = 4, survey = SURVEY_MAX,
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

  // The survey tier is PREPENDED, so its candidate ids stay in the `v<N>` family
  // the ghost pass derives `baseId` from — a ghost of a survey pose must still read
  // as `v3g`/`v3`, or the audit trail points at a candidate that does not exist.
  const surveyCount = Math.max(0, Math.min(SURVEY_MAX, Math.min(maxViews, survey | 0)));
  const surveyList = surveyCount ? surveySpecs(g, { count: surveyCount, viewport }) : [];
  const cand = [...surveyList, ...(specs || candidateSpecs({
    g, targets, viewport, maxMembers, maxDepth, cellMargin,
  }))].map((spec, i) => {
    const pose = poseFromSpec(spec, g);
    return {
      id: `v${i}`, spec, pose,
      cam: makeCamera(pose.eye, pose.target, viewport, pose.up),
      reach: reachOf(spec, g, maxRad),
    };
  });
  for (const c of cand) c.covers = coverageOf(c.cam, targets, { minArea, label, reach: c.reach });

  // Tier 0 — FORCED. Deduped by POSE rather than by id, because a survey spec can
  // coincide with a ring spec and buying the same camera twice is not a survey.
  const poseKey = (p) => [...p.eye, ...p.target].map((v) => Number(v).toFixed(3)).join(',');
  const covered = new Set();
  const used = new Set();
  const usedPoses = new Set();
  const forced = [];
  for (const c of cand) {
    if (forced.length >= surveyCount || c.spec.kind !== 'survey') continue;
    const key = poseKey(c.pose);
    if (usedPoses.has(key)) continue;
    usedPoses.add(key);
    used.add(c.id);
    let gain = 0;
    for (const nm of c.covers) if (!covered.has(nm)) gain += 1;
    for (const nm of c.covers) covered.add(nm);
    forced.push({ ...c, marginal: gain });
  }

  // Tier 1 — greedy over what is left, seeded with the survey's own coverage and
  // excluding any pose the survey already took.
  const rest = cand.filter((c) => !used.has(c.id)
    && c.spec.kind !== 'survey'
    && !usedPoses.has(poseKey(c.pose)));
  const first = greedySelect(rest, total, {
    maxViews: Math.max(0, maxViews - forced.length), minCoverage, covered, used,
  });
  const views = [...forced, ...first.views].map((v) => ({ ...v, mode: 'photo' }));

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
      // The basis this pose was drawn with, carried through to the prompt. A
      // regionBox is a fraction of an image, so "screen-right = +X" is the one
      // annotation that turns a box into a statement about the MACHINE rather
      // than about an assumed convention — and it can only be printed from the
      // basis grounding itself projects with. Dropping it here would leave
      // frameLine's camera block permanently silent, which is exactly how the
      // air3 round came to declare "left/right labelling assumes screen-right is
      // +X" as a doubt instead of being told it as a fact.
      cam: v.cam,
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

// Sphere-vs-AABB distance: how far `p` is from the NEAREST POINT of the box, so
// 0 means inside. The centre-distance test alone is wrong here — a large hull
// panel whose centre sits outside a small region sphere still overlaps it, and
// that panel is exactly the thing occluding the region.
function boxDist(b, p) {
  const dx = Math.max(Math.abs(b.c[0] - p[0]) - b.h[0], 0);
  const dy = Math.max(Math.abs(b.c[1] - p[1]) - b.h[1], 0);
  const dz = Math.max(Math.abs(b.c[2] - p[2]) - b.h[2], 0);
  return Math.hypot(dx, dy, dz);
}

// Grow one box to the union of many. Used both to merge the mesh nodes that
// share a name and to size a round-2 region around the parts it is about.
export function unionBoxes(bs) {
  let out = null;
  for (const b of bs) {
    if (!b) continue;
    if (!out) { out = { c: b.c.slice(), h: b.h.slice() }; continue; }
    for (let k = 0; k < 3; k += 1) {
      const lo = Math.min(out.c[k] - out.h[k], b.c[k] - b.h[k]);
      const hi = Math.max(out.c[k] + out.h[k], b.c[k] + b.h[k]);
      out.c[k] = (lo + hi) / 2;
      out.h[k] = (hi - lo) / 2;
    }
  }
  return out;
}

// Union the boxes of every mesh node that shares a name. Several mesh nodes map
// to one named ancestor, and a region test against any single one of them would
// miss the rest of the part.
export function namedBoxes(g, targets, label) {
  const out = new Map();
  const acc = new Map();
  for (const n of targets) {
    const nm = label(n);
    const b = nodeBox(n);
    if (!nm || !b) continue;
    const arr = acc.get(nm);
    if (arr) arr.push(b); else acc.set(nm, [b]);
  }
  for (const [nm, bs] of acc) out.set(nm, unionBoxes(bs));
  return out;
}

// Inverse of fitDistance: the framing radius a camera at distance `d` fully
// contains. Round 2 needs it to recover the region a previous frame was fitted
// to, from the only thing recorded about that frame — its pose.
export function unfitDistance(d, vp = VIEWPORT, margin = 1.0) {
  const half = (Math.max(1, Math.min(170, vp.fov)) * Math.PI / 180) / 2;
  return Math.max(1e-6, (Number(d) || 0) * Math.sin(half) / Math.max(1e-6, margin));
}

// Round-2 close-ups: tight poses aimed at a region a previous round said it was
// unsure about. Same spherical grammar as the cell pass, but the aim point is the
// region anchor and the distance is fitted to the REGION's radius, not the
// model's.
//
// It takes `g` and returns a PLAN, not a bare list of poses, for one reason that
// decides whether round 2 works at all: a colorId mask must be FOCUSED, and the
// only source of a focus list is `sees`. An unfocused mask paints every named
// part in the model (~345 on the sample) and its legend is unreadable, so the one
// channel that was supposed to ground EXACTLY degrades into a guess. The earlier
// signature `planCloseUps(regions)` dropped `g`, so nothing could compute
// visibility and round 2 would have silently produced plain photos only.
//
// Two passes, mirroring planViews, because the canonical suggestView reason is
// "X is hidden by the hull" and no opaque pose can ever answer that:
//   1. OPAQUE close-ups, `perRegion` per region, spread over elevation AND
//      azimuth — a part that was ambiguous from one side is usually not from
//      another.
//   2. GHOST close-ups, spent ONLY on the region parts pass 1 could not frame.
//
// Views come out in the SAME shape planViews emits ({id, mode, spec, pose,
// marginal, covers, sees}) so selectShots, the prompt builder and grounding treat
// a round-2 plan exactly like a round-1 one.
export function planCloseUps(g, regions, {
  perRegion = 2, elevations = [15, 45], azimuthOffsets = [0, 60, 150, 210],
  margin = 1.15, viewport = VIEWPORT, maxViews = 12, minArea = MIN_AREA,
  allowGhost = true, legendBudget = MAX_LEGEND,
} = {}) {
  const list = (regions || []).filter(Boolean);
  const named = namedIndex(g);
  const targets = renderTargets(g);
  const label = (n) => named.get(n.i);
  const boxes = namedBoxes(g, targets, label);
  const maxRad = targets.reduce((m, n) => Math.max(m, Math.max(...nodeBox(n).h)), 0);

  // Normalise each region once: anchor as [x,y,z], radius, and the named parts it
  // is ABOUT (sphere-AABB, not centre distance). `targets` here is the round's
  // denominator — "of the things we were unsure about, how many did we manage to
  // frame" — which is the only coverage question round 2 can answer.
  const regs = list.map((reg, i) => {
    const anchor = Array.isArray(reg.anchor)
      ? reg.anchor.map(Number)
      : [Number(reg.anchor?.x ?? 0), Number(reg.anchor?.y ?? 0), Number(reg.anchor?.z ?? 0)];
    const radius = Math.max(1e-3, Number(reg.radius ?? 1));
    const members = [...boxes.entries()]
      .filter(([, b]) => boxDist(b, anchor) <= radius)
      .map(([nm]) => nm);
    return {
      id: reg.id || reg.target || `region${i}`,
      anchor, radius, members,
      // Carried through because `shoot` reads it off the NORMALISED region: a
      // caller that asks for a specific bearing (the model said "from below and
      // behind") would otherwise silently get azimuth 0 every time.
      azimuth: Number.isFinite(reg.azimuth) ? Number(reg.azimuth) : 0,
      reason: reg.reason ? String(reg.reason).slice(0, 240) : null,
      origin: reg.origin || 'derived',
    };
  });

  const cap = Math.max(1, maxViews | 0);
  const views = [];
  const seenSoFar = new Set();

  // `sees` is capped for plan.json's sake, so the ORDER decides what survives.
  // Nearest-to-the-aim-point first: a close-up whose legend drops the very parts
  // it was bought for is worse than no legend at all.
  const ordered = (covers, anchor) => {
    const d = (nm) => { const b = boxes.get(nm); return b ? boxDist(b, anchor) : Infinity; };
    return [...covers]
      .sort((a, b) => (d(a) - d(b)) || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, SEES_CAP);
  };

  const shoot = (reg, i, k, { ghost = false } = {}) => {
    if (views.length >= cap) return null;
    const memberSet = new Set(reg.members);

    // One framed candidate at a given FRAMING radius. The framing radius is not
    // the region radius: the region radius says what the uncertainty is ABOUT
    // (membership, and therefore the coverage denominator), while the framing
    // radius says how tight the camera is. They have to be separable or tightening
    // the shot would silently shrink the thing we are trying to measure.
    const frameAt = (frameRadius) => {
      const d = fitDistance(frameRadius, viewport, margin);
      const spec = {
        kind: 'close-up',
        azimuth: (reg.azimuth + (azimuthOffsets[k % Math.max(1, azimuthOffsets.length)] || 0)) % 360,
        elevation: elevations[k % Math.max(1, elevations.length)],
        distance: d,
        target: reg.anchor,
      };
      const pose = poseFromSpec(spec, { wradius: frameRadius });
      const cam = makeCamera(pose.eye, pose.target, viewport, pose.up);
      // A ghost is scored against the REGION's own parts with occlusion off: it is
      // bought to show what the hull hides, so counting the hull would let one
      // ghost be spent on something an opaque pose already frames.
      const pool = ghost ? targets.filter((n) => memberSet.has(label(n))) : targets;
      const covers = coverageOf(cam, pool, {
        minArea, label, reach: reachOf(spec, g, maxRad), occlude: !ghost,
      });
      return { spec, pose, covers, frameRadius, cam };
    };

    // Tighten until the predicted legend fits. A mask whose legend overflows
    // MAX_LEGEND is the failure round 2 exists to avoid: the colours that get
    // dropped are unresolvable, and they are just as likely to be the disputed
    // part as the ones that stayed. Geometric shrink, bounded, keeping the
    // tightest frame if none ever fits.
    //
    // Ghosts are NOT tightened. A ghost is the only route to an enclosed part, so
    // narrowing its frustum trades away exactly the coverage it was bought for —
    // a truncated ghost legend is a lesser evil than a ghost that cannot see the
    // part inside the hull.
    let chosen = null;
    const tries = ghost || !(legendBudget > 0) ? 1 : LEGEND_FIT_TRIES;
    for (let t = 0; t < tries; t += 1) {
      const cand = frameAt(reg.radius * LEGEND_FIT_STEP ** t);
      if (!cand.covers.size) { if (t === 0) return null; break; }
      if (!chosen || cand.covers.size < chosen.covers.size) chosen = cand;
      if (cand.covers.size <= legendBudget) { chosen = cand; break; }
    }
    if (!chosen || !chosen.covers.size) return null;

    const { spec, pose, covers, cam } = chosen;
    let marginal = 0;
    for (const nm of covers) if (!seenSoFar.has(nm)) marginal += 1;
    for (const nm of covers) seenSoFar.add(nm);
    const view = {
      id: `cu${i}_${k}${ghost ? 'g' : ''}`,
      mode: ghost ? 'ghost' : 'photo',
      kind: 'close-up',
      region: reg.id,
      ...(reg.reason ? { reason: reg.reason } : {}),
      ...(ghost ? { baseId: `cu${i}_${k}` } : {}),
      spec, pose, marginal, covers: covers.size, sees: ordered(covers, reg.anchor),
      // Same reason planViews carries it: the close-up prompt annotates each
      // frame with the screen-axis mapping it was really drawn in, and a
      // tightened frame is a DIFFERENT camera than the region's first guess, so
      // the basis has to be the one that survived the tightening loop.
      cam,
      // Recorded because it is the difference between "we aimed at the region" and
      // "we aimed at the region and had to zoom in twice to make it readable".
      ...(chosen.frameRadius !== reg.radius ? { tightened: +(chosen.frameRadius / reg.radius).toFixed(3) } : {}),
    };
    views.push(view);
    return view;
  };

  const n = Math.max(1, perRegion | 0);
  regs.forEach((reg, i) => { for (let k = 0; k < n; k += 1) shoot(reg, i, k); });

  // Pass 2: ghosts for whatever pass 1 could not frame. One per region at most —
  // a region whose parts are all interior needs a single transparent frame, and
  // spending the round-2 budget on four of them would crowd out the other regions.
  const framed = new Set(views.flatMap((v) => v.sees));
  if (allowGhost) {
    regs.forEach((reg, i) => {
      if (views.length >= cap) return;
      if (reg.members.every((nm) => framed.has(nm))) return;
      shoot(reg, i, 0, { ghost: true });
    });
  }

  const want = new Set(regs.flatMap((r) => r.members));
  const coveredAll = new Set(views.flatMap((v) => v.sees));
  const covered = [...want].filter((nm) => coveredAll.has(nm));
  return {
    views,
    regions: regs.map(({ members, ...r }) => ({ ...r, members: members.length })),
    targets: want.size,
    covered: covered.length,
    coverage: want.size ? covered.length / want.size : 1,
    // Parts we aimed at and STILL could not frame, even transparently. That is a
    // fact about the model (fully enclosed, or below MIN_AREA at any distance the
    // region radius allows), not a planner shortfall, so it is reported not hidden.
    unseen: [...want].filter((nm) => !coveredAll.has(nm)),
    interiorOnly: [...want].filter((nm) => !framed.has(nm) && coveredAll.has(nm)),
  };
}

// ---- round 2: from a model's request back to a place to aim -------------------

// A resolved region is padded so the close-up frames the part AND its immediate
// neighbours. A lone part with no context is unrecognisable, and the neighbours
// are what let the model say "that is the hub at the end of the front-left arm"
// rather than "that is a cylinder".
export const REGION_PAD = 1.6;
// Radii are clamped to fractions of the model radius. The floor keeps one tiny
// part from producing a frame so tight it is nothing but texture; the ceiling
// keeps a free-text region from degenerating back into round 1's whole-model
// view — the very frame that was already ambiguous.
export const REGION_MIN_R = 0.03;
export const REGION_MAX_R = 0.35;
// Round 2 looks from a DIFFERENT bearing than the frame that was unsure. The same
// azimuth would reproduce the same occlusion, and therefore the same ambiguity.
export const AZIMUTH_RETRY = 90;
// Short names match everything ("arm" inside "landing_arm_strut"), so substring
// resolution ignores them and falls through to the grounded-parts fallback.
const MIN_NAME_TOKEN = 3;

const normText = (s) => String(s ?? '').toLowerCase().replace(/[_\-.:/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
export const slug = (s) => (String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'aim');

// The model reports whichever name it saw in the prompt, and we cannot ask it to
// distinguish a part from the container holding it. So a name resolves to itself
// when it carries geometry, and otherwise to the named parts underneath it that
// do — both are legitimate answers to "look at X again".
function nameResolver(g, boxes, named) {
  const byName = new Map();
  const kids = new Map();
  for (const n of g.nodes) {
    if (n.name) { const a = byName.get(n.name); if (a) a.push(n.i); else byName.set(n.name, [n.i]); }
    if (n.parent != null && n.parent >= 0) { const a = kids.get(n.parent); if (a) a.push(n.i); else kids.set(n.parent, [n.i]); }
  }
  const resolve = (name) => {
    if (!name) return [];
    if (boxes.has(name)) return [name];
    const roots = byName.get(name);
    if (!roots || !roots.length) return [];
    const out = new Set();
    const stack = [...roots];
    let guard = 0;
    while (stack.length && guard < 50000) {
      const i = stack.pop(); guard += 1;
      const nm = named.get(i);
      if (nm && boxes.has(nm)) out.add(nm);
      for (const c of kids.get(i) || []) stack.push(c);
    }
    return [...out].sort();
  };
  return { resolve, names: [...new Set([...boxes.keys(), ...byName.keys()])] };
}

// Turn round 1's `suggestViews` into regions `planCloseUps` can aim at. This is
// the `hypothesis --suggestView--> observation` edge becoming executable: the
// model said where it was unsure, and something has to convert that sentence into
// a camera pose.
//
// suggestView.target arrives in three shapes (see suggestFor in vision-propose),
// and each needs a different lookup:
//   model    free text            "the front-left rotor hub"
//   derived  a NODE NAME          names[0] of the proposal it came from
//   derived  a FRAME ID           the frame whose channels disagreed
// Resolution is a ladder from most to least specific, and the last rung is the
// set of parts that proposal actually grounded to — because a suggestView always
// has an index, and the grounded parts are never a guess.
//
// Anything that resolves to nothing is REPORTED, not approximated. A close-up
// aimed at a plausible-looking part is worse than no close-up: it spends the
// round-2 budget and produces a confident answer to a question nobody asked.
export function regionsFromSuggestViews(g, suggestViews, {
  grounded = [], plan = null, frames = [], manifest = null,
  maxRegions = 4, viewport = VIEWPORT, margin = 1.15,
} = {}) {
  const list = (suggestViews || []).filter((s) => s && typeof s === 'object');
  const named = namedIndex(g);
  const boxes = namedBoxes(g, renderTargets(g), (n) => named.get(n.i));
  const { resolve, names } = nameResolver(g, boxes, named);
  const R = modelRadius(g);
  const clampR = (r) => Math.max(REGION_MIN_R * R, Math.min(REGION_MAX_R * R, r));

  // A frame reference may be the FRAME id (`v3.colorId`) or the VIEW id (`v3`),
  // depending on which rung produced it, so index both.
  const viewById = new Map((plan?.views || []).map((v) => [String(v.id), v]));
  const frameToView = new Map();
  for (const f of frames || []) {
    const v = viewById.get(String(f?.viewId ?? '')) || viewById.get(String(f?.id ?? ''));
    if (!v) continue;
    if (f.id != null) frameToView.set(String(f.id), v);
    if (f.viewId != null) frameToView.set(String(f.viewId), v);
  }
  const lookup = (ref) => (ref == null || ref === '' ? null
    : viewById.get(String(ref)) || frameToView.get(String(ref)) || null);
  const groundedByIndex = new Map((grounded || []).filter((x) => x && x.index != null).map((x) => [x.index, x]));

  const namesInText = (text) => {
    const low = String(text ?? '').toLowerCase();
    const hits = new Set();
    for (const nm of names) {
      const key = String(nm).toLowerCase();
      if (key.length < MIN_NAME_TOKEN || !low.includes(key)) continue;
      for (const r of resolve(nm)) hits.add(r);
    }
    return [...hits].sort();
  };

  // Unambiguous max only — the discipline reopenFromRigidity already uses. Two
  // records scoring equally means the text did not pick one, and picking anyway
  // would spend a frame on a part nobody was unsure about.
  const manifestMatch = (text) => {
    const low = normText(text);
    if (!low) return null;
    const toks = low.split(' ').filter((t) => t.length >= MIN_NAME_TOKEN);
    const scored = [];
    for (const rec of manifest || []) {
      const parts = [...new Set((rec?.nodes || []).flatMap((n) => resolve(n)))];
      if (!parts.length) continue;
      const id = normText(rec?.id);
      const lab = normText(rec?.label);
      const phrase = Math.max(
        id && low.includes(id) ? (low === id ? 3 : 2) : 0,
        lab && low.includes(lab) ? (low === lab ? 3 : 2) : 0,
      );
      const words = new Set([...id.split(' '), ...lab.split(' ')].filter(Boolean));
      const shared = toks.filter((t) => words.has(t)).length;
      scored.push({ rec, parts, score: phrase * 10 + shared });
    }
    const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) return null;
    return ranked[0];
  };

  const resolved = [];
  const unresolved = [];
  // Report the entries that were not even objects. Silently dropping them would
  // hide a producer bug behind a round 2 that just did less than it was told.
  (suggestViews || []).forEach((s, i) => {
    if (s && typeof s === 'object') return;
    unresolved.push({ index: i, target: null, frameId: null, reason: null, origin: 'model', why: 'suggestView was not an object' });
  });
  list.forEach((sv, i) => {
    const target = sv.target == null ? '' : String(sv.target);
    const gr = sv.index != null ? groundedByIndex.get(sv.index) : null;
    const frameView = lookup(target) || lookup(sv.frameId);
    const aim = frameView?.spec?.target || frameView?.pose?.target || null;
    // Only offset a bearing we actually know. A region named from free text has
    // no failed frame behind it, so azimuth 0 plus the planner's own spread is
    // the honest answer.
    const azimuth = Number.isFinite(frameView?.spec?.azimuth)
      ? (frameView.spec.azimuth + AZIMUTH_RETRY) % 360 : 0;

    let parts = resolve(target);
    let how = parts.length ? 'name' : null;
    if (!parts.length) {
      const inText = namesInText(target);
      if (inText.length) { parts = inText; how = 'name-in-text'; }
    }
    if (!parts.length) {
      const m = manifestMatch(target);
      if (m) { parts = m.parts; how = `manifest:${m.rec.id}`; }
    }
    if (!parts.length && Array.isArray(gr?.names)) {
      const gn = [...new Set(gr.names.flatMap((n) => resolve(n)))].sort();
      if (gn.length) { parts = gn; how = 'grounded-parts'; }
    }
    if (!parts.length && !aim) {
      unresolved.push({
        index: sv.index ?? i, target, frameId: sv.frameId || null,
        reason: sv.reason || null, origin: sv.origin || 'model',
        why: 'target matched no part, no joint and no frame we shot',
      });
      return;
    }
    // Nothing named it, but we know the frame that was unsure — so aim there
    // again from another bearing. Recorded as its own rung because a region with
    // no names gets no mask (a colorId legend is built from names), only photos
    // and ghosts.
    if (!parts.length) how = 'frame-aim';

    const box = parts.length ? unionBoxes(parts.map((nm) => boxes.get(nm))) : null;
    const anchor = box ? box.c.slice() : aim.map(Number);
    if (!anchor.every(Number.isFinite)) {
      unresolved.push({
        index: sv.index ?? i, target, frameId: sv.frameId || null,
        reason: sv.reason || null, origin: sv.origin || 'model',
        why: 'resolved to a pose with no finite aim point',
      });
      return;
    }
    // With parts, size the region to them. Without, recover the radius the frame
    // was fitted to — the pose is the only thing recorded about it — which for a
    // cell frame is exactly the cell, and for a whole-model ring clamps to the
    // ceiling instead of re-shooting round 1.
    const radius = clampR(box
      ? Math.hypot(...box.h) * REGION_PAD
      : unfitDistance(frameView?.spec?.distance ?? 2.5 * R, viewport, margin));

    resolved.push({
      id: `sv${i}_${slug(parts[0] || target || sv.frameId)}`,
      index: sv.index ?? i, target, how, names: parts,
      anchor, radius, azimuth,
      reason: sv.reason || null, origin: sv.origin || 'model',
      frameId: sv.frameId || null,
    });
  });

  // The model's own request outranks one we synthesized, and a region we could
  // NAME outranks one we could only locate — naming it is what makes the close-up
  // mask focusable. Sort is stable, so equal ranks keep suggestion order.
  const rank = (r) => ((r.origin === 'model' ? 0 : 1) * 2) + (r.names.length ? 0 : 1);
  // Rank BEFORE dedup. Two suggestViews about the same parts are one region —
  // buying both would spend the round-2 budget on the same close-up from two
  // nearby bearings — and the survivor should be the model's explicit request,
  // not whichever happened to come first in the list.
  const ordered = resolved.slice().sort((a, b) => rank(a) - rank(b));
  const byKey = new Map();
  const skipped = [];
  for (const r of ordered) {
    const key = r.names.length
      ? r.names.join('|')
      : `aim:${r.anchor.map((v) => v.toFixed(1)).join(',')}`;
    const prev = byKey.get(key);
    if (prev) { skipped.push({ ...r, why: `same ${prev.names.length ? 'parts' : 'aim point'} as ${prev.id}` }); continue; }
    byKey.set(key, r);
  }
  const cap = Math.max(1, maxRegions | 0);
  const deduped = [...byKey.values()];
  const regions = deduped.slice(0, cap);
  for (const r of deduped.slice(cap)) skipped.push({ ...r, why: `over the ${cap}-region cap` });

  return { regions, resolved: regions, unresolved, skipped };
}

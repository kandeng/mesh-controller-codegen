// Carve proof — the automated answer to "when a mesh LOOKS right but has no
// internal mechanical nodes, can we still cut a pointed-at surface patch out of
// the fused shell, register it as a node, and reproduce that cut exactly?"
//
// Legs, exit 0 only if all hold:
//   A) readGeometry lazily decodes the real GLB buffer: vertex/index counts
//      match the accessor table, indices stay in range, the decoded bbox
//      matches the declared accessor min/max, and the decode is cached
//   B) the flood cutter on a synthetic loft (wheel joined to a hull by a thin
//      strut): the radius cap separates at the strut, hull triangles are
//      excluded, the cone rule refuses a >90° fold, and rays/seed are exact
//   C) the shell trigger inside boxToNodes: on the marussia a front-wheel box
//      grounds wheel-assembly nodes and carves NOTHING (its wheels are proper
//      nodes — the trigger must stay silent), while on a synthetic fused car
//      (wheel lofted INTO the hull) the same box cuts the wheel surface out,
//      names it rig#carve1, and reproduces byte-identically
//   D) registerCarve/applyCarves round-trip: a registered patch becomes a
//      named node, and a persisted (triangle-less) spec re-derives the
//      identical cut on a fresh graph
//   E) carve-kin reconciliation: a carve overlaps ONLY its source — a hint
//      claiming the patch supersedes the shell record, a free proposal
//      corroborates it, and two patches of one shell never merge; the carve
//      spec survives manifest.json persistence
//   F) scene materialization: buildScene names the carve, the rigidity harness
//      can drive it, and the battery treats a single-member carved joint as
//      trivially scoped (spread passes; attachment stays advisory)
//   G) viewer materialization (on-surface OUT): the shipped spec cuts the
//      patch out of the source geometry and re-adds it as a subtree named the
//      carve id — world placement unchanged, pivot at the patch centroid,
//      re-syncs idempotent, a second carve on the same source neither
//      resurrects nor renumbers the first
//   H) non-identity placement: the soup is mesh-LOCAL but the pointing is
//      WORLD — through the marussia's own node matrix (0.025 scale + axis
//      swap + translation) the same pointing seeds the same soup triangle,
//      the spec persists the LOCAL radius applyCarves re-floods with, and
//      wb/centroid come out in world units
//
// Usage: node test/verify-carve.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import { extractGltfJson, parseGlb } from '../src/lib/gltf.mjs';
import {
  applyCarves, carveEvidence, floodPatch, rayTriangles, registerCarve, seedFromRegion, worldScaleOf,
} from '../src/plugins/discovery/carve.mjs';
import { boxToNodes } from '../src/plugins/discovery/grounding.mjs';
import { isHintRecord, reconcileLanes } from '../src/plugins/discovery/loop.mjs';
import { saveManifest } from '../src/plugins/discovery/manifest.mjs';
import {
  attachmentSanity, buildScene, captureRel, drivePivot, scopeSpread,
} from '../src/plugins/discovery/tests.mjs';
import { makeCamera, namedIndex, project } from '../src/plugins/discovery/views.mjs';
import { materializeCarves, soupMeshesOf } from '../app/src/lib/carve-materialize.js';

const GLB = 'samples/drone_dji_inspire3.glb';
const CAR = '/home/robot/drone-navigation-v2/client/assets/mesh/car_marussia_b1.glb';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); } else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('\nProving on-surface carving\n');

// ---- A) lazy geometry decode -------------------------------------------------
{
  const g = await parseGlb(GLB);
  const { g: gj } = await extractGltfJson(readFileSync(GLB));

  // Independent expectation straight from the accessor table: triangle
  // primitives only, POSITION counts summed, index counts summed, min/max
  // unioned — the same rules readGeometry is specified to merge by.
  const mesh0 = (gj.meshes || [])[0];
  let wantVerts = 0; let wantIdx = 0;
  const mn = [Infinity, Infinity, Infinity]; const mx = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh0.primitives || []) {
    if ((p.mode ?? 4) !== 4) continue;
    const pa = gj.accessors[p.attributes.POSITION];
    wantVerts += pa.count;
    wantIdx += p.indices != null ? gj.accessors[p.indices].count : pa.count;
    for (let k = 0; k < 3; k += 1) {
      if (pa.min[k] < mn[k]) mn[k] = pa.min[k];
      if (pa.max[k] > mx[k]) mx[k] = pa.max[k];
    }
  }

  const geo = g.readGeometry(0);
  ok('A: mesh 0 decodes to the accessor-declared vertex and index counts',
    !!geo && geo.positions.length === wantVerts * 3 && geo.index.length === wantIdx,
    geo ? `${geo.positions.length / 3} verts, ${geo.index.length / 3} tris` : 'null');

  let maxIdx = 0;
  for (const v of geo.index) if (v > maxIdx) maxIdx = v;
  ok('A: every index stays inside the vertex array', maxIdx < wantVerts, `max index ${maxIdx} of ${wantVerts}`);

  const bn = [Infinity, Infinity, Infinity]; const bx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < geo.positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      if (geo.positions[i + k] < bn[k]) bn[k] = geo.positions[i + k];
      if (geo.positions[i + k] > bx[k]) bx[k] = geo.positions[i + k];
    }
  }
  const bboxOk = [0, 1, 2].every((k) => Math.abs(bn[k] - mn[k]) < 1e-4 && Math.abs(bx[k] - mx[k]) < 1e-4);
  ok('A: the decoded positions reproduce the declared accessor min/max bbox',
    bboxOk, `[${bn.map((v) => v.toFixed(3))}] .. [${bx.map((v) => v.toFixed(3))}]`);

  ok('A: the decode is cached — a second read returns the same object',
    g.readGeometry(0) === geo);
  ok('A: an out-of-range mesh index is a clean null, not a throw',
    g.readGeometry(99999) === null && g.readGeometry(-1) === null);
  ok('A: every mesh node carries its mesh index for readGeometry',
    g.nodes.filter((n) => n.mesh).every((n) => Number.isInteger(n.mi) && (gj.meshes || [])[n.mi]));
  ok('A: the carve registry starts empty',
    Array.isArray(g.carves) && g.carves.length === 0);

  // The fused-shell case this feature exists for must decode too.
  const car = await parseGlb(CAR);
  const shell = car.nodes.filter((n) => n.mesh && n.mi != null)
    .sort((a, b) => Math.hypot(...(b.wb?.h || [0, 0, 0])) - Math.hypot(...(a.wb?.h || [0, 0, 0])))[0];
  const cg = shell ? car.readGeometry(shell.mi) : null;
  ok('A: the marussia shell mesh decodes (the fused case carving exists for)',
    !!cg && cg.positions.length >= 9 && cg.index.length >= 3,
    cg ? `${cg.positions.length / 3} verts, ${cg.index.length / 3} tris in "${shell.name}"` : 'null');
}

// ---- the synthetic rig: a wheel lofted to a hull through a thin strut ----------
// Rings along X joined by strip quads, so the whole object is ONE edge-connected
// surface — exactly the fused-shell case. `sides` sets the ring resolution (4 for
// the cutter legs, 8 when the grounding path needs enough triangles to carve).
function buildLoft(stations, sides = 4) {
  const positions = [];
  const index = [];
  const tags = [];
  const ringOf = (x, h) => {
    const base = positions.length / 3;
    for (let j = 0; j < sides; j += 1) {
      if (sides === 4) {
        // The original square section, corners on the axes: (±h, ±h) pairs.
        positions.push(...[ [x, h, h], [x, -h, h], [x, -h, -h], [x, h, -h] ][j]);
      } else {
        const a = (j / sides) * Math.PI * 2;
        positions.push(x, h * Math.cos(a), h * Math.sin(a));
      }
    }
    return Array.from({ length: sides }, (_, j) => base + j);
  };
  const rings = stations.map((s) => ringOf(s.x, s.h));
  const cap = (ring, tag) => {
    for (let j = 1; j + 1 < ring.length; j += 1) {
      index.push(ring[0], ring[j], ring[j + 1]);
      tags.push(tag);
    }
  };
  cap(rings[0], 'wheel');
  for (let k = 0; k + 1 < rings.length; k += 1) {
    const a = rings[k]; const b = rings[k + 1];
    const tag = stations[k].tag;
    for (let j = 0; j < sides; j += 1) {
      const j1 = (j + 1) % sides;
      index.push(a[j], b[j], b[j1], a[j], b[j1], a[j1]);
      tags.push(tag, tag);
    }
  }
  cap(rings[rings.length - 1], 'hull');
  return { positions: Float32Array.from(positions), index: Uint32Array.from(index), tags };
}

const STATIONS = [
  { x: -1.0, h: 0.5, tag: 'wheel' },
  { x: 0.0, h: 0.5, tag: 'wheel' },
  { x: 0.4, h: 0.06, tag: 'shrink' },
  { x: 2.2, h: 0.06, tag: 'strut' },
  { x: 2.6, h: 0.5, tag: 'grow' },
  { x: 3.6, h: 0.5, tag: 'hull' },
];

const centroidOf = (soup, t) => {
  const at = (k) => (soup.index ? soup.index[k] : k);
  const o = [at(t * 3) * 3, at(t * 3 + 1) * 3, at(t * 3 + 2) * 3];
  return [0, 1, 2].map((k) => (soup.positions[o[0] + k] + soup.positions[o[1] + k] + soup.positions[o[2] + k]) / 3);
};

// ---- B) the flood cutter -------------------------------------------------------
{
  const soup = buildLoft(STATIONS);
  const ntris = soup.index.length / 3;
  // Seed: a wheel WALL triangle, from its own centroid — a pointing at the part.
  const seedTri = soup.tags.findIndex((tag, t) => tag === 'wheel' && centroidOf(soup, t)[0] > -0.999);
  const seedPoint = centroidOf(soup, seedTri);
  const patch = floodPatch(soup.positions, soup.index, seedTri, { maxRadius: 1.15, seedPoint });
  const inPatch = new Set(patch.tris);

  ok('B: every wheel triangle is flooded', (() => {
    for (let t = 0; t < ntris; t += 1) if (soup.tags[t] === 'wheel' && !inPatch.has(t)) return false;
    return true;
  })(), `${patch.tris.length} tris in patch`);

  ok('B: the flood separates at the strut — no strut/grow/hull triangle crosses',
    patch.tris.every((t) => soup.tags[t] === 'wheel' || soup.tags[t] === 'shrink'),
    `tags in patch: ${[...new Set(patch.tris.map((t) => soup.tags[t]))].join(', ')}`);

  const again = floodPatch(soup.positions, soup.index, seedTri, { maxRadius: 1.15, seedPoint });
  ok('B: the flood is deterministic', JSON.stringify(again.tris) === JSON.stringify(patch.tris));

  // The normal-cone rule in isolation: two triangles sharing an edge, folded.
  const fold = (deg) => {
    const a = (deg * Math.PI) / 180;
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, Math.cos(a), Math.sin(a)]);
    const index = Uint32Array.from([0, 1, 2, 3, 4, 5]);
    return floodPatch(positions, index, 0, { maxRadius: 10 });
  };
  ok('B: a 120-degree fold is a seam and is not crossed', fold(120).tris.length === 1);
  ok('B: an 80-degree fold is a crease and is crossed', fold(80).tris.length === 2);

  const hit = rayTriangles(soup.positions, soup.index, [-5, 0.25, 0.25], [1, 0, 0]);
  ok('B: a ray through the wheel reports the nearest triangle and the hit point',
    !!hit && soup.tags[hit.tri] === 'wheel' && Math.abs(hit.point[0] + 1) < 1e-6,
    hit ? `hit tri ${hit.tri} at x=${hit.point[0].toFixed(3)}` : 'no hit');
  ok('B: a ray that misses everything is a clean null',
    rayTriangles(soup.positions, soup.index, [-5, 50, 50], [1, 0, 0]) === null);

  const cam = makeCamera([-6, 0, 0], [0, 0, 0]);
  const seed = seedFromRegion(soup, cam, { x0: 0.45, y0: 0.45, x1: 0.55, y1: 0.55 });
  ok('B: a box at frame centre seeds the wheel surface the camera looks at',
    !!seed && soup.tags[seed.tri] === 'wheel' && Math.abs(seed.point[0] + 1) < 1e-4,
    seed ? `seed tri ${seed.tri} at ${seed.point.map((v) => v.toFixed(2))}` : 'no seed');
}

// ---- the fused car: ONE node whose single mesh is the whole machine ------------
// Shared by legs C/E/F. The wheel is only surface here — no wheel node exists.
const FUSED_STATIONS = [
  { x: -1.0, h: 0.4, tag: 'wheel' },
  { x: -0.55, h: 0.4, tag: 'wheel' },
  { x: -0.1, h: 0.4, tag: 'wheel' },
  { x: 0.5, h: 0.06, tag: 'shrink' },
  { x: 2.3, h: 0.06, tag: 'strut' },
  { x: 2.7, h: 0.8, tag: 'grow' },
  { x: 4.2, h: 0.8, tag: 'hull' },
];
const fusedSoup = () => buildLoft(FUSED_STATIONS, 8);
const mkFused = (soup) => ({
  nodes: [{
    i: 0, name: 'rig', parent: -1, children: 0,
    t: [0, 0, 0], q: null, s: null, lm: null,
    mesh: true, mi: 0,
    ext: { ex: 5.2, ey: 1.6, ez: 1.6 }, box: { min: [-1, -0.8, -0.8], max: [4.2, 0.8, 0.8] },
    wm: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], wp: [0, 0, 0], ws: [1, 1, 1],
    wext: { ex: 5.2, ey: 1.6, ez: 1.6 },
    wb: { min: [-1, -0.8, -0.8], max: [4.2, 0.8, 0.8], c: [1.6, 0, 0], h: [2.6, 0.8, 0.8] },
    r: 0, rr: 0,
  }],
  names: new Set(['rig']),
  carves: [],
  count: 1,
  readGeometry: () => soup,
  bounds: { min: [-1, -0.8, -0.8], max: [4.2, 0.8, 0.8] },
  ringAxes: [0, 1], ringCenter: [0, 0], ringRadius: 4,
});
// The survey-like box over the wheel end, precomputed once; grounding a fresh
// mkFused graph with it must always cut the same patch.
const fusedCam = makeCamera([-6.5, 2.2, 2.6], [1.6, 0, 0]);
const fusedBox = (() => {
  const p = project([-1, 0, 0], fusedCam);
  const hs = 0.1;
  return [p.x / fusedCam.w - hs, p.y / fusedCam.h - hs, p.x / fusedCam.w + hs, p.y / fusedCam.h + hs];
})();
const groundFused = (g) => boxToNodes(fusedBox, fusedCam, g);

// ---- C) the shell trigger inside boxToNodes --------------------------------------
// The marussia was the motivation for carving, so it is also the discipline case:
// its wheels ARE separate nodes (probe: tire/rim/brake per corner), which means a
// front-wheel box must ground wheel parts and the trigger must NOT fire. The
// firing case is the synthetic fused car — the wheel is only surface there.
{
  const carG = await parseGlb(CAR);
  const wc = [-3.82, 1.73, 6.23];           // front-left wheel centre (tire003's wb.c)
  const out = [wc[0] - carG.bcenter[0], 0, wc[2] - carG.bcenter[2]];
  const ol = Math.hypot(...out);
  const eye = [
    carG.bcenter[0] + (out[0] / ol) * carG.wradius * 1.9,
    carG.bcenter[1] + carG.wradius * 0.75,
    carG.bcenter[2] + (out[2] / ol) * carG.wradius * 1.9,
  ];
  const cam = makeCamera(eye, carG.bcenter);
  const p = project(wc, cam);
  const hs = 0.08;
  const box = [p.x / cam.w - hs, p.y / cam.h - hs, p.x / cam.w + hs, p.y / cam.h + hs];
  const r = boxToNodes(box, cam, carG);
  ok('C: a front-wheel box on the marussia grounds wheel-assembly nodes only',
    r.candidates.length > 0 && r.candidates.every((c) => /brake003|rim003|tire003/.test(c.name)),
    r.candidates.map((c) => c.name).join(', ') || 'no candidates');
  ok('C: ...and carves NOTHING — the trigger stays silent when proper nodes exist',
    r.carves.length === 0 && !r.warnings.some((w) => w.includes('carved')));

  // The fused counterpart: one 'rig' node whose single mesh IS the whole car.
  const soup2 = fusedSoup();
  const mkCar = () => mkFused(soup2);
  const g2 = mkCar();
  const r2 = groundFused(g2);
  ok('C: on the fused car the same box cuts the wheel surface into a named carve',
    r2.carves.length === 1 && r2.candidates.length === 1 && r2.candidates[0].name === 'rig#carve1'
      && r2.warnings.some((w) => w.includes('carved')),
    r2.warnings[0] || 'no carve warning');

  const spec2 = g2.carves[0];
  ok('C: the patch is exactly the wheel surface — no strut/hull triangle crosses',
    !!spec2 && spec2.tris.length > 0
      && spec2.tris.every((t) => soup2.tags[t] === 'wheel')
      && soup2.tags.every((tag, t) => tag !== 'wheel' || spec2.tris.includes(t)),
    spec2 ? `${spec2.triCount} tris, all tagged wheel` : 'no spec');
  ok('C: the carve bbox is wheel-sized, not shell-sized',
    !!spec2 && Math.abs(spec2.wb.h[1] - 0.4) < 0.02 && Math.abs(spec2.wb.h[2] - 0.4) < 0.02
      && spec2.wb.h[0] <= 0.8 && spec2.centroid[0] < 0.5,
    spec2 ? `h=[${spec2.wb.h.map((v) => v.toFixed(2))}]` : 'no spec');

  const rAgain = groundFused(mkCar());
  ok('C: two fresh grounds of the same box are byte-identical',
    JSON.stringify({ c: rAgain.candidates, v: rAgain.carves }) === JSON.stringify({ c: r2.candidates, v: r2.carves }));

  const rStable = groundFused(g2);
  ok('C: re-grounding the same graph resolves the existing carve, not a new one',
    rStable.carves.length === 0 && rStable.candidates[0]?.name === 'rig#carve1' && g2.carves.length === 1);
}

// ---- D) registration and deterministic re-derivation -----------------------------
{
  const soup = buildLoft(STATIONS);
  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const wbOf = () => {
    const mn = [-1, -0.5, -0.5]; const mx = [3.6, 0.5, 0.5];
    return { min: mn, max: mx, c: [1.3, 0, 0], h: [2.3, 0.5, 0.5] };
  };
  const mkGraph = () => ({
    nodes: [{
      i: 0, name: 'rig', parent: -1, children: 0,
      t: [0, 0, 0], q: null, s: null, lm: null,
      mesh: true, mi: 0,
      ext: { ex: 4.6, ey: 1, ez: 1 }, box: { min: [-1, -0.5, -0.5], max: [3.6, 0.5, 0.5] },
      wm: IDENT, wp: [0, 0, 0], ws: [1, 1, 1],
      wext: { ex: 4.6, ey: 1, ez: 1 }, wb: wbOf(),
      r: 0, rr: 0,
    }],
    names: new Set(['rig']),
    carves: [],
    count: 1,
    readGeometry: () => soup,
    ringAxes: [0, 1], ringCenter: [0, 0], ringRadius: 4,
  });

  const seedTri = soup.tags.findIndex((tag, t) => tag === 'wheel' && centroidOf(soup, t)[0] > -0.999);
  const patch = floodPatch(soup.positions, soup.index, seedTri, { maxRadius: 1.15, seedPoint: centroidOf(soup, seedTri) });
  patch.mi = 0;

  const g = mkGraph();
  const spec = registerCarve(g, 'rig', patch, { maxRadius: 1.15 });
  ok('D: a registered patch becomes a named virtual node with the measured bbox',
    spec.id === 'rig#carve1' && g.nodes.length === 2 && g.nodes[1].name === 'rig#carve1'
      && g.nodes[1].parent === -1 && g.nodes[1].mesh === true && g.nodes[1].carve === 'rig#carve1'
      && g.names.has('rig#carve1') && g.carves.length === 1 && g.count === 2
      && spec.wb.h[0] < 1 && spec.area > 0 && spec.triCount === patch.tris.length,
    `${spec.id}: ${spec.triCount} tris, wb h=[${spec.wb.h.map((v) => v.toFixed(2))}]`);

  ok('D: the carve node joins the name vocabulary (namedIndex resolves to itself)',
    namedIndex(g).get(1) === 'rig#carve1');
  ok('D: the node origin is where the patch IS, not where the source origin is',
    Math.hypot(...g.nodes[1].wp.map((v, k) => v - spec.centroid[k])) < 1e-9);

  ok('D: re-registering the identical cut is idempotent',
    registerCarve(g, 'rig', patch, { maxRadius: 1.15 }) === spec && g.carves.length === 1);

  // The reload path: a persisted, triangle-less spec on a FRESH graph must
  // re-derive the identical cut — same id, same tri count, same centroid.
  const persisted = JSON.parse(JSON.stringify(carveEvidence(spec)));
  ok('D: the evidence form drops the triangle list but keeps the seed and count',
    persisted.tris === undefined && persisted.triCount === spec.triCount && persisted.seed.tri === patch.seedTri);

  const g2 = mkGraph();
  const res = applyCarves(g2, [persisted]);
  ok('D: applyCarves re-derives the identical cut on a fresh graph',
    res.length === 1 && res[0].ok === true && res[0].id === 'rig#carve1'
      && g2.carves.length === 1 && g2.carves[0].triCount === spec.triCount
      && Math.hypot(...g2.carves[0].centroid.map((v, k) => v - spec.centroid[k])) < 1e-9,
    res[0]?.why || `re-derived ${g2.carves[0]?.triCount} tris`);

  const tampered = { ...persisted, triCount: persisted.triCount + 1 };
  const bad = applyCarves(mkGraph(), [tampered]);
  ok('D: a spec that no longer reproduces is reported, not silently accepted',
    bad.length === 1 && bad[0].ok === false && /re-derived/.test(bad[0].why || ''));
}

// ---- E) carve-kin reconciliation + manifest persistence ---------------------------
{
  const shell = { id: 'rotor_geo_0', type: 'rotor', origin: 'L1-geometry', nodes: ['rig'], verdict: null };
  const hint = {
    id: 'rotor_hint_0', type: 'rotor', origin: 'expectation-hint', hinted: true,
    nodes: ['rig#carve1'], part: 'wheel', verdict: null,
  };

  const sup = reconcileLanes([shell], { records: [{ ...hint }] }, { prefer: isHintRecord });
  ok('E: a patch hint supersedes the shell record its surface was cut from',
    sup.records.length === 1 && sup.records[0].id === 'rotor_hint_0'
      && sup.superseded.length === 1 && sup.superseded[0].id === 'rotor_geo_0'
      && sup.superseded[0].match === 'overlap',
    JSON.stringify(sup.superseded));

  const cor = reconcileLanes(
    [{ ...shell }],
    { records: [{ ...hint, id: 'rotor_vis_0', hinted: false, origin: 'L2-vision' }] },
  );
  ok('E: without hint standing the patch corroborates the shell instead of duplicating it',
    cor.records.length === 0 && cor.superseded.length === 0
      && cor.agreed.length === 1 && cor.confirms.some((c) => c.targetId === 'rotor_geo_0'));

  const twoPatches = reconcileLanes(
    [{ id: 'rotor_vis_0', type: 'rotor', nodes: ['rig#carve1'], verdict: null }],
    { records: [{ ...hint, id: 'rotor_vis_1', nodes: ['rig#carve2'] }] },
    { prefer: isHintRecord },
  );
  ok('E: two patches cut from the SAME shell are not duplicates (front wheel vs rear wheel)',
    twoPatches.records.length === 1 && twoPatches.records[0].id === 'rotor_vis_1'
      && twoPatches.agreed.length === 0 && twoPatches.superseded.length === 0);

  const same = reconcileLanes(
    [{ id: 'rotor_vis_0', type: 'rotor', nodes: ['rig#carve1'], verdict: null }],
    { records: [{ ...hint, id: 'rotor_vis_1', nodes: ['rig#carve1'] }] },
  );
  ok('E: the identical patch is an exact match and corroborates',
    same.records.length === 0 && same.agreed.length === 1);

  // Persistence: the spec on the record must survive manifest.json verbatim —
  // it is the only way applyCarves can re-derive the patch after a reload.
  const soupE = fusedSoup();
  const gE = mkFused(soupE);
  const rE = groundFused(gE);
  const carveSpec = rE.carves[0];
  const dir = mkdtempSync(join(tmpdir(), 'carve-persist-'));
  try {
    saveManifest(dir, [{ id: 'rotor_vis_0', type: 'rotor', nodes: ['rig#carve1'], carve: carveSpec }]);
    const back = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).joints[0];
    ok('E: the carve spec survives manifest persistence (seed, params, count re-derivable)',
      back.carve?.id === 'rig#carve1' && back.carve?.source === 'rig'
        && back.carve?.seed?.tri === carveSpec.seed.tri
        && back.carve?.params?.maxRadius === carveSpec.params.maxRadius
        && back.carve?.triCount === carveSpec.triCount && back.carve?.tris === undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- F) scene materialization: the battery can drive a carved node by name -------
{
  const soupF = fusedSoup();
  const gF = mkFused(soupF);
  groundFused(gF);
  const root = buildScene(gF, THREE);
  const node = root.getObjectByName('rig#carve1');
  ok('F: buildScene materializes the carve as a named scene node', !!node);

  const joint = { nodes: ['rig#carve1'], anchor: { x: 0, y: 0, z: 0 } };
  const rest = captureRel(root, joint.nodes, THREE);
  drivePivot(root, joint, THREE, 0.9);
  const posed = captureRel(root, joint.nodes, THREE);
  ok('F: the rigidity harness drives the carved node by name (the controller contract)',
    rest.has('rig#carve1') && posed.has('rig#carve1')
      && rest.get('rig#carve1').q.angleTo(posed.get('rig#carve1').q) > 0.5);

  const spread = scopeSpread(gF, joint);
  const attach = attachmentSanity(gF, joint);
  ok('F: a single-member carved joint is trivially scoped — spread passes, attachment stays advisory',
    spread.pass === true && attach.level === 'warn',
    `spread: ${spread.detail}; attachment: ${attach.detail}`);
}

// ---- G) viewer materialization: the scene-side half of the carve contract ------
// Mirrored in Node against a real THREE scene. The source is TWO primitives —
// the soup mapping (spec.tris index the merged primitive soup, see readGeometry)
// is load-bearing: the wheel patch lives entirely in primitive 0, a second
// patch at the hull end lives entirely in primitive 1.
{
  const soupG = fusedSoup();
  const totalTris = soupG.index.length / 3; // 108: 54 wheel | shrink/strut/grow/hull
  const SPLIT = 54;
  const nv = soupG.positions.length / 3;
  // readGeometry's merge recipe for the two primitives: positions concatenated
  // per primitive (duplicated), the second index buffer re-based by +nv.
  const merged = {
    positions: Float32Array.from([...soupG.positions, ...soupG.positions]),
    index: Uint32Array.from([
      ...soupG.index.slice(0, SPLIT * 3),
      ...Array.from(soupG.index.slice(SPLIT * 3), (v) => v + nv),
    ]),
    tags: soupG.tags,
  };

  const gG = mkFused(merged);
  groundFused(gG);
  const specA = gG.carves[0];
  ok('G: the wheel patch of the split-source car sits entirely in primitive 0',
    !!specA && specA.tris.length > 0 && specA.tris.every((t) => t >= 0 && t < SPLIT));

  // A second patch at the hull end (grow-wall tris are 86..101, the cap 102+),
  // flooded by hand — all of it lands in primitive 1 of the merged soup.
  const seedB = 100;
  const patchB = floodPatch(merged.positions, merged.index, seedB, { maxRadius: 0.9, seedPoint: centroidOf(merged, seedB) });
  patchB.mi = 0;
  const specB = registerCarve(gG, 'rig', patchB, { maxRadius: 0.9 });
  ok('G: a second patch at the hull end registers as rig#carve2, disjoint and in primitive 1',
    specB.id === 'rig#carve2' && specB.tris.length > 0
      && specB.tris.every((t) => t >= SPLIT && t < totalTris)
      && !specB.tris.some((t) => specA.tris.includes(t)),
    `${specB.tris.length} tris`);

  // The viewer scene: 'rig' carries the two primitives (plus a DEEPER mesh that
  // is a child node, never soup) under a non-identity transform, so the
  // transform-copy and recentring maths are load-bearing too.
  const root = new THREE.Group(); root.name = 'scene';
  const src = new THREE.Group(); src.name = 'rig';
  src.position.set(0.3, -0.2, 0.1);
  src.rotation.z = Math.PI / 6;
  src.scale.set(1.25, 1.25, 1.25);
  const mkPrim = (from, to) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(soupG.positions.slice(), 3));
    geo.setIndex(Array.from(soupG.index.slice(from * 3, to * 3)));
    geo.computeVertexNormals();
    return geo;
  };
  const mat0 = new THREE.MeshStandardMaterial();
  const mat1 = new THREE.MeshStandardMaterial();
  const prim0 = new THREE.Mesh(mkPrim(0, SPLIT), mat0);
  const prim1 = new THREE.Mesh(mkPrim(SPLIT, totalTris), mat1);
  const deep = new THREE.Group(); deep.add(new THREE.Mesh(mkPrim(0, 2), mat0)); src.add(deep);
  src.add(prim0, prim1); root.add(src); root.updateMatrixWorld(true);
  ok('G: the soup is the node\'s own primitives only — deeper child meshes are excluded',
    soupMeshesOf(src).length === 2 && soupMeshesOf(src)[0] === prim0 && soupMeshesOf(src)[1] === prim1);

  // The wire form, mirroring jointSummary: the record's evidence form plus the
  // live registry's tris merged back in.
  const wireA = { ...carveEvidence(specA), tris: specA.tris };
  const wireB = { ...carveEvidence(specB), tris: specB.tris };

  const made1 = materializeCarves(root, [wireA], THREE);
  const grpA = root.getObjectByName('rig#carve1');
  ok('G: the patch becomes a subtree named the carve id under the source\'s parent',
    made1.length === 1 && !!grpA && grpA.parent === root
      && made1[0].parts.length === 1 && made1[0].parts[0].from === prim0
      && made1[0].parts[0].mesh.name === 'rig#carve1#p0'
      && grpA.quaternion.angleTo(src.quaternion) < 1e-9 && grpA.scale.distanceTo(src.scale) < 1e-9);

  const triCount = (m) => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  const rest0AfterA = prim0.geometry;
  ok('G: the source geometry loses exactly the patch — prim0 emptied, prim1 untouched',
    triCount(prim0) === 0 && prim1.geometry.index.count / 3 === totalTris - SPLIT);

  // World-placement invariance: a cut vertex rides the carve group to exactly
  // the world position it had in the source — only the pivot moved.
  root.updateMatrixWorld(true);
  const firstLocal = specA.tris[0];
  const vOrig = new THREE.Vector3().fromArray(soupG.positions, merged.index[firstLocal * 3] * 3);
  const vCarve = new THREE.Vector3().fromArray(made1[0].parts[0].mesh.geometry.attributes.position.array, 0);
  const viaGroup = grpA.localToWorld(vCarve.clone());
  const viaSource = src.localToWorld(vOrig.clone());
  ok('G: world placement is unchanged by the cut — only the pivot moved to the patch centroid',
    viaGroup.distanceTo(viaSource) < 1e-4
      && grpA.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(...specA.centroid)) < 1e-4,
    `drift ${viaGroup.distanceTo(viaSource).toExponential(2)}`);

  const made2 = materializeCarves(root, [wireA, wireB], THREE);
  const grpB = root.getObjectByName('rig#carve2');
  ok('G: a re-shipped spec is skipped; the second spec cuts primitive 1 only',
    made2.length === 1 && made2[0].id === 'rig#carve2' && !!grpB
      && made2[0].parts.length === 1 && made2[0].parts[0].from === prim1);
  ok('G: the first cut is neither resurrected nor renumbered by the second',
    prim0.geometry === rest0AfterA && triCount(prim0) === 0
      && triCount(prim1) === (totalTris - SPLIT) - specB.tris.length
      && triCount(made1[0].parts[0].mesh) + triCount(made2[0].parts[0].mesh) + triCount(prim0) + triCount(prim1) === totalTris);

  const made3 = materializeCarves(root, [wireA, wireB], THREE);
  ok('G: a full re-sync is a no-op (idempotent)',
    made3.length === 0 && triCount(prim1) === (totalTris - SPLIT) - specB.tris.length);

  // Pivot sanity: spinning the carve group moves the patch rigidly about the
  // pivot — vertex distances to the pivot are conserved, positions are not.
  const partV = new THREE.Vector3().fromArray(made2[0].parts[0].mesh.geometry.attributes.position.array, 0);
  root.updateMatrixWorld(true);
  const pivotW = grpB.getWorldPosition(new THREE.Vector3());
  const before = grpB.localToWorld(partV.clone());
  grpB.rotation.y += 0.7;
  root.updateMatrixWorld(true);
  const after = grpB.localToWorld(partV.clone());
  ok('G: the carve spins rigidly about its own pivot (the controller contract)',
    before.distanceTo(after) > 0.05
      && Math.abs(before.distanceTo(pivotW) - after.distanceTo(pivotW)) < 1e-4);
}

// ---- H) non-identity world matrix: the soup is mesh-LOCAL, the pointing WORLD --
// Real GLBs place meshes with non-identity node matrices — the marussia body
// carries 0.025 scale + an axis swap + a translation, and leg C's identity wm
// masked that. Seed rays are world rays but the soup is local: seedFromRegion
// casts through wm's inverse, and the trigger converts the box's world
// footprint into soup units for the flood while the spec persists the LOCAL
// radius (applyCarves re-floods in soup units on reload). This leg re-runs
// leg C's fused car under the marussia's own placement.
{
  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  // The marussia body placement verbatim: 0.025 scale, local x -> world -z.
  const WM = [0, 0, -0.025, 0, 0, 0.025, 0, 0, 0.025, 0, 0, 0, 4.5, 1.7, 6.2, 1];
  const xformP = (wm, p) => [
    wm[0] * p[0] + wm[4] * p[1] + wm[8] * p[2] + wm[12],
    wm[1] * p[0] + wm[5] * p[1] + wm[9] * p[2] + wm[13],
    wm[2] * p[0] + wm[6] * p[1] + wm[10] * p[2] + wm[14],
  ];
  const wbOf = (wm, box) => {
    const mn = [Infinity, Infinity, Infinity]; const mx = [-Infinity, -Infinity, -Infinity];
    for (const x of [box.min[0], box.max[0]]) {
      for (const y of [box.min[1], box.max[1]]) {
        for (const z of [box.min[2], box.max[2]]) {
          const w = xformP(wm, [x, y, z]);
          for (let k = 0; k < 3; k += 1) {
            if (w[k] < mn[k]) mn[k] = w[k];
            if (w[k] > mx[k]) mx[k] = w[k];
          }
        }
      }
    }
    return {
      min: mn, max: mx,
      c: mn.map((v, k) => (v + mx[k]) / 2),
      h: mn.map((v, k) => (mx[k] - v) / 2),
    };
  };

  ok('H: worldScaleOf reads the world<->soup exchange rate off the matrix',
    Math.abs(worldScaleOf(WM) - 0.025) < 1e-12
      && worldScaleOf(IDENT) === 1 && worldScaleOf(null) === 1);

  const soupH = fusedSoup();
  const mkFusedT = () => {
    const g = mkFused(soupH);
    const n = g.nodes[0];
    n.wm = WM.slice();
    n.ws = [0.025, 0.025, 0.025];
    n.wp = xformP(WM, [0, 0, 0]);
    n.wb = wbOf(WM, n.box);
    n.wext = { ex: n.wb.max[0] - n.wb.min[0], ey: n.wb.max[1] - n.wb.min[1], ez: n.wb.max[2] - n.wb.min[2] };
    g.bounds = { min: n.wb.min.slice(), max: n.wb.max.slice() };
    return g;
  };
  // The same pointing, expressed in the placed world: camera and wheel cap
  // ride the same transform, so every world distance is 0.025x leg C's.
  const camT = makeCamera(xformP(WM, [-6.5, 2.2, 2.6]), xformP(WM, [1.6, 0, 0]));
  const pT = project(xformP(WM, [-1, 0, 0]), camT);
  const boxT = [pT.x / camT.w - 0.1, pT.y / camT.h - 0.1, pT.x / camT.w + 0.1, pT.y / camT.h + 0.1];

  const gI = mkFused(soupH);
  groundFused(gI);
  const specI = gI.carves[0];

  // The regression the wm path fixes: casting world rays into the local soup
  // missed everything ('no surface under the pointed box'). Through the
  // inverse matrix the same pointing lands on the same soup triangle.
  const seedT = seedFromRegion(soupH, camT, { x0: boxT[0], y0: boxT[1], x1: boxT[2], y1: boxT[3] }, { wm: WM });
  ok('H: through a non-identity wm the world pointing seeds the same soup triangle',
    !!seedT && !!specI && seedT.tri === specI.seed.tri
      && Math.hypot(...seedT.point.map((v, k) => v - specI.seed.point[k])) < 1e-6,
    seedT ? `seed tri ${seedT.tri}` : 'no seed — the old world-ray-into-local-soup bug');

  const gH = mkFusedT();
  const rH = boxToNodes(boxT, camT, gH);
  const specH = gH.carves[0];
  ok('H: the shell trigger fires through the placement and names rig#carve1',
    rH.carves.length === 1 && rH.candidates[0]?.name === 'rig#carve1' && !!specH,
    rH.warnings[0] || 'no carve warning');

  ok('H: the placed carve cuts byte-identical soup triangles',
    !!specH && JSON.stringify(specH.tris) === JSON.stringify(specI.tris),
    specH ? `${specH.tris.length} tris` : 'no spec');

  ok('H: the spec persists the LOCAL radius, the world one riding as evidence',
    !!specH && Math.abs(specH.params.maxRadius - specI.params.maxRadius) / specI.params.maxRadius < 1e-6
      && Math.abs(specH.params.maxRadius * worldScaleOf(WM) - specH.params.maxRadiusWorld)
        / specH.params.maxRadiusWorld < 1e-6,
    specH ? `local ${specH.params.maxRadius.toFixed(3)} = world ${specH.params.maxRadiusWorld.toFixed(4)} / 0.025` : 'no spec');

  ok('H: wb and centroid are the identity measurements ridden through the wm',
    !!specH && Math.hypot(...specH.wb.h.map((v, k) => v - [specI.wb.h[2], specI.wb.h[1], specI.wb.h[0]][k] * 0.025)) < 1e-6
      && Math.hypot(...specH.centroid.map((v, k) => v - xformP(WM, specI.centroid)[k])) < 1e-6,
    specH ? `h=[${specH.wb.h.map((v) => v.toFixed(4))}]` : 'no spec');

  const persistedH = JSON.parse(JSON.stringify(carveEvidence(specH)));
  const gH2 = mkFusedT();
  const resH = applyCarves(gH2, [persistedH]);
  ok('H: applyCarves re-floods the placed shell from the persisted LOCAL radius',
    resH.length === 1 && resH[0].ok === true
      && JSON.stringify(gH2.carves[0].tris) === JSON.stringify(specH.tris)
      && Math.hypot(...gH2.carves[0].centroid.map((v, k) => v - specH.centroid[k])) < 1e-9,
    resH[0]?.why || 're-derived');

  const rHAgain = boxToNodes(boxT, camT, mkFusedT());
  ok('H: two fresh grounds of the placed shell are byte-identical',
    JSON.stringify({ c: rHAgain.candidates, v: rHAgain.carves })
      === JSON.stringify({ c: rH.candidates, v: rH.carves }));
}

console.log(`\n${fail === 0 ? 'CARVE_PROBE_OK' : 'CARVE_PROBE_FAILED'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

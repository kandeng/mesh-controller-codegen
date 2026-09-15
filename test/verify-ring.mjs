// Proves the geometry-based ring metric in gltf.mjs (ringAxes / ringCenter /
// ringRadius / per-node rr) and its two consumers: tier-1's S7 placement gate
// and bladeCandidates. Regression for the car_marussia_b1 failure: four
// non-mesh CoronaLight studio-light nodes at y=15 tripled the legacy node-
// origin radius (5.9 -> 15.4), making S7's 0.5xradius threshold unreachable
// for every wheel; the node-count-weighted centroid and the hardcoded XY
// plane (Z-up assumption) defeated even a mesh-only legacy radius.
//
// Synthetic glTF JSON documents (accessor min/max only — parseGlb never reads
// buffers), written to tmpdir: a Y-up car with overhead studio lights, and a
// Z-up drone with blade plates and far-corner lights.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGlb, bladeCandidates } from '../src/lib/gltf.mjs';
import { discCoherence, scopeSpread } from '../src/plugins/discovery/tests.mjs';

let passed = 0; let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label}`); }
}
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

const dir = mkdtempSync(join(tmpdir(), 'ring-'));
function writeGltf(name, doc) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(doc));
  return p;
}

// ---- model 1: Y-up car, 4 wheel corners, 2 overhead studio lights ----------
const carPath = writeGltf('car.gltf', {
  asset: { version: '2.0' },
  nodes: [
    { name: 'body', mesh: 0 },
    { name: 'wheel_fl', mesh: 1, translation: [3, 0, 5] },
    { name: 'wheel_fr', mesh: 2, translation: [-3, 0, 5] },
    { name: 'wheel_rl', mesh: 3, translation: [3, 0, -5] },
    { name: 'wheel_rr', mesh: 4, translation: [-3, 0, -5] },
    { name: 'brake_fl', mesh: 1, translation: [3, 0, 5] },
    { name: 'CoronaLight001', translation: [1, 30, 0] },
    { name: 'CoronaLight002', translation: [-1, 30, 0] },
  ],
  meshes: [
    { primitives: [{ attributes: { POSITION: 0 } }] },
    { primitives: [{ attributes: { POSITION: 1 } }] },
    { primitives: [{ attributes: { POSITION: 1 } }] },
    { primitives: [{ attributes: { POSITION: 1 } }] },
    { primitives: [{ attributes: { POSITION: 1 } }] },
  ],
  accessors: [
    { min: [-3.5, -0.5, -5.5], max: [3.5, 0.5, 5.5] },
    { min: [-0.25, -0.25, -0.25], max: [0.25, 0.25, 0.25] },
  ],
});

// ---- model 2: Z-up drone, 4 blade plates at the corners, lights far out ----
const dronePath = writeGltf('drone.gltf', {
  asset: { version: '2.0' },
  nodes: [
    { name: 'hull', mesh: 0 },
    { name: 'blade0', mesh: 1, translation: [10, 8, 0.5] },
    { name: 'blade1', mesh: 2, translation: [-10, 8, 0.5] },
    { name: 'blade2', mesh: 3, translation: [10, -8, 0.5] },
    { name: 'blade3', mesh: 4, translation: [-10, -8, 0.5] },
    { name: 'CoronaLight001', translation: [50, 50, 5] },
    { name: 'CoronaLight002', translation: [-50, -50, 5] },
  ],
  meshes: [
    { primitives: [{ attributes: { POSITION: 0 } }] },
    { primitives: [{ attributes: { POSITION: 1 } }] },
    { primitives: [{ attributes: { POSITION: 1 } }] },
    { primitives: [{ attributes: { POSITION: 1 } }] },
    { primitives: [{ attributes: { POSITION: 1 } }] },
  ],
  accessors: [
    { min: [-6, -6, -1], max: [6, 6, 1] },
    { min: [-1.5, -0.05, -0.3], max: [1.5, 0.05, 0.3] },
  ],
});

// ---- model 3: no mesh nodes at all — the ring metric must degrade to legacy -
const emptyPath = writeGltf('empty.gltf', {
  asset: { version: '2.0' },
  nodes: [{ name: 'rig', translation: [5, 0, 0] }, { name: 'rig2', translation: [-5, 0, 0] }],
});

console.log('\nProving the ring metric (ringAxes / ringCenter / ringRadius)');

const car = await parseGlb(carPath);
const wheels = car.nodes.filter((n) => /^wheel/.test(n.name));
ok(car.ringAxes[0] === 2 && car.ringAxes[1] === 0,
  `R1: the car's ground plane is picked from the bbox span (Z then X, not hardcoded XY) — [${car.ringAxes}]`);
ok(near(car.ringCenter[0], 0) && near(car.ringCenter[1], 0),
  `R1: the ring centre is the bbox centre, not the node-density centroid — [${car.ringCenter.map((v) => v.toFixed(2))}] (legacy centroid [${car.center.map((v) => v.toFixed(2))}])`);
ok(near(car.ringRadius, Math.hypot(3, 5), 0.01),
  `R1: the ring radius is the farthest MESH-node origin in the ground plane — ${car.ringRadius.toFixed(2)} ≈ 5.83`);
ok(car.radius > 3 * car.ringRadius,
  `R1: the legacy radius is inflated ~3.7x by the two overhead light helpers — ${car.radius.toFixed(2)} vs ${car.ringRadius.toFixed(2)} (this is the car_marussia_b1 bug)`);
ok(wheels.every((n) => n.rr >= 0.5 * car.ringRadius),
  `R1: every wheel passes tier-1 S7 under the ring metric — rr=[${wheels.map((n) => n.rr.toFixed(2))}] vs threshold ${(0.5 * car.ringRadius).toFixed(2)}`);
ok(wheels.every((n) => n.r < 0.5 * car.radius),
  `R1: ...and every wheel FAILED the legacy predicate (r=[${wheels.map((n) => n.r.toFixed(2))}] vs ${(0.5 * car.radius).toFixed(2)}) — the unsatisfiable check the DSH hit`);

const drone = await parseGlb(dronePath);
ok(drone.ringAxes[0] === 0 && drone.ringAxes[1] === 1,
  `R2: the Z-up drone's ground plane is XY — the axis pick adapts instead of assuming — [${drone.ringAxes}]`);
ok(near(drone.ringRadius, Math.hypot(10, 8), 0.01),
  `R2: the drone ring radius is the corner distance — ${drone.ringRadius.toFixed(2)} ≈ 12.81`);
const blades = bladeCandidates(drone);
ok(blades.length === 4,
  `R2: bladeCandidates finds all 4 blade plates under the ring metric — ${blades.map((b) => b.name)}`);
const bladesArr = drone.nodes.filter((n) => /^blade/.test(n.name));
ok(bladesArr.every((n) => n.r < 0.45 * drone.radius),
  `R2: under the legacy radius (light-inflated to ${drone.radius.toFixed(2)}) the same blades were ALL below the ring floor — the heuristic went blind`);

const empty = await parseGlb(emptyPath);
ok(empty.ringRadius === empty.radius && empty.ringAxes[0] === 0 && empty.ringAxes[1] === 1,
  `R3: a mesh-less rig degrades cleanly to the legacy metric — ringRadius=${empty.ringRadius.toFixed(2)}`);

// The known-good real drone: the new metric must not diverge wildly, and the
// blade heuristic must keep finding the blades it found before.
const real = await parseGlb(new URL('../samples/drone_dji_inspire3.glb', import.meta.url).pathname);
ok(real.ringRadius > 0.5 * real.radius && real.ringRadius < 2 * real.radius,
  `R4: on the real drone sample the ring radius tracks the legacy radius — ${real.ringRadius.toFixed(2)} vs ${real.radius.toFixed(2)}`);
ok(bladeCandidates(real).length > 0,
  `R4: ...and bladeCandidates still finds its blades — ${bladeCandidates(real).length} candidate(s)`);

// R5: the battery's scope ruler on a baked-origin mega-cluster. Body + two
// opposite wheels have wb centres spanning the model (11.66 = 2.0×ring),
// exactly the car_marussia_b1 "FR rotor" shape; a one-wheel scope is tight.
const monster = { id: 'j_monster', type: 'rotor', nodes: ['body', 'wheel_fl', 'wheel_rr'], anchor: { x: 0, y: 0, z: 0 } };
const sane = { id: 'j_wheel', type: 'rotor', nodes: ['wheel_fl', 'brake_fl'], anchor: { x: 3, y: 0, z: 5 } };
const msSpread = scopeSpread(car, monster);
ok(!msSpread.pass,
  `R5: scope-spread FAILS the cabin-swallowing mega-cluster — ${msSpread.detail}`);
ok(discCoherence(car, monster).pass,
  `R5: ...which the origin-era disc-coherence still passes — division of labour: scope-spread is the killer`);
ok(scopeSpread(car, sane).pass,
  `R5: scope-spread passes a tight one-wheel scope — ${scopeSpread(car, sane).detail}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

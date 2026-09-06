// Tear-off detector proof — the automated answer to "when the rotor spins or
// the gimbal tilts, did the maximal rigidly-coupled unit crack into pieces?"
// Three legs, exit 0 only if all three match the expected verdict:
//   A) ideal pivot motion  → relative-pose invariance PASSES (harness sanity)
//   B) cracked driver (the historical per-node-rotation bug) → FAILS, and the
//      offenders list names the cracked blade nodes
//   C) the reference controller (samples/drone-controller.js) → PASSES
//
// Usage: node test/verify-tearoff.mjs
import * as THREE from 'three';
import { parseGlb } from '../src/lib/gltf.mjs';
import { geometryDiscovery } from '../src/plugins/discovery/geometry.mjs';
import { buildScene, captureRel, compareRel, drivePivot, rigidityGate } from '../src/plugins/discovery/tests.mjs';

const GLB = 'samples/drone_dji_inspire3.glb';
const CTL = 'samples/drone-controller.js';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
  else { fail++; console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
};

console.log('\nProving tear-off detection (relative-pose invariance)\n');

const g = await parseGlb(GLB);
const { joints } = await geometryDiscovery.api.discover(GLB, null);
const rotor = joints.find((j) => j.type === 'rotor');
const eps = 1e-4 * g.radius;
ok('sample yields rotor joints', joints.filter((j) => j.type === 'rotor').length === 4, `eps=${eps.toFixed(4)}`);

// ---- A) ideal pivot: rigid motion must pass exactly -------------------------
{
  const root = buildScene(g, THREE);
  const rest = captureRel(root, rotor.nodes, THREE);
  drivePivot(root, rotor, THREE, 0.9);
  const r = compareRel(rest, captureRel(root, rotor.nodes, THREE), THREE, eps);
  ok('A: ideal pivot motion passes', r.pass === true, `maxDev ${(r.maxDevPos * 1000).toFixed(4)}mm / ${(r.maxDevAng * 180 / Math.PI).toFixed(4)}°`);
}

// ---- B) cracked driver: per-node spin must fail and name the blades ---------
{
  const root = buildScene(g, THREE);
  const rest = captureRel(root, rotor.nodes, THREE);
  const blades = rotor.meta?.blades || [];
  for (const nm of blades) {
    const o = root.getObjectByName(nm);
    if (o) o.rotation.y += 0.35; // the historical bug: spin each part about its OWN origin
  }
  root.updateMatrixWorld(true);
  const r = compareRel(rest, captureRel(root, rotor.nodes, THREE), THREE, eps);
  const named = new Set(r.offenders.map((o) => o.name));
  const caught = blades.filter((b) => named.has(b));
  ok('B: cracked driver is detected', r.pass === false, `maxDev ${(r.maxDevPos * 1000).toFixed(2)}mm / ${(r.maxDevAng * 180 / Math.PI).toFixed(1)}°`);
  ok('B: offenders name the cracked blades', caught.length > 0, `${caught.length}/${blades.length} blades flagged, e.g. ${r.offenders.slice(0, 3).map((o) => `${o.name} (+${o.devDeg}°)`).join(', ')}`);
}

// ---- C) reference controller: the fixed code must pass ----------------------
{
  const r = await rigidityGate(g, CTL, joints, THREE);
  ok('C: reference controller passes the rigidity gate', r.pass === true,
    (r.results || []).map((x) => `${x.set}:${x.pass ? 'ok' : `CRACK ${x.offenders?.slice(0, 2).map((o) => o.name).join(',')}`}`).join(' '));
  ok('C: coverage reports uncovered discovered members', (r.coverage || []).length === joints.length,
    (r.coverage || []).map((c) => `${c.joint}:${c.uncovered.length}/${c.members} uncovered`).join(' '));
}

console.log(`\n${fail === 0 ? 'TEAROFF_PROBE_OK' : 'TEAROFF_PROBE_FAILED'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

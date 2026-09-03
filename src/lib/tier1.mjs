// Tier 1 — headless kinematic harness: executes the REAL generated JS in Node
// against a real three.js scene graph (Object3D math only, no WebGL, no DOM).
// Catches the bug classes we actually hit live: blades left static because
// they are siblings of the hubs, camera payload detached from gimbal joints,
// wrong differential pairing, dead props, NaN transforms.
import { pathToFileURL } from 'node:url';
import { bladeCandidates } from './gltf.mjs';

const DT = 1 / 60;
const EPS = 1e-6;

export async function tier1(glb, controllerPath, THREE) {
  const failures = [];
  const warnings = [];
  const metrics = {};
  // Names that MUST resolve: the propeller blades (the user-visible spinner).
  // Decorative rotor parts (locks/spinners) often carry non-ASCII names an LLM
  // cannot reproduce byte-for-byte; failing the whole gate on those rejects an
  // otherwise-correct controller, so non-blade name misses are warnings only.
  const bladeSet = new Set(bladeCandidates(glb).map((n) => n.name));

  // ---- build the scene graph from the glTF JSON (names + hierarchy + TRS) ----
  const root = new THREE.Group();
  root.name = '__root__';
  const objs = glb.nodes.map((n) => {
    const o = new THREE.Object3D();
    o.name = n.name;
    if (n.t) o.position.set(n.t[0], n.t[1], n.t[2]);
    return o;
  });
  glb.nodes.forEach((n, i) => {
    if (n.parent >= 0) objs[n.parent].add(objs[i]);
    else root.add(objs[i]);
  });
  root.updateMatrixWorld(true);

  // ---- import + construct (capture the controller's missing-node warnings) --
  const captured = [];
  const origWarn = console.warn;
  console.warn = (...a) => captured.push(a.join(' '));
  let ctl = null;
  try {
    const mod = await import(`${pathToFileURL(controllerPath).href}?t=${Date.now()}`);
    ctl = mod.createDroneController(root, THREE);
  } catch (e) {
    console.warn = origWarn;
    return { pass: false, failures: [`import/construct failed: ${e.message}`], warnings, metrics };
  }
  console.warn = origWarn;
  const missingNames = captured
    .filter((w) => /missing node/i.test(w))
    .map((w) => w.replace(/^.*?missing node:\s*/i, '').trim());
  const missingBlades = missingNames.filter((nm) => bladeSet.has(nm));
  const missingOther = missingNames.filter((nm) => !bladeSet.has(nm));
  if (missingBlades.length) failures.push(`controller could not resolve BLADE node(s): ${missingBlades.join('; ')} — propeller blades will not spin`);
  if (missingOther.length) warnings.push(`controller could not resolve ${missingOther.length} non-blade node(s) (decorative rotor parts, likely non-ASCII names): ${missingOther.slice(0, 8).join('; ')}`);
  if (!ctl || typeof ctl.update !== 'function') {
    return { pass: false, failures: ['createDroneController returned no update()'], warnings, metrics };
  }

  let desc = null;
  try { desc = typeof ctl.describe === 'function' ? ctl.describe() : null; } catch { desc = null; }
  if (!desc || !Array.isArray(desc.propGroups) || desc.propGroups.length === 0) {
    failures.push('describe() missing or reports no propGroups');
    return { pass: false, failures, warnings, metrics };
  }
  const groups = desc.propGroups;
  const known = new Set(groups.flatMap((g) => g.names || []));
  const bogusBlades = [];
  const bogusOther = [];
  for (const g of groups) {
    for (const name of g.names || []) {
      if (glb.names.has(name) && root.getObjectByName(name)) continue;
      (bladeSet.has(name) ? bogusBlades : bogusOther).push(name);
    }
  }
  if (bogusBlades.length) failures.push(`describe() lists BLADE node(s) not resolvable in the GLB tree: ${bogusBlades.join('; ')}`);
  if (bogusOther.length) warnings.push(`describe() lists ${bogusOther.length} non-blade node(s) not in the GLB (ignored at runtime): ${[...new Set(bogusOther)].slice(0, 8).join('; ')}`);

  // ---- helpers ---------------------------------------------------------------
  const tick = (seconds) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) ctl.update(DT);
    root.updateMatrixWorld(true);
  };
  const state = () => (typeof ctl.getState === 'function' ? ctl.getState() : null);
  const rpms = () => {
    const s = state();
    const byKey = {};
    (s?.props || []).forEach((p) => { byKey[p.name] = p.rpm; });
    return byKey;
  };
  const meanRpm = (r) => {
    const v = Object.values(r);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const worldQuats = () => {
    const m = new Map();
    root.traverse((o) => m.set(o.name || o.uuid, o.getWorldQuaternion(new THREE.Quaternion())));
    return m;
  };
  const movedNames = (before, after) => {
    const out = new Set();
    for (const [k, q] of after) {
      const b = before.get(k);
      if (b && Math.abs(b.dot(q)) < 1 - 1e-9) out.add(k);
    }
    return out;
  };

  // Snapshot one FRAME apart: at 60 fps a fast prop can advance a whole
  // multiple of its blade symmetry per second, so integer-second snapshots
  // alias onto the same phase.
  const movedUnion = new Set();
  const snapMoved = () => {
    const q = worldQuats();
    ctl.update(DT);
    root.updateMatrixWorld(true);
    movedNames(q, worldQuats()).forEach((n) => movedUnion.add(n));
  };

  // ---- S1: idle — speed 0 must mean EVERYTHING stopped ------------------------
  ctl.setSpeed?.(0); ctl.goStraight?.(); ctl.setGimbal?.(0, 0);
  tick(3.0);
  snapMoved();
  if (movedUnion.size) {
    failures.push(`speed 0: ${movedUnion.size} node(s) still rotate (rotors must wind down to a full stop): ${[...movedUnion].slice(0, 8).join(', ')}`);
  }
  const rpmIdle = meanRpm(rpms());
  metrics.rpmIdle = Math.round(rpmIdle);
  if (!(rpmIdle <= 1)) failures.push(`speed 0: mean rpm ${Math.round(rpmIdle)} — rotors must stop`);

  // ---- S2: cruise — props spin, rpm grows with speed --------------------------
  ctl.setSpeed?.(10);
  tick(2.0);
  snapMoved();
  const movedProps = [...movedUnion].filter((n) => known.has(n));
  if (movedProps.length === 0) failures.push('speed 10: no prop-group node rotates');
  const rpmCruise = meanRpm(rpms());
  metrics.rpmCruise = Math.round(rpmCruise);
  if (!(rpmCruise > 50)) failures.push(`speed 10: mean rpm ${Math.round(rpmCruise)} too low (props idle?)`);
  ctl.setSpeed?.(2);
  tick(2.0);
  const rpmLow = meanRpm(rpms());
  metrics.rpmLow = Math.round(rpmLow);
  if (!(rpmCruise > rpmLow * 1.15)) {
    failures.push(`speed correlation: rpm@10 ${Math.round(rpmCruise)} not > rpm@2 ${Math.round(rpmLow)} × 1.15`);
  }

  // ---- S3/S4: turn — diagonal differential must exist and mirror -------------
  ctl.setSpeed?.(10);
  tick(1.0);
  const pairDelta = (r) => {
    const cw = groups.filter((g) => g.spin > 0).flatMap((g) => (r[g.key] != null ? [r[g.key]] : []));
    const ccw = groups.filter((g) => g.spin < 0).flatMap((g) => (r[g.key] != null ? [r[g.key]] : []));
    const m = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
    return m(cw) - m(ccw);
  };
  ctl.turnLeft?.(); tick(1.5);
  const rL = rpms();
  const spreadL = Math.max(...Object.values(rL)) - Math.min(...Object.values(rL));
  const dL = pairDelta(rL);
  ctl.turnRight?.(); tick(1.5);
  const rR = rpms();
  const dR = pairDelta(rR);
  metrics.turnLeftRpm = rL; metrics.turnRightRpm = rR;
  if (!(spreadL > 0.08 * meanRpm(rL))) failures.push('left turn: no differential between prop groups');
  if (!(Math.sign(dL) && Math.sign(dR) && Math.sign(dL) !== Math.sign(dR))) {
    failures.push('turn: CW/CCW pair differential does not mirror between left and right');
  }
  ctl.goStraight?.(); tick(1.0);
  snapMoved();

  // ---- S5: gimbal — joints converge, camera payload follows ------------------
  ctl.setSpeed?.(0); ctl.goStraight?.(); tick(2.0);
  const camNames = desc.cameraNames || [];
  const gimNames = desc.gimbalNames || [];
  if (gimNames.length === 0) failures.push('describe() reports no gimbalNames');
  if (camNames.length === 0) warnings.push('describe() reports no cameraNames — camera-follow check skipped');
  const qBefore = worldQuats();
  ctl.setGimbal?.(-45, 30);
  tick(2.5);
  const qAfter = worldQuats();
  const s = state();
  if (s?.gimbal) {
    if (Math.abs(s.gimbal.pitch - -45) > 2) failures.push(`gimbal pitch did not converge: ${s.gimbal.pitch.toFixed(1)} ≠ -45`);
    if (Math.abs(s.gimbal.yaw - 30) > 2) failures.push(`gimbal yaw did not converge: ${s.gimbal.yaw.toFixed(1)} ≠ 30`);
  } else {
    failures.push('getState() reports no gimbal state');
  }
  const angDelta = (b, a) => (b && a ? 2 * Math.acos(Math.min(1, Math.abs(b.dot(a)))) : 0);
  for (const gn of gimNames) {
    const d = angDelta(qBefore.get(gn), qAfter.get(gn));
    if (!(d > 0.3)) failures.push(`gimbal node ${gn} barely moved under command (Δ=${d.toFixed(3)} rad)`);
  }
  for (const cn of camNames) {
    const gRef = qAfter.get(gimNames[0]);
    const gPre = qBefore.get(gimNames[0]);
    const gd = angDelta(gPre, gRef);
    const cd = angDelta(qBefore.get(cn), qAfter.get(cn));
    if (!(cd > 0.3)) failures.push(`camera node ${cn} did not follow the gimbal (Δ=${cd.toFixed(3)} rad) — detached payload?`);
    else if (gd > 0 && (cd < 0.8 * gd || cd > 1.25 * gd)) {
      failures.push(`camera node ${cn} rotation Δ=${cd.toFixed(2)} inconsistent with gimbal Δ=${gd.toFixed(2)}`);
    }
  }

  // ---- S6: NaN / Infinity scan ------------------------------------------------
  let nan = 0;
  root.traverse((o) => {
    if (![o.position.x, o.position.y, o.position.z, o.rotation.x, o.rotation.y, o.rotation.z].every(Number.isFinite)) nan++;
  });
  if (nan) failures.push(`${nan} node(s) with non-finite transforms after scenarios`);

  // ---- S7: rotor groups must sit at the rotor ring and be compact -----------
  // World positions come from the glTF TRS/matrix chain (gltf.mjs). A group
  // placed at the body centre, or one mixing centre and corner nodes, is the
  // "wrong parts spin" bug class the human eye catches instantly.
  const byName = new Map(glb.nodes.map((n) => [n.name, n]));
  for (const g of groups) {
    const pts = (g.names || []).map((nm) => byName.get(nm)).filter(Boolean).map((n) => n.wp);
    if (pts.length < 2) continue;
    const gx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const gy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const cr = Math.hypot(gx - glb.center[0], gy - glb.center[1]);
    let spread = 0;
    for (const p of pts) for (const q of pts) spread = Math.max(spread, Math.hypot(p[0] - q[0], p[1] - q[1]));
    if (cr < 0.5 * glb.radius) {
      failures.push(`prop group ${g.key}: centroid r=${cr.toFixed(1)} not at the rotor ring (model radius ${glb.radius.toFixed(1)}) — group spins centre/body parts?`);
    }
    if (spread > 0.7 * glb.radius) {
      failures.push(`prop group ${g.key}: nodes span ${spread.toFixed(1)} world units (> 0.7×radius) — mixes body and rotor nodes?`);
    }
  }

  // ---- S8: blade coverage — every blade-like node must rotate ----------------
  // Candidates: flat wide world-space meshes out at the rotor ring (gltf.mjs).
  // A candidate counts as covered if it, any ancestor (rotation propagates
  // down) or any descendant (that is where its mesh lives) is in moved set.
  const idxOf = new Map(glb.nodes.map((n) => [n.name, n.i]));
  const childrenOf = new Map();
  glb.nodes.forEach((n) => {
    if (n.parent >= 0) {
      if (!childrenOf.has(n.parent)) childrenOf.set(n.parent, []);
      childrenOf.get(n.parent).push(n.i);
    }
  });
  const covered = (name) => {
    const i = idxOf.get(name);
    if (i == null) return true;
    let a = i;
    while (a >= 0) {
      if (movedUnion.has(glb.nodes[a].name)) return true;
      a = glb.nodes[a].parent;
    }
    const stack = [i];
    while (stack.length) {
      const j = stack.pop();
      if (movedUnion.has(glb.nodes[j].name)) return true;
      stack.push(...(childrenOf.get(j) || []));
    }
    return false;
  };
  for (const n of bladeCandidates(glb)) {
    if (known.has(n.name) || covered(n.name)) continue;
    failures.push(`blade-like node never rotates: ${n.name} (world xy=${n.wext.ex.toFixed(1)}x${n.wext.ey.toFixed(1)}, r=${n.r.toFixed(1)}) — frozen propeller blade?`);
  }

  return { pass: failures.length === 0, failures, warnings, metrics };
}

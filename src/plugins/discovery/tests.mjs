// Deterministic test battery for joint hypotheses — phase 1 of the
// hypothesis-testing + human-verdict discovery loop. All tests are headless
// (node + three.js, no WebGL/DOM) and deterministic: same GLB + same driver →
// same verdict.
//
// Flagship test: RELATIVE-POSE INVARIANCE (tear-off detection). A true rigid
// unit keeps every member's pose fixed relative to every other member under
// ANY rigid motion of the unit. Pairwise comparison cancels the unknown
// motion M entirely:  (M·Wi)⁻¹·(M·Wj) = Wi⁻¹·Wj.  We compare positions AND
// orientations — never origins alone: the historical blade tear-off spins a
// blade about its OWN origin, which origin distances cannot see.
import { pathToFileURL } from 'node:url';

const DT = 1 / 60;

// ---- scene -----------------------------------------------------------------

// Full-TRS scene graph from the parsed GLB node table. tier1's harness keeps
// translations only; rigidity math needs rotation too, so this builds its own
// scene (matrix-form nodes decompose into TRS).
export function buildScene(g, THREE) {
  const root = new THREE.Group();
  root.name = '__root__';
  const objs = g.nodes.map((n) => {
    const o = new THREE.Object3D();
    o.name = n.name;
    if (n.lm) {
      new THREE.Matrix4().fromArray(n.lm).decompose(o.position, o.quaternion, o.scale);
    } else {
      if (n.t) o.position.set(n.t[0], n.t[1], n.t[2]);
      if (n.q) o.quaternion.set(n.q[0], n.q[1], n.q[2], n.q[3]);
      if (n.s) o.scale.set(n.s[0], n.s[1], n.s[2]);
    }
    return o;
  });
  g.nodes.forEach((n, i) => {
    if (n.parent >= 0) objs[n.parent].add(objs[i]);
    else root.add(objs[i]);
  });
  root.updateMatrixWorld(true);
  return root;
}

// ---- relative-pose invariance (tear-off) -----------------------------------

// Capture each member's world pose. Pairwise rigid invariants are derived at
// compare time, so this is just position + quaternion per node.
export function captureRel(root, names, THREE) {
  const m = new Map();
  for (const nm of names) {
    const o = root.getObjectByName(nm);
    if (!o) continue;
    m.set(nm, {
      p: o.getWorldPosition(new THREE.Vector3()),
      q: o.getWorldQuaternion(new THREE.Quaternion()),
    });
  }
  return m;
}

// Compare rest vs posed: for every member pair (i,j) the rest-frame offset
// dp = q_i⁻¹·(p_j − p_i) and relative orientation rq = q_i⁻¹·q_j must be
// invariant. eps in model units (plan: 1e-4 × model radius); epsAngle in rad.
// epsAngle = 1e-2: ~17× above the float noise of high-rpm spinning over 60
// frames (measured ~1.05e-3 rad), ~35× below the smallest meaningful crack
// (leg-B per-node tear-off signals ~0.35 rad).
export function compareRel(rest, posed, THREE, eps, epsAngle = 1e-2) {
  const names = [...rest.keys()].filter((n) => posed.has(n));
  const score = new Map(names.map((n) => [n, { pos: 0, ang: 0 }]));
  let maxPos = 0; let maxAng = 0;
  for (let a = 0; a < names.length; a++) {
    for (let b = a + 1; b < names.length; b++) {
      const ra = rest.get(names[a]); const rb = rest.get(names[b]);
      const pa = posed.get(names[a]); const pb = posed.get(names[b]);
      const dpr = rb.p.clone().sub(ra.p).applyQuaternion(ra.q.clone().invert());
      const dpp = pb.p.clone().sub(pa.p).applyQuaternion(pa.q.clone().invert());
      const devPos = dpr.distanceTo(dpp);
      const qr = ra.q.clone().invert().multiply(rb.q);
      const qp = pa.q.clone().invert().multiply(pb.q);
      const devAng = 2 * Math.acos(Math.min(1, Math.abs(qr.dot(qp))));
      if (devPos > maxPos) maxPos = devPos;
      if (devAng > maxAng) maxAng = devAng;
      for (const [nm, dev] of [[names[a], devPos], [names[b], devPos]]) {
        const s = score.get(nm); if (dev > s.pos) s.pos = dev;
      }
      for (const [nm, dev] of [[names[a], devAng], [names[b], devAng]]) {
        const s = score.get(nm); if (dev > s.ang) s.ang = dev;
      }
    }
  }
  const offenders = [...score.entries()]
    .filter(([, s]) => s.pos > eps || s.ang > epsAngle)
    .sort((x, y) => (y[1].pos + y[1].ang) - (x[1].pos + x[1].ang))
    .slice(0, 8)
    .map(([name, s]) => ({ name, devMm: +(s.pos * 1000).toFixed(2), devDeg: +(s.ang * 180 / Math.PI).toFixed(2) }));
  return { pass: offenders.length === 0, maxDevPos: maxPos, maxDevAng: maxAng, offenders };
}

// Convenience wrapper: tear-off verdict for one joint between two snapshots.
export function relPoseInvariance(root, joint, THREE, radius, rest, posed) {
  const eps = 1e-4 * radius;
  const r = compareRel(rest || captureRel(root, joint.nodes, THREE), posed || captureRel(root, joint.nodes, THREE), THREE, eps);
  return {
    name: 'relative-pose-invariance', pass: r.pass, eps,
    detail: r.pass ? `maxDev ${(r.maxDevPos * 1000).toFixed(3)}mm / ${(r.maxDevAng * 180 / Math.PI).toFixed(3)}°` : `${r.offenders.length} offender(s)`,
    offenders: r.offenders,
  };
}

// Ideal reference motion: pivot at the joint anchor, attach() members (world
// transforms preserved), rotate. Rigid by construction — harness sanity leg.
export function drivePivot(root, joint, THREE, angle = 0.9) {
  const pivot = new THREE.Object3D();
  const a = joint.anchor || { x: 0, y: 0, z: 0 };
  pivot.position.set(a.x, a.y, a.z);
  root.add(pivot);
  for (const nm of joint.nodes || []) {
    const o = root.getObjectByName(nm);
    if (o) pivot.attach(o);
  }
  pivot.rotation.z = angle; // model space is Z-up: vertical spin axis
  root.updateMatrixWorld(true);
  return pivot;
}

// ---- rest-pose tests (hypothesis stage, no controller needed) ---------------

// Rotor: members must lie in one disc about the anchor (flat spin plane).
// Gimbal: members must cluster near the anchor (one compact payload unit).
export function discCoherence(g, joint) {
  const a = joint.anchor || { x: 0, y: 0, z: 0 };
  const byName = new Map(g.nodes.map((n) => [n.name, n]));
  const members = (joint.nodes || []).map((nm) => byName.get(nm)).filter(Boolean);
  if (!members.length) return { name: 'disc-coherence', pass: false, detail: 'no members resolve' };
  const h = (n) => Math.hypot(n.wp[0] - a.x, n.wp[1] - a.y);
  if (joint.type === 'rotor') {
    const R = Math.max(1e-6, ...members.map(h));
    const zDev = Math.max(...members.map((n) => Math.abs(n.wp[2] - a.z)));
    const pass = zDev <= 1.5 * R; // same flatness rule as the rig report's rotorDisc
    return { name: 'disc-coherence', pass, detail: `R=${R.toFixed(1)} zDev=${zDev.toFixed(2)} (tol ${(1.5 * R).toFixed(1)})` };
  }
  const spread = Math.max(...members.map((n) => Math.hypot(n.wp[0] - a.x, n.wp[1] - a.y, n.wp[2] - a.z)));
  const pass = spread <= 0.6 * g.radius;
  return { name: 'anchor-sphere', pass, detail: `spread=${spread.toFixed(1)} (tol ${(0.6 * g.radius).toFixed(1)})` };
}

// No node may belong to two joints (shared membership = ambiguous hypothesis).
export function isolation(joints) {
  const owner = new Map();
  const clashes = [];
  for (const j of joints) {
    for (const nm of j.nodes || []) {
      if (owner.has(nm)) clashes.push(`${nm} in ${owner.get(nm)} + ${j.id}`);
      else owner.set(nm, j.id);
    }
  }
  return { name: 'isolation', pass: clashes.length === 0, detail: clashes.slice(0, 4).join('; ') };
}

// Each member's bbox should touch another member (or the hub): floating parts
// suggest over-broad membership. WARNING-level — legit small gaps exist.
export function attachmentSanity(g, joint) {
  const byName = new Map(g.nodes.map((n) => [n.name, n]));
  const members = (joint.nodes || []).map((nm) => byName.get(nm)).filter((n) => n && n.wext);
  const tol = 0.05 * g.radius;
  const gap = (x, y) => {
    let s = 0;
    for (const [k, e] of [[0, 'ex'], [1, 'ey'], [2, 'ez']]) {
      const d = Math.max(0, Math.abs(x.wp[k] - y.wp[k]) - (x.wext[e] + y.wext[e]) / 2);
      s += d * d;
    }
    return Math.sqrt(s);
  };
  const floaters = members.filter((m) => members.every((o) => o === m || gap(m, o) > tol)).map((m) => m.name);
  // `floaters` is structured so consumers (the viewer preview) can skip the
  // over-collected outliers without parsing the human-readable detail string.
  return { name: 'attachment-sanity', pass: floaters.length === 0, level: 'warn', floaters, detail: floaters.length ? `${floaters.length} floating: ${floaters.slice(0, 4).join(', ')}` : 'all members attached' };
}

// ---- rigidity gate (controller stage) ---------------------------------------

// Run the candidate controller on a full-TRS scene and apply the tear-off test
// to the controller's DECLARED motion sets (describe().propGroups / gimbalNames
// + cameraNames — the same contract tier1 asserts). Rationale: the discovered
// joint is the MAXIMAL rigidly-coupled unit and may include genuinely static
// parts (a motor mount co-located with the hub); gating on discovery membership
// would flag every physically-correct controller. A real crack = two members of
// a DECLARED set moving mutually non-rigidly. The coverage report (which
// discovered members no declared set moves) is informational — it feeds the
// manifest's needs-verdict flow, not this gate.
export async function rigidityGate(g, controllerPath, joints, THREE) {
  const root = buildScene(g, THREE);
  const mod = await import(`${pathToFileURL(controllerPath).href}?t=${Date.now()}`);
  const ctl = mod.createDroneController(root, THREE);
  if (!ctl || typeof ctl.update !== 'function') {
    return { pass: false, error: 'createDroneController returned no update()', results: [] };
  }
  const tick = (seconds) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) ctl.update(DT);
    root.updateMatrixWorld(true);
  };
  const desc = (typeof ctl.describe === 'function' ? ctl.describe() : null) || {};
  const rotors = (desc.propGroups || []).filter((s) => (s.names || []).length);
  const gimbalSet = (desc.gimbalNames || []).length
    ? { key: 'gimbal', names: [...desc.gimbalNames, ...(desc.cameraNames || [])] }
    : null;
  const results = [];

  ctl.setSpeed?.(0); ctl.goStraight?.(); ctl.setGimbal?.(0, 0);
  tick(0.5); // settle startup transients

  if (rotors.length) {
    const rests = rotors.map((s) => ({ s, rest: captureRel(root, s.names, THREE) }));
    ctl.setSpeed?.(6);
    tick(1.0);
    for (const { s, rest } of rests) {
      results.push({ set: s.key, kind: 'rotor', names: s.names, ...compareRel(rest, captureRel(root, s.names, THREE), THREE, 1e-4 * g.radius) });
    }
    ctl.setSpeed?.(0);
    tick(0.5);
  }
  if (gimbalSet) {
    const rest = captureRel(root, gimbalSet.names, THREE);
    ctl.setGimbal?.(-40, 25);
    tick(1.5);
    results.push({ set: gimbalSet.key, kind: 'gimbal', names: gimbalSet.names, ...compareRel(rest, captureRel(root, gimbalSet.names, THREE), THREE, 1e-4 * g.radius) });
  }

  // Coverage: discovered joint members no declared set accounts for.
  const covered = new Set([
    ...rotors.flatMap((s) => s.names),
    ...(gimbalSet ? gimbalSet.names : []),
  ]);
  const coverage = (joints || []).map((j) => ({
    joint: j.id,
    members: (j.nodes || []).length,
    uncovered: (j.nodes || []).filter((nm) => !covered.has(nm)),
  }));

  return { pass: results.every((r) => r.pass), results, coverage };
}

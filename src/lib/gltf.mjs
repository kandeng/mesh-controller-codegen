// glTF/GLB JSON-chunk parser for the controller-generation tool.
// Everything tier-0/tier-1 need (names, hierarchy, translations, local mesh
// bbox extents) lives in the JSON chunk — no BIN decode required.
//
// Extraction is LIBRARY-FIRST: @gltf-transform/core validates the container
// (magic, version, chunk bounds) and returns the embedded glTF JSON. If the
// library ever rejects a file, the hand-rolled 5-line GLB chunk reader is the
// safety net — a fallback parse is tagged parser:'builtin-fallback' so the
// non-compliant container shows up in diagnostics. Text .gltf JSON is accepted
// too (the analysis below only needs the JSON document).
import { readFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';

const io = new NodeIO();

// Async because the library's binaryToJSON is Promise-based (v4.5.0).
export async function extractGltfJson(raw) {
  if (raw.length < 20 || raw.readUInt32LE(0) !== 0x46546c67) {
    // Not a GLB container — accept a plain .gltf JSON document.
    if (raw.toString('utf8', 0, Math.min(raw.length, 64)).trimStart().startsWith('{')) {
      return { g: JSON.parse(raw.toString('utf8')), parser: 'gltf-text' };
    }
    throw new Error('not a GLB (bad magic) and not a .gltf JSON document');
  }
  try {
    const doc = await io.binaryToJSON(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    return { g: doc.json, parser: 'gltf-transform' };
  } catch (libErr) {
    // Safety net: hand-rolled container read (spec-frozen since glTF 2.0).
    try {
      const clen = raw.readUInt32LE(12);
      if (raw.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first chunk is not JSON');
      const g = JSON.parse(raw.subarray(20, 20 + clen).toString('utf8'));
      return { g, parser: 'builtin-fallback' };
    } catch (ownErr) {
      throw new Error(`glTF extraction failed — library: ${libErr.message}; fallback: ${ownErr.message}`);
    }
  }
}

export async function parseGlb(path) {
  const raw = readFileSync(path);
  const { g, parser } = await extractGltfJson(raw);
  const nodes = g.nodes || [];
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children || []).forEach((c) => { parent[c] = i; }));
  const meshes = g.meshes || [];
  const accs = g.accessors || [];

  // Local XY extent of the first mesh found in the subtree (blade vs hub hint).
  function xyExtent(i) {
    const stack = [i];
    while (stack.length) {
      const n = nodes[stack.pop()];
      if (n.mesh != null) {
        let ex = 0; let ey = 0; let ez = 0;
        for (const p of (meshes[n.mesh] || {}).primitives || []) {
          const a = accs[(p.attributes || {}).POSITION];
          if (a && a.min && a.max) {
            ex = Math.max(ex, a.max[0] - a.min[0]);
            ey = Math.max(ey, a.max[1] - a.min[1]);
            ez = Math.max(ez, a.max[2] - a.min[2]);
          }
        }
        return { ex, ey, ez };
      }
      stack.push(...(n.children || []));
    }
    return null;
  }

  // Local AABB of the first mesh in the subtree: the UNION over primitives of the
  // accessor min/max. Kept strictly separate from `ext` above (which is the
  // per-axis max of per-primitive SPANS, the input to the phase-1 blade
  // heuristic) so adding world bboxes cannot perturb discovery results.
  //
  // Why this matters: `ext` alone cannot place a bbox. CAD-style exports bake
  // absolute vertex coordinates into the accessor and leave the node at the
  // origin, so centring a bbox on the node's world translation puts it in empty
  // space — up to tens of units away from the geometry it describes.
  function subtreeBox(i) {
    const stack = [i];
    while (stack.length) {
      const n = nodes[stack.pop()];
      if (n.mesh != null) {
        let mn = null; let mx = null;
        for (const p of (meshes[n.mesh] || {}).primitives || []) {
          const a = accs[(p.attributes || {}).POSITION];
          if (!a || !a.min || !a.max) continue;
          if (!mn) { mn = a.min.slice(0, 3); mx = a.max.slice(0, 3); continue; }
          for (let k = 0; k < 3; k += 1) {
            if (a.min[k] < mn[k]) mn[k] = a.min[k];
            if (a.max[k] > mx[k]) mx[k] = a.max[k];
          }
        }
        if (mn) return { min: mn, max: mx };
      }
      stack.push(...(n.children || []));
    }
    return null;
  }

  const info = nodes.map((n, i) => {
    // glTF nodes carry EITHER trs OR a 4x4 matrix (column-major). Sketchfab
    // exports frequently use matrix only — ignoring it collapses every world
    // position to the origin and hides node scale.
    let t = n.translation || null;
    let s = n.scale || null;
    if (Array.isArray(n.matrix) && n.matrix.length === 16) {
      const m = n.matrix;
      if (!t) t = [m[12], m[13], m[14]];
      if (!s) s = [
        Math.hypot(m[0], m[1], m[2]),
        Math.hypot(m[4], m[5], m[6]),
        Math.hypot(m[8], m[9], m[10]),
      ];
    }
    return {
      i,
      name: n.name || `node_${i}`,
      parent: parent[i],
      children: (n.children || []).length,
      t,
      q: n.rotation || null, // local rotation (quaternion) — rigidity tests need it
      s,
      lm: Array.isArray(n.matrix) && n.matrix.length === 16 ? n.matrix : null, // matrix-form local transform
      mesh: n.mesh != null,
      ext: xyExtent(i),
      box: subtreeBox(i),
    };
  });

  // World-space transform per node via full 4x4 matrix composition (parent
  // rotation included — chaining translations alone skews positions whenever
  // an ancestor is rotated, which Sketchfab roots usually are). Local matrix
  // comes from n.matrix or is composed from T/R/S; world = parent × local.
  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function mul4(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }
  function quatMat(q) {
    const [x, y, z, w] = q;
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
      0, 0, 0, 1,
    ];
  }
  function localMat(n) {
    if (Array.isArray(n.matrix) && n.matrix.length === 16) return n.matrix;
    const t = n.translation || [0, 0, 0];
    const s = n.scale || [1, 1, 1];
    const r = quatMat(n.rotation || [0, 0, 0, 1]);
    for (let c = 0; c < 3; c++) { r[c * 4] *= s[c]; r[c * 4 + 1] *= s[c]; r[c * 4 + 2] *= s[c]; }
    r[12] = t[0]; r[13] = t[1]; r[14] = t[2];
    return r;
  }
  const wm = new Array(nodes.length);
  function worldMat(i) {
    if (wm[i]) return wm[i];
    const p = parent[i];
    wm[i] = mul4(p >= 0 ? worldMat(p) : IDENT, localMat(nodes[i]));
    return wm[i];
  }
  // World AABB of a local box: push the 8 corners through the full world matrix
  // and re-bound. Column-major, so element (row r, col c) is m[c*4 + r].
  // Conservative under rotation (an OBB's AABB is never smaller than the OBB),
  // which is exactly what a visibility planner wants: it may over-claim a node
  // is on screen, it will never claim an off-screen node is visible.
  function worldBox(m, b) {
    let x0 = Infinity; let y0 = Infinity; let z0 = Infinity;
    let x1 = -Infinity; let y1 = -Infinity; let z1 = -Infinity;
    for (let k = 0; k < 8; k += 1) {
      const x = k & 1 ? b.max[0] : b.min[0];
      const y = k & 2 ? b.max[1] : b.min[1];
      const z = k & 4 ? b.max[2] : b.min[2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (wx < x0) x0 = wx; if (wx > x1) x1 = wx;
      if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
      if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
    }
    return {
      min: [x0, y0, z0], max: [x1, y1, z1],
      c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
      h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2],
    };
  }
  info.forEach((_, i) => worldMat(i));
  info.forEach((n, i) => {
    const m = wm[i];
    n.wm = m; // full world matrix — the rigidity battery's rest pose (read-only)
    n.wp = [m[12], m[13], m[14]];
    n.ws = [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])];
    n.wext = n.ext ? { ex: n.ext.ex * n.ws[0], ey: n.ext.ey * n.ws[1], ez: n.ext.ez * n.ws[2] } : null;
    n.wb = n.box ? worldBox(m, n.box) : null; // true placed world bbox
  });

  const extOf = (x) => Math.max(x.ex, x.ey);
  const maxExt = Math.max(1e-9, ...info.filter((x) => x.ext).map((x) => extOf(x.ext)));
  const maxWExt = Math.max(1e-9, ...info.filter((x) => x.wext).map((x) => extOf(x.wext)));
  // Horizontal model radius: farthest node world position from the XY centroid.
  const cx = info.reduce((a, n) => a + n.wp[0], 0) / info.length;
  const cy = info.reduce((a, n) => a + n.wp[1], 0) / info.length;
  const radius = Math.max(1e-9, ...info.map((n) => Math.hypot(n.wp[0] - cx, n.wp[1] - cy)));
  info.forEach((n) => { n.r = Math.hypot(n.wp[0] - cx, n.wp[1] - cy); });

  // World bbox of the whole model, unioned over PLACED mesh boxes, plus its
  // circumradius. `radius` above measures the spread of node ORIGINS, which is a
  // fine discovery proxy but a poor framing proxy — a model whose geometry is
  // baked into vertices can have every origin at 0. Camera framing uses this.
  let bx0 = Infinity; let by0 = Infinity; let bz0 = Infinity;
  let bx1 = -Infinity; let by1 = -Infinity; let bz1 = -Infinity;
  for (const n of info) {
    if (!n.wb) continue;
    if (n.wb.min[0] < bx0) bx0 = n.wb.min[0];
    if (n.wb.min[1] < by0) by0 = n.wb.min[1];
    if (n.wb.min[2] < bz0) bz0 = n.wb.min[2];
    if (n.wb.max[0] > bx1) bx1 = n.wb.max[0];
    if (n.wb.max[1] > by1) by1 = n.wb.max[1];
    if (n.wb.max[2] > bz1) bz1 = n.wb.max[2];
  }
  const hasBounds = Number.isFinite(bx0) && Number.isFinite(bx1);
  const bounds = hasBounds ? { min: [bx0, by0, bz0], max: [bx1, by1, bz1] } : null;
  const bcenter = hasBounds ? [(bx0 + bx1) / 2, (by0 + by1) / 2, (bz0 + bz1) / 2] : [cx, cy, 0];
  const wradius = hasBounds
    ? Math.max(1e-9, 0.5 * Math.hypot(bx1 - bx0, by1 - by0, bz1 - bz0))
    : radius;
  return {
    nodes: info,
    names: new Set(info.map((x) => x.name)),
    maxExt,
    maxWExt,
    radius,
    center: [cx, cy],
    bounds,
    bcenter,
    wradius,
    count: nodes.length,
    animations: (g.animations || []).length,
    parser,
  };
}

// TSV dump handed to the DSH agent: index / name / parent / kids / mesh /
// local XY extent / WORLD XY extent (scale-aware) / world radius from center.
export function dumpNodes(g, limit = 2000) {
  const lines = g.nodes.slice(0, limit).map((n) => `${n.i}\t${n.name}\tparent=${n.parent}\tkids=${n.children}\tmesh=${n.mesh}\txy=${n.ext ? `${n.ext.ex.toFixed(2)}x${n.ext.ey.toFixed(2)}` : '-'}\twxy=${n.wext ? `${n.wext.ex.toFixed(2)}x${n.wext.ey.toFixed(2)}x${n.wext.ez.toFixed(2)}` : '-'}\tr=${n.r.toFixed(1)}`);
  if (g.nodes.length > limit) lines.push(`… ${g.nodes.length - limit} more nodes omitted`);
  return lines.join('\n');
}

// Wide-and-flat nodes out at the rotor ring, in WORLD space: propeller-blade
// suspects. Used for tier-1 hard failures and human-gate warnings.
const NOT_BLADE = /arm|leg|gear|landing|body|frame|skid|mount|fuselage|tail|shell|cover|case/i;
export function bladeCandidates(g, frac = 0.25) {
  return g.nodes.filter((n) => {
    if (!n.wext || NOT_BLADE.test(n.name)) return false;
    // Rotation-invariant PLATE test: sort the three world extents ascending.
    // A flat blade has ONE thin axis (thickness a) and TWO comparably-large
    // in-plane axes (b, c) → b >= 4a. A rod/spinner/lock has TWO thin axes
    // (a ≈ b << c, e.g. 2.2x13.3x2.2) → b < 4a → correctly rejected. The old
    // max(ex,ey)-vs-ez check wrongly passed vertical rods.
    const [a, b] = [n.wext.ex, n.wext.ey, n.wext.ez].sort((p, q) => p - q);
    const plate = a > 1e-6 && b >= 4 * a;
    const e = Math.max(n.wext.ex, n.wext.ey);
    return plate && e >= frac * g.maxWExt && e < 0.95 * g.maxWExt && n.r >= 0.45 * g.radius;
  });
}

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

// ---- lazy geometry decode (carving) ------------------------------------------
// The parse table keeps only accessor min/max — enough for bboxes, not for
// cutting a pointed-at surface patch out of a fused shell. Geometry is decoded
// LAZILY: the raw container stays alive in a closure, and a mesh's
// POSITION/indices are read out of the buffer on first request and cached. A
// run that never carves pays nothing; a file whose buffer cannot be resolved
// (an external .bin) simply has no geometry — readGeometry returns null and
// carving degrades to the whole-node fallback rather than failing the parse.

const CT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

// Resolve glTF `buffers[]` entries to bytes. Two sources are supported:
//   GLB    the BIN chunk — 12B container header, JSON chunk (8B header + clen
//          bytes), then the BIN chunk's 8B header: data at 20 + clen + 8.
//   data:  a base64 data URI, the embedding a text .gltf actually uses.
// An EXTERNAL .bin is deliberately not followed (this parser has no resolved
// path context for it); the resolver yields null and geometry stays unavailable.
function bufferResolver(raw, g) {
  const cache = new Map();
  const isGlb = raw.length >= 20 && raw.readUInt32LE(0) === 0x46546c67;
  return (bi) => {
    const key = bi ?? 0;
    if (cache.has(key)) return cache.get(key);
    let out = null;
    const decl = (g.buffers || [])[key] || {};
    if (isGlb && decl.uri == null) {
      try {
        const clen = raw.readUInt32LE(12);
        const head = 20 + clen;
        if (head + 8 <= raw.length && raw.readUInt32LE(head + 4) === 0x004e4942) {
          const blen = raw.readUInt32LE(head);
          const off = head + 8;
          out = new Uint8Array(raw.buffer, raw.byteOffset + off, Math.min(blen, raw.length - off));
        }
      } catch { out = null; }
    } else if (typeof decl.uri === 'string' && decl.uri.startsWith('data:')) {
      try {
        const b = Buffer.from(decl.uri.slice(decl.uri.indexOf(',') + 1), 'base64');
        out = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      } catch { out = null; }
    }
    cache.set(key, out);
    return out;
  };
}

// One accessor -> typed array, honoring an interleaved bufferView's byteStride.
// Only the component types carving consumes are read: float attributes and
// ubyte/ushort/uint indices. Anything else (normalized, quantized, sparse)
// returns null — the caller skips that primitive rather than misreading it.
function readAccessorArray(g, binFor, ai) {
  const a = (g.accessors || [])[ai];
  if (!a || a.bufferView == null || a.sparse) return null;
  const bv = (g.bufferViews || [])[a.bufferView];
  if (!bv) return null;
  const bin = binFor(bv.buffer ?? 0);
  if (!bin) return null;
  const n = TYPE_N[a.type] || 0;
  const cs = CT_SIZE[a.componentType] || 0;
  if (!n || !cs || !a.count) return null;
  const Ctor = a.componentType === 5126 ? Float32Array
    : a.componentType === 5125 ? Uint32Array
      : a.componentType === 5123 ? Uint16Array
        : a.componentType === 5121 ? Uint8Array
          : null;
  if (!Ctor) return null;
  const read = a.componentType === 5126 ? 'getFloat32'
    : a.componentType === 5125 ? 'getUint32'
      : a.componentType === 5123 ? 'getUint16' : 'getUint8';
  const stride = bv.byteStride || n * cs;
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  // A truncated buffer must not become a crash — refuse the accessor.
  if (base + (a.count - 1) * stride + n * cs > bin.length) return null;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = new Ctor(a.count * n);
  for (let i = 0; i < a.count; i++) {
    const o = base + i * stride;
    for (let k = 0; k < n; k++) out[i * n + k] = dv[read](o + k * cs, true);
  }
  return out;
}

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

  // Triangle soup per mesh, decoded on first ask and cached. The closure keeps
  // `raw` alive — the whole container is the price of never re-reading it.
  // Primitives are MERGED into one soup (indices re-based), because carving
  // thinks in surfaces, not in draw calls; non-triangle primitives (points,
  // lines) and non-float POSITIONs are skipped.
  const binFor = bufferResolver(raw, g);
  const geomCache = new Map();
  const readGeometry = (mi) => {
    if (geomCache.has(mi)) return geomCache.get(mi);
    let out = null;
    const mesh = meshes[mi];
    if (mesh) {
      const posParts = []; const idxParts = [];
      let nv = 0; let ni = 0;
      for (const p of mesh.primitives || []) {
        if ((p.mode ?? 4) !== 4) continue;
        const pa = (p.attributes || {}).POSITION;
        if (pa == null) continue;
        const pos = readAccessorArray(g, binFor, pa);
        if (!(pos instanceof Float32Array)) continue;
        const verts = pos.length / 3;
        let tri;
        if (p.indices != null) {
          const idx = readAccessorArray(g, binFor, p.indices);
          // A half-read primitive would corrupt the soup — skip it whole.
          if (!idx) continue;
          tri = new Uint32Array(idx.length);
          for (let k = 0; k < idx.length; k++) tri[k] = idx[k] + nv;
        } else {
          tri = new Uint32Array(verts); // non-indexed -> sequential index
          for (let k = 0; k < verts; k++) tri[k] = nv + k;
        }
        posParts.push(pos); idxParts.push(tri);
        nv += verts; ni += tri.length;
      }
      if (nv) {
        const positions = new Float32Array(nv * 3);
        const index = new Uint32Array(ni);
        let vo = 0; let io = 0;
        for (const c of posParts) { positions.set(c, vo); vo += c.length; }
        for (const c of idxParts) { index.set(c, io); io += c.length; }
        out = { positions, index };
      }
    }
    geomCache.set(mi, out);
    return out;
  };

  // Local XY extent of this node's OWN mesh (blade vs hub hint). Deliberately NOT
  // the subtree's: a container's extent is inherited from its placed world box
  // below, because scaling a descendant's accessor extent by the CONTAINER's
  // scale is wrong by exactly the intermediate scales in between.
  function xyExtent(i) {
    const n = nodes[i];
    if (n.mesh == null) return null;
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

  // Local AABB of this node's OWN mesh: the UNION over primitives of the accessor
  // min/max. Kept strictly separate from `ext` above (which is the per-axis max of
  // per-primitive SPANS, the input to the phase-1 blade heuristic) so adding world
  // bboxes cannot perturb discovery results. A container's world box is the union
  // of its descendants' PLACED boxes, computed further down — transforming a
  // descendant's accessor box by the container's matrix would drop every
  // intermediate scale and translation on the way down the chain.
  //
  // Why this matters: `ext` alone cannot place a bbox. CAD-style exports bake
  // absolute vertex coordinates into the accessor and leave the node at the
  // origin, so centring a bbox on the node's world translation puts it in empty
  // space — up to tens of units away from the geometry it describes.
  function subtreeBox(i) {
    const n = nodes[i];
    if (n.mesh == null) return null;
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
    return mn ? { min: mn, max: mx } : null;
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
      mi: n.mesh != null ? n.mesh : null, // mesh INDEX — readGeometry's key
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

  // Containers inherit two DIFFERENT things from their subtree, because two
  // different consumers need two different answers:
  //
  //   wb    — the placed world AABB: the UNION of descendants' PLACED boxes.
  //           The old shortcut (transform the first descendant mesh's accessor
  //           box by the CONTAINER's matrix) silently drops every scale and
  //           translation between the two nodes: on drone_dji_air3 a ~0.046
  //           scale half-way down the chain inflated the model bounds 22x
  //           (wradius 81 over a drone 3 units across), which parked every
  //           survey camera ~200 units from the machine and handed the coverage
  //           maths boxes in empty space. This is what framing/visibility want.
  //
  //   wext  — a ROTATION-FREE shape descriptor: the per-axis MAX over
  //           descendants' own scale-aware extents. Deliberately NOT the span of
  //           the union box above: a world AABB re-axes a tilted plate, so a
  //           14.2x14.7x2.1 propeller blade comes back as 16.7x8.5x16.5 and the
  //           blade heuristic's plate test (thin axis vs two large ones) rejects
  //           the very container that names it. Mesh nodes keep ext × world
  //           scale; containers keep the largest part span inside them, which is
  //           the same question the old code accidentally answered.
  const boxOf = (min, max) => ({
    min, max,
    c: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    h: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
  });
  const unionBox = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    return boxOf(
      [0, 1, 2].map((k) => Math.min(a.min[k], b.min[k])),
      [0, 1, 2].map((k) => Math.max(a.max[k], b.max[k])),
    );
  };
  const maxSpan = (a, b) => (a && b
    ? { ex: Math.max(a.ex, b.ex), ey: Math.max(a.ey, b.ey), ez: Math.max(a.ez, b.ez) }
    : (a || b));
  const agg = new Array(info.length).fill(undefined);
  const subtreeAgg = (i, seen) => {
    if (agg[i] !== undefined) return agg[i];
    if (seen.has(i)) return null; // a cyclic graph is invalid glTF; refuse to hang on it
    seen.add(i);
    let box = info[i].wb || null;
    let span = info[i].wext || null;
    for (const c of nodes[i].children || []) {
      const s = subtreeAgg(c, seen);
      if (!s) continue;
      box = unionBox(box, s.box);
      span = maxSpan(span, s.span);
    }
    seen.delete(i);
    agg[i] = { box, span };
    return agg[i];
  };
  info.forEach((n, i) => {
    const a = subtreeAgg(i, new Set());
    if (!a) return;
    if (!n.wb && a.box) n.wb = a.box;
    if (!n.wext && a.span) n.wext = a.span;
  });

  const extOf = (x) => Math.max(x.ex, x.ey);
  // Over MESH nodes only: a container's extent is a footprint, not a part, and a
  // blade heuristic normalising against the whole model's span would reject every
  // real blade on a machine whose hull is its largest object.
  const maxExt = Math.max(1e-9, ...info.filter((x) => x.mesh && x.ext).map((x) => extOf(x.ext)));
  const maxWExt = Math.max(1e-9, ...info.filter((x) => x.mesh && x.wext).map((x) => extOf(x.wext)));
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

  // Ring metric: WHERE the actuator ring sits, for tier-1's placement checks
  // and the blade heuristic. `radius` above spreads ALL node origins in the XY
  // plane — fine for Z-up drone exports, but it breaks twice on general
  // meshes: non-mesh helper nodes inflate it (car_marussia_b1: four CoronaLight
  // studio-light nodes at y=15 tripled it, 5.9 -> 15.4), and a node-count-
  // weighted centroid is not the geometric centre (a detail-heavy side pulls
  // it, so symmetric wheels measure different r). The ring metric is geometry-
  // based instead: the placed-bbox centre, and the farthest MESH-node origin
  // measured in the GROUND PLANE — the two axes of largest bbox span, which
  // adapts to Y-up and Z-up exports alike. The legacy fields stay untouched
  // for the discovery tolerances tuned on them.
  let ringAxes = [0, 1];
  let ringCenter = [cx, cy];
  let ringRadius = radius;
  if (hasBounds) {
    const span = [bx1 - bx0, by1 - by0, bz1 - bz0];
    const order = [0, 1, 2].sort((a, b) => span[b] - span[a]);
    const meshPts = info.filter((n) => n.mesh);
    if (meshPts.length) {
      ringAxes = [order[0], order[1]];
      ringCenter = [bcenter[ringAxes[0]], bcenter[ringAxes[1]]];
      ringRadius = Math.max(1e-9, ...meshPts.map((n) => Math.hypot(
        n.wp[ringAxes[0]] - ringCenter[0], n.wp[ringAxes[1]] - ringCenter[1])));
    }
  }
  info.forEach((n) => {
    n.rr = Math.hypot(n.wp[ringAxes[0]] - ringCenter[0], n.wp[ringAxes[1]] - ringCenter[1]);
  });
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
    ringAxes,
    ringCenter,
    ringRadius,
    count: nodes.length,
    animations: (g.animations || []).length,
    parser,
    readGeometry,
    carves: [], // the carve registry — registerCarve (discovery/carve.mjs) appends
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
    // Ring distance uses the geometry-based ring metric when present: the
    // legacy XY node-origin radius is inflated by non-mesh helper nodes (studio
    // lights) and biased by node density, which would hide real blades here.
    const ringR = g.ringRadius || g.radius;
    // Body-panel guard: a blade is a NARROW plate — its second axis stays well
    // under half the ring (Inspire blades: 0.39x). A car's fender/hood plate
    // passes the flatness and size windows too, but its second axis is a large
    // fraction of the ring (the marussia front panel: 0.65x → rejected).
    return plate && e >= frac * g.maxWExt && e < 0.95 * g.maxWExt && (n.rr ?? n.r) >= 0.45 * ringR && b < 0.5 * ringR;
  });
}

// Carve — ON-SURFACE IN. When a mesh "looks right" but was never built with
// internal mechanical nodes (no hinge/wheel sub-objects — one fused shell), a
// pointed-at surface region is resolved to a TRIANGLE PATCH of the shell
// itself, cut out and registered as a virtual node. That node then flows
// through everything the pipeline already does by name: the scope battery, the
// rigidity gate, codegen — none of them can tell it from a node the exporter
// bothered to make.
//
// The cutter's contract:
//   SEED    a ray through the model's box (or through a colour-identified
//           pixel when a mask is available — the exact channel wins) finds
//           the first triangle of the subject's mesh under the point.
//   FLOOD   from that triangle, BFS over shared edges with two cut rules:
//           a RADIUS cap (the box's world footprint — the model pointed at
//           something THIS big) and a NORMAL-CONE break (do not cross a fold
//           sharper than 90° — that is where a fender lip or a strut ends
//           and the shell resumes).
//   REGISTER the patch becomes a node named `<source>#carve<N>` with the
//           source's own transform (identical world placement) and a bbox
//           measured from the patch's vertices — the placed-bbox discipline.
//
// Pure table math over decoded GLB arrays + frame poses — no THREE, matching
// discovery's purity rule. Deterministic by construction: same soup, same
// seed triangle, same params -> same patch, which is what applyCarves proves
// on reload.
import { VIEWPORT, makeCamera } from './views.mjs';

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// ---- rays --------------------------------------------------------------------

// Möller–Trumbore over the whole soup, two-sided (the clay capture is
// DoubleSide-lit, and a ray under a box has no business caring about winding);
// nearest hit wins. `index` may be null (sequential soup).
// Returns { tri, t, point } or null.
export function rayTriangles(positions, index, ro, rd) {
  let best = null;
  const ntris = Math.floor((index ? index.length : positions.length) / 3);
  for (let t = 0; t < ntris; t += 1) {
    const a = (index ? index[t * 3] : t * 3) * 3;
    const b = (index ? index[t * 3 + 1] : t * 3 + 1) * 3;
    const c = (index ? index[t * 3 + 2] : t * 3 + 2) * 3;
    const ax = positions[a]; const ay = positions[a + 1]; const az = positions[a + 2];
    const e1x = positions[b] - ax; const e1y = positions[b + 1] - ay; const e1z = positions[b + 2] - az;
    const e2x = positions[c] - ax; const e2y = positions[c + 1] - ay; const e2z = positions[c + 2] - az;
    const px = rd[1] * e2z - rd[2] * e2y; const py = rd[2] * e2x - rd[0] * e2z; const pz = rd[0] * e2y - rd[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const tx = ro[0] - ax; const ty = ro[1] - ay; const tz = ro[2] - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = ty * e1z - tz * e1y; const qy = tz * e1x - tx * e1z; const qz = tx * e1y - ty * e1x;
    const v = (rd[0] * qx + rd[1] * qy + rd[2] * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (tt <= 1e-9) continue;
    if (!best || tt < best.t) {
      best = { tri: t, t: tt, point: [ro[0] + rd[0] * tt, ro[1] + rd[1] * tt, ro[2] + rd[2] * tt] };
    }
  }
  return best;
}

// A frame pixel -> world ray. The exact inverse of project() in views.mjs, so a
// box drawn on the rendered frame lands on the geometry that frame showed.
function pixelRay(cam, px, py) {
  const nx = (px / cam.w - 0.5) * 2 * cam.tanHalfY * cam.aspect;
  const ny = (0.5 - py / cam.h) * 2 * cam.tanHalfY;
  const d = [
    cam.f[0] + nx * cam.r[0] + ny * cam.u[0],
    cam.f[1] + nx * cam.r[1] + ny * cam.u[1],
    cam.f[2] + nx * cam.r[2] + ny * cam.u[2],
  ];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return { ro: cam.eye, rd: [d[0] / l, d[1] / l, d[2] / l] };
}

const camOf = (frame) => (frame?.f && frame?.r && frame?.u ? frame
  : makeCamera(frame.pose.eye, frame.pose.target, VIEWPORT, frame.pose.up || null));

// ---- local-frame casting -------------------------------------------------------
// The soup is mesh-LOCAL (readGeometry decodes the accessor verbatim); cameras
// and boxes are WORLD, and real exports place their meshes with non-identity
// node matrices (the marussia's body sits at 0.025 scale, rotated). A world ray
// cast through the node's inverse lands on the same triangle: affine maps
// preserve collinearity and betweenness, so the nearest LOCAL hit IS the
// nearest world hit. The hit point stays in soup units, which is exactly the
// frame floodPatch measures in — and the frame a persisted spec must reproduce.

// The world<->local exchange rate for lengths: the flood radius is derived
// from the box's WORLD footprint, but the flood measures in soup units. Mean
// column norm of the upper 3x3 (near-uniform in practice; exact for the
// uniform-scale exports this exists for).
export function worldScaleOf(wm) {
  if (!wm) return 1;
  const s = (Math.hypot(wm[0], wm[1], wm[2])
    + Math.hypot(wm[4], wm[5], wm[6])
    + Math.hypot(wm[8], wm[9], wm[10])) / 3;
  return s > 1e-12 ? s : 1;
}

// Inverse of the affine part of a column-major 4x4 as a ray transform:
// p_local = A^-1 * (p_world - t). Returns null for a degenerate matrix.
// The a..i unpack reads true ROWS of the column-major upper 3x3 (matching
// patchMetrics' forward transform) — reading columns instead computes the
// TRANSPOSE of the inverse, which only coincides with it for pure scales.
function invAffine(wm) {
  const a = wm[0]; const b = wm[4]; const c = wm[8];
  const d = wm[1]; const e = wm[5]; const f = wm[9];
  const g = wm[2]; const h = wm[6]; const i = wm[10];
  const c00 = e * i - f * h; const c01 = -(d * i - f * g); const c02 = d * h - e * g;
  const c10 = -(b * i - c * h); const c11 = a * i - c * g; const c12 = -(a * h - b * g);
  const c20 = b * f - c * e; const c21 = -(a * f - c * d); const c22 = a * e - b * d;
  const det = a * c00 + d * c10 + g * c20;
  if (det > -1e-15 && det < 1e-15) return null;
  const inv = 1 / det;
  // adjugate = cofactors transposed; row-major 3x3.
  const m = [c00 * inv, c10 * inv, c20 * inv, c01 * inv, c11 * inv, c21 * inv, c02 * inv, c12 * inv, c22 * inv];
  const t = [wm[12], wm[13], wm[14]];
  return {
    point: (p) => {
      const x = p[0] - t[0]; const y = p[1] - t[1]; const z = p[2] - t[2];
      return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
    },
    vector: (v) => [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ],
  };
}

const hex6 = (c) => {
  let s = String(c ?? '').trim().toLowerCase().replace(/^#|^0x/, '');
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map((x) => x + x).join('');
  return /^[0-9a-f]{6}$/.test(s) ? s : null;
};

// The first shell triangle under the pointed region. Rays are tried in a FIXED
// order — colour-hit pixels first when a mask is available (the exact channel
// wins), then the box centre, then its corners — so the seed is reproducible
// from the recorded inputs alone. `box` is a NORMALIZED frame box {x0..y1}
// (grounding normalizes before it calls); `mask`, when present, is
// { w, h, data, channels } with RGB(A) bytes, and `colors` the ids the model
// read. Returns { tri, point } or null.
export function seedFromRegion({ positions, index }, frame, box, { colors = null, mask = null, wm = null } = {}) {
  if (!positions || !box) return null;
  let cam = null;
  try { cam = camOf(frame); } catch { return null; }
  if (!cam) return null;
  // `wm` is the subject node's world matrix: rays are cast in the soup's LOCAL
  // frame (see the note above). The seed point stays in soup units throughout.
  const inv = wm ? invAffine(wm) : null;
  if (wm && !inv) return null;

  const rays = [];
  if (mask?.data && Array.isArray(colors) && colors.length) {
    const want = new Set(colors.map(hex6).filter(Boolean));
    if (want.size) {
      const ch = mask.channels || 3;
      const px0 = Math.max(0, Math.floor(box.x0 * mask.w)); const px1 = Math.min(mask.w - 1, Math.ceil(box.x1 * mask.w));
      const py0 = Math.max(0, Math.floor(box.y0 * mask.h)); const py1 = Math.min(mask.h - 1, Math.ceil(box.y1 * mask.h));
      const hits = [];
      for (let y = py0; y <= py1 && hits.length < 64; y += 1) {
        for (let x = px0; x <= px1; x += 1) {
          const o = (y * mask.w + x) * ch;
          const h = ((mask.data[o] << 16) | (mask.data[o + 1] << 8) | mask.data[o + 2]).toString(16).padStart(6, '0');
          if (want.has(h)) hits.push([x + 0.5, y + 0.5]);
          if (hits.length >= 64) break;
        }
      }
      // Evenly spaced samples, row-major order preserved: deterministic.
      const step = Math.max(1, Math.floor(hits.length / 8));
      for (let i = 0; i < hits.length; i += step) rays.push(hits[i]);
    }
  }
  rays.push(
    [((box.x0 + box.x1) / 2) * cam.w, ((box.y0 + box.y1) / 2) * cam.h],
    [box.x0 * cam.w, box.y0 * cam.h],
    [box.x1 * cam.w, box.y0 * cam.h],
    [box.x0 * cam.w, box.y1 * cam.h],
    [box.x1 * cam.w, box.y1 * cam.h],
  );

  for (const [px, py] of rays) {
    const { ro, rd } = pixelRay(cam, px, py);
    const hit = inv
      ? rayTriangles(positions, index, inv.point(ro), inv.vector(rd))
      : rayTriangles(positions, index, ro, rd);
    if (hit) return hit;
  }
  return null;
}

// ---- flood fill ----------------------------------------------------------------

// Weld split vertices by position. CAD-baked exports frequently duplicate a
// shared edge's verts per part; without welding, shared-edge adjacency finds
// nothing and every flood degenerates to its seed triangle.
function weldVerts(positions) {
  const mn = [Infinity, Infinity, Infinity]; const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      if (positions[i + k] < mn[k]) mn[k] = positions[i + k];
      if (positions[i + k] > mx[k]) mx[k] = positions[i + k];
    }
  }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  const tol = Math.max(1e-12, diag * 1e-6);
  const map = new Map();
  const welded = new Uint32Array(positions.length / 3);
  for (let i = 0; i < positions.length; i += 3) {
    const key = `${Math.round(positions[i] / tol)},${Math.round(positions[i + 1] / tol)},${Math.round(positions[i + 2] / tol)}`;
    let w = map.get(key);
    if (w === undefined) { w = map.size; map.set(key, w); }
    welded[i / 3] = w;
  }
  return welded;
}

// BFS from the seed triangle over shared edges, with the two cut rules:
//   RADIUS  a triangle whose CENTROID lies past maxRadius from the seed point
//           is beyond what the pointed box could have denoted.
//   CONE    an edge whose two face normals fold by more than `dihedralDeg` is
//           a seam — fender lip, strut root — and is not crossed.
// Deterministic: adjacency is built in ascending triangle order, the queue is
// FIFO, and the output is sorted, so two runs return the same list.
export function floodPatch(positions, index, seedTri, {
  maxRadius = Infinity, seedPoint = null, dihedralDeg = 90, maxTris = 400000,
} = {}) {
  if (!positions) return null;
  const ntris = Math.floor((index ? index.length : positions.length) / 3);
  if (!Number.isInteger(seedTri) || seedTri < 0 || seedTri >= ntris) return null;
  const at = (k) => (index ? index[k] : k);
  const welded = weldVerts(positions);

  const edge = new Map();                    // "a_b" (welded ids, a<b) -> [tri, ...]
  const triKeys = new Array(ntris);
  for (let t = 0; t < ntris; t += 1) {
    const w = [welded[at(t * 3)], welded[at(t * 3 + 1)], welded[at(t * 3 + 2)]];
    const keys = [];
    for (const [a, b] of [[w[0], w[1]], [w[1], w[2]], [w[2], w[0]]]) {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      keys.push(k);
      const arr = edge.get(k);
      if (arr) arr.push(t); else edge.set(k, [t]);
    }
    triKeys[t] = keys;
  }

  const normals = new Float32Array(ntris * 3);
  const centroids = new Float32Array(ntris * 3);
  for (let t = 0; t < ntris; t += 1) {
    const a = at(t * 3) * 3; const b = at(t * 3 + 1) * 3; const c = at(t * 3 + 2) * 3;
    const e1x = positions[b] - positions[a]; const e1y = positions[b + 1] - positions[a + 1]; const e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a]; const e2y = positions[c + 1] - positions[a + 1]; const e2z = positions[c + 2] - positions[a + 2];
    let nx = e1y * e2z - e1z * e2y; let ny = e1z * e2x - e1x * e2z; let nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 0; nz = 0; }
    normals[t * 3] = nx; normals[t * 3 + 1] = ny; normals[t * 3 + 2] = nz;
    centroids[t * 3] = (positions[a] + positions[b] + positions[c]) / 3;
    centroids[t * 3 + 1] = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
    centroids[t * 3 + 2] = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
  }

  // The cone test with a 90° limit must ACCEPT an exact 90° fold (box corners),
  // so the comparison carries an epsilon against float noise at the boundary.
  const cosLimit = Math.cos((dihedralDeg * Math.PI) / 180) - 1e-9;
  const sp = seedPoint || [centroids[seedTri * 3], centroids[seedTri * 3 + 1], centroids[seedTri * 3 + 2]];
  const r2 = maxRadius * maxRadius;

  const seen = new Uint8Array(ntris);
  seen[seedTri] = 1;
  const queue = [seedTri];
  let head = 0;
  while (head < queue.length) {
    const t = queue[head]; head += 1;
    const ntx = normals[t * 3]; const nty = normals[t * 3 + 1]; const ntz = normals[t * 3 + 2];
    for (const k of triKeys[t]) {
      for (const m of edge.get(k) || []) {
        if (seen[m]) continue;
        const dot = ntx * normals[m * 3] + nty * normals[m * 3 + 1] + ntz * normals[m * 3 + 2];
        if (dot < cosLimit) continue;                     // seam — do not cross
        const dx = centroids[m * 3] - sp[0]; const dy = centroids[m * 3 + 1] - sp[1]; const dz = centroids[m * 3 + 2] - sp[2];
        if (dx * dx + dy * dy + dz * dz > r2) continue;   // past the box's footprint
        seen[m] = 1;
        queue.push(m);
        if (queue.length >= maxTris) break;
      }
    }
    if (queue.length >= maxTris) break;
  }
  queue.sort((a, b) => a - b);
  return { tris: queue, seedTri, seedPoint: sp.slice() };
}

// ---- measurements and registration ----------------------------------------------

// World-space measurements of a patch from its ACTUAL vertices — the placed-bbox
// discipline gltf.mjs established: never infer where a part is from its node
// origin when the vertices can say it. Returns { area, centroid, wb } in world,
// plus the LOCAL-space box the node descriptors (ext/box) are stated in.
export function patchMetrics({ positions, index }, tris, wm = IDENT) {
  const at = (k) => (index ? index[k] : k);
  let area = 0;
  const c = [0, 0, 0];
  const mn = [Infinity, Infinity, Infinity]; const mx = [-Infinity, -Infinity, -Infinity];
  const lmn = [Infinity, Infinity, Infinity]; const lmx = [-Infinity, -Infinity, -Infinity];
  const seenV = new Set();
  for (const t of tris) {
    const P = [];
    for (let j = 0; j < 3; j += 1) {
      const vi = at(t * 3 + j);
      const o = vi * 3;
      const x = positions[o]; const y = positions[o + 1]; const z = positions[o + 2];
      P.push([
        wm[0] * x + wm[4] * y + wm[8] * z + wm[12],
        wm[1] * x + wm[5] * y + wm[9] * z + wm[13],
        wm[2] * x + wm[6] * y + wm[10] * z + wm[14],
      ]);
      if (!seenV.has(vi)) {
        seenV.add(vi);
        for (let k = 0; k < 3; k += 1) {
          if (P[j][k] < mn[k]) mn[k] = P[j][k];
          if (P[j][k] > mx[k]) mx[k] = P[j][k];
          const lv = positions[o + k];
          if (lv < lmn[k]) lmn[k] = lv;
          if (lv > lmx[k]) lmx[k] = lv;
        }
      }
    }
    const ux = P[1][0] - P[0][0]; const uy = P[1][1] - P[0][1]; const uz = P[1][2] - P[0][2];
    const vx = P[2][0] - P[0][0]; const vy = P[2][1] - P[0][1]; const vz = P[2][2] - P[0][2];
    const a2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    area += a2 / 2;
    for (let k = 0; k < 3; k += 1) c[k] += ((P[0][k] + P[1][k] + P[2][k]) / 3) * (a2 / 2);
  }
  const centroid = area > 1e-12 ? c.map((v) => v / area) : [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  return {
    area,
    centroid,
    wb: {
      min: mn, max: mx,
      c: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2],
      h: [(mx[0] - mn[0]) / 2, (mx[1] - mn[1]) / 2, (mx[2] - mn[2]) / 2],
    },
    box: { min: lmn, max: lmx },
  };
}

// Register a patch as a virtual mesh node. The node takes the source's OWN
// transform (identical world placement) and measures its bbox from the patch's
// vertices; its name is `<source>#carve<N>`. Idempotent: the same cut on the
// same graph returns the existing spec instead of duplicating it.
export function registerCarve(g, sourceName, patch, params, { id = null } = {}) {
  if (!g?.nodes || !patch?.tris?.length) throw new Error('registerCarve: empty patch or graph');
  const src = g.nodes.find((n) => n.name === sourceName && n.mesh && (patch.mi == null || n.mi === patch.mi))
    || g.nodes.find((n) => n.name === sourceName && n.mesh);
  if (!src) throw new Error(`registerCarve: no mesh node named "${sourceName}"`);
  const carves = g.carves || (g.carves = []);
  const dup = carves.find((c) => c.source === sourceName
    && c.seed?.tri === patch.seedTri && c.params?.maxRadius === params?.maxRadius);
  if (dup) return dup;
  const geom = g.readGeometry ? g.readGeometry(src.mi) : null;
  if (!geom) throw new Error(`registerCarve: geometry unavailable for mesh ${src.mi}`);

  const { area, centroid, wb, box } = patchMetrics(geom, patch.tris, src.wm || IDENT);
  const ws = src.ws || [1, 1, 1];
  const ext = { ex: box.max[0] - box.min[0], ey: box.max[1] - box.min[1], ez: box.max[2] - box.min[2] };
  const wext = { ex: ext.ex * ws[0], ey: ext.ey * ws[1], ez: ext.ez * ws[2] };
  const cid = id || `${sourceName}#carve${carves.filter((c) => c.source === sourceName).length + 1}`;
  const spec = {
    id: cid,
    source: sourceName,
    sourceI: src.i,
    mi: src.mi,
    tris: patch.tris,
    triCount: patch.tris.length,
    seed: { tri: patch.seedTri, point: patch.seedPoint },
    params: { ...params },
    centroid,
    wb,
    wext,
    area,
  };
  const node = {
    i: g.nodes.length,
    name: cid,
    parent: src.parent,
    children: 0,
    t: src.t ? src.t.slice() : null,
    q: src.q ? src.q.slice() : null,
    s: src.s ? src.s.slice() : null,
    lm: src.lm ? src.lm.slice() : null,
    mesh: true,
    mi: src.mi, // geometry = the patch within that mesh; g.carves holds the tris
    ext,
    box,
    wm: src.wm,
    ws,
    wp: centroid.slice(), // where the part IS, not where the source's origin is
    wext,
    wb,
    r: src.r ?? 0,
    rr: Array.isArray(g.ringAxes)
      ? Math.hypot(
        centroid[g.ringAxes[0]] - (g.ringCenter?.[0] ?? 0),
        centroid[g.ringAxes[1]] - (g.ringCenter?.[1] ?? 0))
      : (src.rr ?? 0),
    carve: cid,
  };
  g.nodes.push(node);
  if (g.names instanceof Set) g.names.add(cid);
  carves.push(spec);
  g.count = g.nodes.length;
  return spec;
}

// Re-derive carves on reload: same source + seed triangle + params must flood
// to the same patch — that is the determinism contract the manifest relies on.
// Each spec is validated by tri count; a mismatch means the model file changed
// (or the cut was never deterministic) and is reported, not silently accepted.
export function applyCarves(g, specs) {
  const out = [];
  for (const s of specs || []) {
    try {
      const src = g.nodes.find((n) => n.name === s.source && n.mesh && (s.mi == null || n.mi === s.mi))
        || g.nodes.find((n) => n.name === s.source && n.mesh);
      if (!src) { out.push({ id: s.id, ok: false, why: `source "${s.source}" not found` }); continue; }
      const geom = g.readGeometry ? g.readGeometry(src.mi) : null;
      if (!geom) { out.push({ id: s.id, ok: false, why: 'source geometry unavailable' }); continue; }
      const patch = floodPatch(geom.positions, geom.index, s.seed?.tri, {
        ...(s.params || {}), seedPoint: s.seed?.point,
      });
      if (!patch) { out.push({ id: s.id, ok: false, why: 'the recorded seed no longer floods' }); continue; }
      patch.mi = src.mi;
      const want = s.triCount ?? (Array.isArray(s.tris) ? s.tris.length : null);
      if (want != null && patch.tris.length !== want) {
        out.push({
          id: s.id, ok: false,
          why: `re-derived ${patch.tris.length} triangles, the spec recorded ${want} — the model file changed or the cut is not deterministic`,
        });
        continue;
      }
      const spec = registerCarve(g, s.source, patch, s.params || {}, { id: s.id });
      out.push({ id: s.id, ok: spec.id === s.id, spec });
    } catch (e) {
      out.push({ id: s?.id ?? null, ok: false, why: e.message });
    }
  }
  return out;
}

// The evidence-level form persisted into a manifest record: everything needed
// to RE-DERIVE the patch (source, seed triangle, params) plus its measured
// facts, but not the triangle list itself — that is what applyCarves rebuilds.
export function carveEvidence(spec) {
  if (!spec) return null;
  const { tris, ...rest } = spec;
  return rest;
}

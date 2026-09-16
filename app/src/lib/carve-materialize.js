// carve-materialize — on-surface OUT for the viewer. The discovery side cuts a
// pointed surface patch out of a fused shell and registers it as a virtual node
// (src/plugins/discovery/carve.mjs); this module is the scene-side half of that
// contract. Given the shipped carve specs (triangle indices into the source
// mesh's MERGED primitive soup, see readGeometry in src/lib/gltf.mjs) it removes
// the patch triangles from the source geometry and re-adds them as a subtree
// NAMED the carve id — so highlight, view modes, the joint preview and any
// generated controller keep addressing the part by name, unchanged.
//
// THREE is passed in (the buildScene convention): the app bundles its own three
// and the headless proof imports the repo's — the two must never mix instances.

// The soup recipe merges a node's OWN mesh primitives in order. GLTFLoader maps
// that shape exactly: a single-primitive node IS the Mesh; a multi-primitive
// node is a Group whose DIRECT Mesh children are the primitives in order.
// Anything deeper is a glTF child node, not part of the soup.
export function soupMeshesOf(srcObj) {
  return [srcObj, ...(srcObj.children || [])].filter((o) => o && o.isMesh);
}

const triCountOf = (geo) => (geo.index ? geo.index.count : geo.attributes.position.count) / 3;

// An indexed BufferGeometry over `localTris` (triangle indices into geo0),
// copying EVERY attribute through a compact vertex remap. Normals are
// recomputed when the source had none (the glTF flat-shading fallback).
function subsetGeometry(geo0, localTris, THREE) {
  const idx0 = geo0.index ? geo0.index.array : null;
  const at = (k) => (idx0 ? idx0[k] : k);
  const remap = new Map();
  const order = [];
  const index = [];
  for (const t of localTris) {
    for (let c = 0; c < 3; c += 1) {
      const v = at(t * 3 + c);
      let nv = remap.get(v);
      if (nv === undefined) { nv = order.length; remap.set(v, nv); order.push(v); }
      index.push(nv);
    }
  }
  const geo = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo0.attributes)) {
    const item = attr.itemSize;
    const arr = new Float32Array(order.length * item);
    for (let i = 0; i < order.length; i += 1) {
      const src = order[i] * item;
      for (let k = 0; k < item; k += 1) arr[i * item + k] = attr.array[src + k];
    }
    geo.setAttribute(name, new THREE.BufferAttribute(arr, item));
  }
  geo.setIndex(index);
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  return geo;
}

// Materialize every spec under `root` (the loaded model's scene subtree).
// spec: { id, source, tris, centroid } — centroid in parseGlb WORLD space.
// opts.toScene(p) maps a world point to the viewer's scene space (the model is
// recentred there); defaults to identity. Returns what was materialized:
// [{ id, group, parts: [{ mesh, from }] }]. Ids already present in the scene
// are skipped, so re-syncs are idempotent.
export function materializeCarves(root, specs, THREE, { toScene = null } = {}) {
  const scenePoint = toScene || ((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const made = [];
  const bySource = new Map();
  for (const s of specs || []) {
    if (!s || !s.id || !s.source || !Array.isArray(s.tris) || !s.tris.length) continue;
    if (root.getObjectByName(s.id)) continue; // already materialized
    if (!bySource.has(s.source)) bySource.set(s.source, []);
    bySource.get(s.source).push(s);
  }
  if (!bySource.size) return made;
  root.updateMatrixWorld(true);

  for (const [source, sps] of bySource) {
    const srcObj = root.getObjectByName(source);
    if (!srcObj) continue;
    const meshes = soupMeshesOf(srcObj);
    if (!meshes.length) continue;

    // The pristine geometries are the specs' coordinate frame: spec.tris index
    // the soup the primitives formed BEFORE any cut. Capture once, then always
    // derive from it — a later carve on the same source must neither resurrect
    // an earlier cut nor renumber the soup.
    let off = 0;
    const prims = meshes.map((m) => {
      if (!m.userData.carvePristine) m.userData.carvePristine = m.geometry;
      const geo0 = m.userData.carvePristine;
      if (!m.userData.carveCut) m.userData.carveCut = new Set();
      const p = { mesh: m, geo0, off, tris: triCountOf(geo0), cut: m.userData.carveCut };
      off += p.tris;
      return p;
    });

    // Per spec: its soup tris grouped into per-primitive LOCAL triangle lists.
    const parent = srcObj.parent || root;
    for (const spec of sps) {
      const parts = [];
      for (const p of prims) {
        const local = [];
        for (const t of spec.tris) if (t >= p.off && t < p.off + p.tris) local.push(t - p.off);
        if (local.length) parts.push({ ...p, local });
      }
      if (!parts.length) continue;

      // The recentring pivot: the patch centroid in the SOURCE's local frame.
      // The carve group gets the source's frame with its origin moved there —
      // the geometry's world placement is unchanged, only the pivot moves.
      const cLocal = srcObj.worldToLocal(scenePoint(spec.centroid));
      const group = new THREE.Group();
      group.name = spec.id;
      const madeParts = [];
      for (const [pi, p] of parts.entries()) {
        const geo = subsetGeometry(p.geo0, p.local, THREE);
        geo.translate(-cLocal.x, -cLocal.y, -cLocal.z);
        const mesh = new THREE.Mesh(geo, p.mesh.material);
        mesh.name = `${spec.id}#p${pi}`;
        group.add(mesh);
        madeParts.push({ mesh, from: p.mesh });
        for (const t of p.local) p.cut.add(t + p.off);
      }
      group.position.copy(parent.worldToLocal(srcObj.localToWorld(cLocal.clone())));
      group.quaternion.copy(srcObj.quaternion);
      group.scale.copy(srcObj.scale);
      parent.add(group);
      made.push({ id: spec.id, group, parts: madeParts });
    }

    // Rebuild each touched source geometry WITHOUT the union of everything cut
    // so far. A fresh BufferGeometry every time; the pristine stays immutable.
    // `carveApplied` skips the rebuild when the cut set has not grown — a
    // re-shipped spec must neither resurrect nor renumber an earlier cut.
    for (const p of prims) {
      if (!p.cut.size || p.cut.size === (p.mesh.userData.carveApplied || 0)) continue;
      const keep = [];
      for (let t = 0; t < p.tris; t += 1) if (!p.cut.has(t + p.off)) keep.push(t);
      const next = subsetGeometry(p.geo0, keep, THREE);
      if (p.mesh.geometry !== p.geo0) p.mesh.geometry.dispose();
      p.mesh.geometry = next;
      p.mesh.userData.carveApplied = p.cut.size;
    }
  }
  return made;
}

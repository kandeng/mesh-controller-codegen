// Discovery plugin: geometry-heuristic joint discovery for static GLBs with no
// embedded animations (the common case, e.g. the Inspire 3 Sketchfab export).
// Recommends MAXIMAL rigidly-coupled units: each rotor = blades + hub/spinner/
// lock mates at that corner; the gimbal = gimbal joints + hard-linked camera as
// ONE integrated unit. The human then narrows via chat / pin / rectangle.
import { definePlugin, CATEGORY } from '../../core/registry.mjs';
import { EVT } from '../../core/events.mjs';
import { parseGlb, dumpNodes, bladeCandidates } from '../../lib/gltf.mjs';
import { createJoint, JOINT_TYPE } from '../../ir/motion-spec.mjs';

const isDup = (n) => /^Object_\d+$/.test(n.name); // mesh child of a named node
const GIMBAL_RE = /gimbal|camera|payload|mount|DL_|zenmuse|sensor|lens/i;
const AXNAME = ['x', 'y', 'z'];

// Placed-box centre for scope measurements: baked-vertex exports keep dozens
// of nodes at one shared origin while their geometry sits metres away, so any
// instrument reading n.wp is blind on that mesh class.
const placedPt = (n) => (n?.wb
  ? [0, 1, 2].map((k) => (n.wb.min[k] + n.wb.max[k]) / 2)
  : n.wp);

// ---- general machines: ground-hugging spinners (wheels, road wheels) --------
// The two heuristics below are drone-shaped: the rotor path starts from blade
// plates, the gimbal path reads a name vocabulary a Sketchfab car export
// ("boot.007", "Cylinder.001") does not contain. What a ground machine's
// moving parts DO carry, in any export, is shape and repetition:
//
//   disc symmetry   a wheel has two equal world axes and one different — thin
//                   when the part is a single disc, WIDE when the export fused
//                   a whole axle into one body (tire+rim+hub children spanning
//                   both wheels, as the Porsche 911 export does). The odd axis
//                   is the spin axis in both cases.
//   duplicate family  such a part is never alone: wheels come in axles, road
//                   wheels in rows. Same name stem, same size profile,
//                   different positions.
//   near ground     the spin axis is HORIZONTAL and the part sits in the bottom
//                   half of the machine's height — which is also what keeps a
//                   drone's motors (axis vertical) and rotors (top half, and
//                   already claimed by the blade path) out of this lane.
//
// The up axis is INFERRED (smallest overall world extent) rather than assumed
// Z-up like the rotor path: the car export is Y-up, the drone Z-up.
// Emitted as ROTOR joints — continuous spin about an axis is exactly a wheel's
// degree of freedom, and the preview/validation/emitter stack for rotors is
// axis-generic. Exported for the test probes.

function overallWorldBox(g) {
  let mn = null;
  let mx = null;
  for (const n of g.nodes) {
    if (!n.wb) continue;
    if (!mn) { mn = n.wb.min.slice(0, 3); mx = n.wb.max.slice(0, 3); continue; }
    for (let k = 0; k < 3; k += 1) {
      if (n.wb.min[k] < mn[k]) mn[k] = n.wb.min[k];
      if (n.wb.max[k] > mx[k]) mx[k] = n.wb.max[k];
    }
  }
  return mn ? { min: mn, max: mx } : null;
}

// Per-axis world sizes from the PLACED world box. `wext` cannot be used: its
// ex/ey/ez are sorted descending, so they say nothing about WHICH axis is the
// thin/odd one — and the axle direction is the whole answer here.
export function worldSizes(n) {
  return n.wb ? [0, 1, 2].map((k) => n.wb.max[k] - n.wb.min[k]) : null;
}

// The spin axis of a rotationally-symmetric body, from its world box alone.
// Sorted sizes a<=b<=c: a disc is (thin, d, d) → the thin axis; a fused axle
// is (d, d, wide) → the wide axis. Both readings: two comparable axes and one
// clearly different. Returns { axis, kind } or null.
export function spinAxleAxis(sizes) {
  if (!sizes) return null;
  const order = [0, 1, 2].sort((p, q) => sizes[p] - sizes[q]);
  const a = sizes[order[0]]; const b = sizes[order[1]]; const c = sizes[order[2]];
  if (!(a > 1e-6)) return null;
  const comparable = (x, y) => y <= 1.25 * x; // within 25%
  if (comparable(a, b) && c >= 1.4 * b) return { axis: order[2], kind: 'wide' };
  if (comparable(b, c) && b >= 1.4 * a) return { axis: order[0], kind: 'thin' };
  return null;
}

export function nameStem(name) {
  return String(name || '').replace(/[._-]?\d+$/, '').toLowerCase();
}

// Ready-to-emit wheel units: one per axle group (or per side when the export
// kept left/right wheels as separate disc bodies). `claimed` is the set of node
// names the rotor/gimbal paths already own — this lane never steals from them.
export function wheelUnits(g, claimed = new Set()) {
  const ob = overallWorldBox(g);
  if (!ob) return [];
  const ext = [0, 1, 2].map((k) => ob.max[k] - ob.min[k]);
  const maxDim = Math.max(...ext);
  if (!(maxDim > 0)) return [];
  let up = 0;
  for (let k = 1; k < 3; k += 1) if (ext[k] < ext[up]) up = k;
  const horiz = [0, 1, 2].filter((k) => k !== up);
  const lenAxis = ext[horiz[0]] >= ext[horiz[1]] ? horiz[0] : horiz[1];
  const latAxis = horiz[0] === lenAxis ? horiz[1] : horiz[0];
  const center = [0, 1, 2].map((k) => (ob.min[k] + ob.max[k]) / 2);
  const byI = new Map(g.nodes.map((n) => [n.i, n]));
  const ancestorOf = (n, rootI) => {
    let cur = n.parent >= 0 ? byI.get(n.parent) : null;
    while (cur) { if (cur.i === rootI) return true; cur = cur.parent >= 0 ? byI.get(cur.parent) : null; }
    return false;
  };
  const subtreeNames = (rootI) => {
    const out = [];
    for (const n of g.nodes) {
      if (n.i === rootI || ancestorOf(n, rootI)) out.push(n.name);
    }
    return out;
  };
  const depthOf = (n) => { let d = 0; let cur = n; while (cur && cur.parent >= 0) { cur = byI.get(cur.parent); d += 1; } return d; };

  // 1. disc-symmetric, ground-hugging, horizontal-axle candidates
  const cands = [];
  for (const n of g.nodes) {
    if (!n.wb || !n.name) continue;
    const sizes = worldSizes(n);
    const spin = spinAxleAxis(sizes);
    if (!spin || spin.axis === up) continue;
    const diam = Math.max(...[0, 1, 2].filter((k) => k !== spin.axis).map((k) => sizes[k]));
    if (diam < 0.1 * maxDim || diam > 0.7 * maxDim) continue;
    const rel = ext[up] > 0 ? (n.wb.c[up] - ob.min[up]) / ext[up] : 1;
    if (rel > 0.5) continue;
    const sub = subtreeNames(n.i);
    if (sub.some((nm) => claimed.has(nm))) continue;
    cands.push({ n, sizes, axle: spin.axis, kind: spin.kind, diam, sub, depth: depthOf(n) });
  }
  // 2. highest node wins over its own descendants (an axle container vs its
  //    tire/rim/hub children — one wheel must not become two candidates)
  cands.sort((p, q) => p.depth - q.depth);
  const roots = [];
  for (const c of cands) { if (!roots.some((r) => ancestorOf(c.n, r.n.i))) roots.push(c); }
  if (roots.length < 2) return [];
  // 3. duplicate families: same name stem, similar sorted size profile,
  //    physically distinct positions (a re-read of one wheel is not a family)
  const similar = (a, b) => a.every((v, k) => {
    const hi = Math.max(v, b[k]); const lo = Math.min(v, b[k]);
    return lo > 1e-9 && hi <= 1.3 * lo;
  });
  const fams = [];
  for (const c of roots) {
    const stem = nameStem(c.n.name);
    const profile = [...c.sizes].sort((p, q) => p - q);
    const fam = fams.find((f) => f.stem === stem && similar(f.profile, profile)
      && f.items.every((m) => Math.hypot(m.n.wb.c[0] - c.n.wb.c[0], m.n.wb.c[1] - c.n.wb.c[1], m.n.wb.c[2] - c.n.wb.c[2]) >= 0.5 * Math.min(m.diam, c.diam)));
    if (fam) fam.items.push(c); else fams.push({ stem, profile, items: [c] });
  }
  // 4. cluster each family along the long axis: one cluster = one axle end
  const units = [];
  for (const f of fams) {
    if (f.items.length < 2) continue;
    const clusters = [];
    for (const m of f.items) {
      const pos = m.n.wb.c[lenAxis];
      let cl = clusters.find((c) => Math.abs(c.items[0].n.wb.c[lenAxis] - pos) <= 0.5 * Math.min(c.items[0].diam, m.diam));
      if (!cl) { cl = { items: [] }; clusters.push(cl); }
      cl.items.push(m);
    }
    for (const cl of clusters) {
      // Separate left/right bodies at one axle end become separate joints (they
      // are NOT rigidly coupled); a fused axle body stays one joint.
      const lateralSplit = cl.items.length >= 2
        && Math.max(...cl.items.map((m) => m.n.wb.c[latAxis])) - Math.min(...cl.items.map((m) => m.n.wb.c[latAxis])) >= 0.6 * Math.min(...cl.items.map((m) => m.diam));
      const emitFor = (items, tag, label) => {
        const anchor = [0, 1, 2].map((k) => items.reduce((s, m) => s + m.n.wb.c[k], 0) / items.length);
        const axis = [0, 0, 0];
        axis[items[0].axle] = 1;
        units.push({
          tag, label, anchor, axis, axle: items[0].axle,
          nodes: [...new Set(items.flatMap((m) => m.sub))],
          memberNames: items.map((m) => m.n.name),
          stem: f.stem, up, lenAxis, latAxis, kind: items[0].kind,
        });
      };
      const off = cl.items.reduce((s, m) => s + m.n.wb.c[lenAxis], 0) / cl.items.length - center[lenAxis];
      const end = off > 0.05 * ext[lenAxis] ? 'front' : off < -0.05 * ext[lenAxis] ? 'rear' : 'mid';
      if (lateralSplit) {
        for (const m of cl.items) {
          const side = m.n.wb.c[latAxis] >= center[latAxis] ? 'r' : 'l';
          const fb = end === 'front' ? 'f' : end === 'rear' ? 'r' : 'm';
          emitFor([m], `${fb}${side}`, `${fb === 'f' ? 'Front' : fb === 'r' ? 'Rear' : 'Mid'} ${side === 'r' ? 'right' : 'left'} wheel`);
        }
      } else {
        emitFor(cl.items, end, `${end === 'mid' ? 'Wheel cluster' : `${end[0].toUpperCase()}${end.slice(1)} wheels`}${cl.items.length > 1 ? '' : ' (fused axle)'}`);
      }
    }
  }
  return units;
}

// Cluster blade candidates by corner; collect co-located mates (hub/spinner/locks).
// Distances read PLACED-BOX CENTRES, never origins: baked-vertex exports keep
// dozens of nodes at one shared origin (a whole cabin) while their geometry
// sits metres away. Box-GAP distance was considered and rejected: a model-
// spanning hull box touches everything, so the gap collapses to ~0 and every
// rotor swallows the hull.
//
// Both tolerances are BLADE-LOCAL, never machine-scaled: the legacy ring-
// radius versions (0.7x / 0.45x ringR) read the whole vehicle as one rotor's
// neighbourhood — on the marussia they put the front tires inside a
// headlight-lens "rotor" (tires at 163 plate thicknesses from the lens).
// The constants are measured on the two reference meshes:
//   cluster 1.6x plate DIAMETER — an Inspire corner's two blade plates sit
//     1.42x apart, the next corner's plates 1.80x; 1.6 splits the gap. The
//     marussia's three headlight lenses sit 0.04x apart and stay one cluster.
//   mates   7x plate THICKNESS — every hub/spinner/lock node of the Inspire's
//     accepted rotor scopes sits within 6.1 thicknesses of a blade plate; the
//     marussia's headlight assembly sits within 5.6x, while its tires (163x),
//     logo and fender trim (~100x) fall far outside any sane constant.
function rotorClusters(g) {
  const clusters = [];
  for (const b of bladeCandidates(g)) {
    if (isDup(b)) continue;
    const bp = placedPt(b);
    const bladeDiam = Math.max(b.wext.ex, b.wext.ey);
    const plateThick = Math.min(b.wext.ex, b.wext.ey, b.wext.ez);
    let c = clusters.find((x) => Math.hypot(x.wp[0] - bp[0], x.wp[1] - bp[1], x.wp[2] - bp[2]) < 1.6 * bladeDiam);
    if (!c) { c = { wp: [...bp], n: 1, blades: [], mates: [] }; clusters.push(c); } else {
      for (let k = 0; k < 3; k++) c.wp[k] = (c.wp[k] * c.n + bp[k]) / (c.n + 1);
      c.n++;
    }
    c.blades.push(b.name);
    for (const n of g.nodes) {
      if (!n.wext || isDup(n)) continue;
      const np = placedPt(n);
      if (Math.hypot(np[0] - bp[0], np[1] - bp[1], np[2] - bp[2]) < 7 * plateThick) c.mates.push(n.name);
    }
  }
  return clusters.map((c) => ({ ...c, blades: [...new Set(c.blades)], mates: [...new Set(c.mates)].slice(0, 30) }));
}

// Quadrant label in the model's ground plane (ring axes), about the ring
// centre — the hardcoded XY-centroid version read a Y-up car's VERTICAL axis
// as front/back. FB = first ring axis, LR = second; diagonal pairing (FL+BR
// vs FR+BL) is invariant under axis swap or sign flip, so the counter-
// rotation assignment below is unaffected by the relabelling.
function quadrantLabel(wp, g) {
  const ax = g.ringAxes || [0, 1];
  const c = g.ringCenter || g.center;
  const fb = wp[ax[0]] - c[0] >= 0 ? 'F' : 'B';
  const lr = wp[ax[1]] - c[1] >= 0 ? 'R' : 'L';
  return `${fb}${lr}`; // FL, FR, BL, BR
}

function gimbalNodes(g) {
  const ringR = g.ringRadius || g.radius;
  return g.nodes.filter((n) => !isDup(n) && GIMBAL_RE.test(n.name) && (n.rr ?? n.r) < 0.6 * ringR);
}

// Name-regex over-collection guard: the gimbal device is a COMPACT cluster,
// but the regex also matches static parts elsewhere on the craft (e.g. the
// Inspire's belly plate "gimbal_319" — a 51-node subtree 8x farther from the
// device than every lens node; swinging it about the anchor was the preview
// tear-off bug). Elbow cut on centroid distance: sort by distance, cut at the
// first >=3x gap, keep the compact core; trimmed names land in meta.trimmed.
function trimToCluster(gn, radius) {
  if (gn.length < 3) return { kept: gn, trimmed: [] };
  const c = gn.reduce((a, n) => { const p = placedPt(n); return [a[0] + p[0], a[1] + p[1], a[2] + p[2]]; }, [0, 0, 0]).map((v) => v / gn.length);
  const eps = 0.05 * radius;
  const byDist = gn
    .map((n) => { const p = placedPt(n); return { n, d: Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) }; })
    .sort((a, b) => a.d - b.d);
  let cut = byDist.length;
  for (let i = 0; i + 1 < byDist.length; i++) {
    if (byDist[i + 1].d > 3 * Math.max(byDist[i].d, eps)) { cut = i + 1; break; }
  }
  return { kept: byDist.slice(0, cut).map((x) => x.n), trimmed: byDist.slice(cut).map((x) => x.n.name) };
}

export const geometryDiscovery = definePlugin({
  category: CATEGORY.DISCOVERY,
  name: 'geometry',
  version: '1.0.0',
  contributes: { description: 'Geometry-heuristic joint discovery for static GLBs (no embedded animations).' },
  api: {
    async discover(glbPath, host) {
      const g = await parseGlb(glbPath);
      const joints = [];

      for (const [i, c] of rotorClusters(g).entries()) {
        const label = quadrantLabel(c.wp, g);
        const nodes = [...new Set([...c.blades, ...c.mates])];
        const j = createJoint({
          id: `rotor_${label.toLowerCase()}_${i}`,
          label: `${label} rotor`,
          type: JOINT_TYPE.ROTOR,
          nodes,
          anchor: { x: c.wp[0], y: c.wp[1], z: c.wp[2] },
          axis: { x: 0, y: 0, z: 1 }, // model is Z-up: rotors spin about the vertical Z axis
          // Hypothesis re-typing (phase 1): producers only attach evidence +
          // confidence; the loop owns `status` transitions.
          over: {
            meta: { blades: c.blades, mates: c.mates },
            evidence: ['blade-shape', 'disc-cluster', 'co-location'],
            confidence: 0.9,
          },
        });
        j.params.direction = (label === 'FL' || label === 'BR') ? 1 : -1; // diagonal pairs counter-rotate
        joints.push(j);
        host?.bus.emit(EVT.JOINT_DISCOVERED, { id: j.id, jointType: j.type, nodes: nodes.length });
      }

      const gn0 = gimbalNodes(g);
      if (gn0.length) {
        const { kept: gn, trimmed } = trimToCluster(gn0, g.ringRadius || g.radius);
        const c = gn.reduce((a, n) => [a[0] + n.wp[0], a[1] + n.wp[1], a[2] + n.wp[2]], [0, 0, 0]).map((v) => v / gn.length);
        const j = createJoint({
          id: 'gimbal_main',
          label: 'Gimbal + camera (integrated)',
          type: JOINT_TYPE.GIMBAL,
          nodes: gn.map((n) => n.name),
          anchor: { x: c[0], y: c[1], z: c[2] },
          axis: { x: 1, y: 0, z: 0 },
          // Name-regex is the weakest signal → lowest confidence; the gimbal is
          // the joint most likely to need a human verdict.
          over: {
            meta: { cameraHardLinked: true, ...(trimmed.length ? { trimmed } : {}) },
            evidence: trimmed.length ? ['name-regex', 'cluster-trim'] : ['name-regex'],
            confidence: 0.6,
          },
        });
        joints.push(j);
        host?.bus.emit(EVT.JOINT_DISCOVERED, { id: j.id, jointType: j.type, nodes: gn.length });
      }

      // Wheels / ground spinners: shape + repetition, never names from a
      // vocabulary. Runs LAST so the claimed set is complete and this lane can
      // only propose parts the drone heuristics left alone.
      const claimedNames = new Set(joints.flatMap((j) => j.nodes));
      for (const [k, w] of wheelUnits(g, claimedNames).entries()) {
        const j = createJoint({
          id: `wheel_${w.tag}_${k}`,
          label: w.label,
          type: JOINT_TYPE.ROTOR,
          nodes: w.nodes,
          anchor: { x: w.anchor[0], y: w.anchor[1], z: w.anchor[2] },
          axis: { x: w.axis[0], y: w.axis[1], z: w.axis[2] },
          over: {
            meta: {
              family: w.stem,
              members: w.memberNames,
              upAxis: AXNAME[w.up],
              axleAxis: AXNAME[w.axle],
              discKind: w.kind,
              labelGuess: 'front/rear inferred from the long horizontal axis — may swap on a symmetric machine',
            },
            evidence: ['disc-symmetry', 'duplicate-family', 'near-ground'],
            confidence: 0.55,
          },
        });
        joints.push(j);
        host?.bus.emit(EVT.JOINT_DISCOVERED, { id: j.id, jointType: j.type, nodes: w.nodes.length });
      }

      return { stats: g, dump: dumpNodes(g), joints };
    },
  },
});

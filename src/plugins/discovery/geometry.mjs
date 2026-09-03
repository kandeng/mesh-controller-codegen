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

// Cluster blade candidates by corner; collect co-located mates (hub/spinner/locks).
function rotorClusters(g) {
  const clusters = [];
  for (const b of bladeCandidates(g)) {
    if (isDup(b)) continue;
    let c = clusters.find((x) => Math.hypot(x.wp[0] - b.wp[0], x.wp[1] - b.wp[1], x.wp[2] - b.wp[2]) < 0.7 * g.radius);
    if (!c) { c = { wp: [...b.wp], n: 1, blades: [], mates: [] }; clusters.push(c); } else {
      for (let k = 0; k < 3; k++) c.wp[k] = (c.wp[k] * c.n + b.wp[k]) / (c.n + 1);
      c.n++;
    }
    c.blades.push(b.name);
    for (const n of g.nodes) {
      if (!n.wext || isDup(n)) continue;
      if (Math.hypot(n.wp[0] - b.wp[0], n.wp[1] - b.wp[1], n.wp[2] - b.wp[2]) < 0.45 * g.radius) c.mates.push(n.name);
    }
  }
  return clusters.map((c) => ({ ...c, blades: [...new Set(c.blades)], mates: [...new Set(c.mates)].slice(0, 30) }));
}

// Quadrant label from the world XY centroid (model is Z-up: XY is horizontal).
function quadrantLabel(wp, center) {
  const lr = wp[0] - center[0] >= 0 ? 'R' : 'L';
  const fb = wp[1] - center[1] >= 0 ? 'F' : 'B';
  return `${fb}${lr}`; // FL, FR, BL, BR
}

function gimbalNodes(g) {
  return g.nodes.filter((n) => !isDup(n) && GIMBAL_RE.test(n.name) && n.r < 0.6 * g.radius);
}

export const geometryDiscovery = definePlugin({
  category: CATEGORY.DISCOVERY,
  name: 'geometry',
  version: '1.0.0',
  contributes: { description: 'Geometry-heuristic joint discovery for static GLBs (no embedded animations).' },
  api: {
    discover(glbPath, host) {
      const g = parseGlb(glbPath);
      const joints = [];

      for (const [i, c] of rotorClusters(g).entries()) {
        const label = quadrantLabel(c.wp, g.center);
        const nodes = [...new Set([...c.blades, ...c.mates])];
        const j = createJoint({
          id: `rotor_${label.toLowerCase()}_${i}`,
          label: `${label} rotor`,
          type: JOINT_TYPE.ROTOR,
          nodes,
          anchor: { x: c.wp[0], y: c.wp[1], z: c.wp[2] },
          axis: { x: 0, y: 1, z: 0 }, // controller spins about local Y (rotation.y)
          over: { meta: { blades: c.blades, mates: c.mates } },
        });
        j.params.direction = (label === 'FL' || label === 'BR') ? 1 : -1; // diagonal pairs counter-rotate
        joints.push(j);
        host?.bus.emit(EVT.JOINT_DISCOVERED, { id: j.id, jointType: j.type, nodes: nodes.length });
      }

      const gn = gimbalNodes(g);
      if (gn.length) {
        const c = gn.reduce((a, n) => [a[0] + n.wp[0], a[1] + n.wp[1], a[2] + n.wp[2]], [0, 0, 0]).map((v) => v / gn.length);
        const j = createJoint({
          id: 'gimbal_main',
          label: 'Gimbal + camera (integrated)',
          type: JOINT_TYPE.GIMBAL,
          nodes: gn.map((n) => n.name),
          anchor: { x: c[0], y: c[1], z: c[2] },
          axis: { x: 1, y: 0, z: 0 },
          over: { meta: { cameraHardLinked: true } },
        });
        joints.push(j);
        host?.bus.emit(EVT.JOINT_DISCOVERED, { id: j.id, jointType: j.type, nodes: gn.length });
      }

      return { stats: g, dump: dumpNodes(g), joints };
    },
  },
});

// Joint routes — list discovered joints, publish the renderer-registry contract
// (the render ids the frontend must implement), and serve the deterministic RIG
// REPORT the debugging assistant relies on (GET /api/joints/:id/rig). The
// per-joint slot graph lives in project.mjs (/api/joints/:id/slots); this module
// is the read-only catalog + rig inspector.
import { KNOWN_RENDERS } from '../slots.mjs';
import { jointSummary } from './project.mjs';
import { parseGlb } from '../../src/lib/gltf.mjs';

// Memoized per GLB path: the rig report re-reads the full node table, and the
// 23MB sample should not be re-parsed on every assistant call.
let glbCache = { path: null, g: null };
async function parsed(glbPath) {
  if (!glbPath) return null;
  if (glbCache.path !== glbPath) glbCache = { path: glbPath, g: await parseGlb(glbPath) };
  return glbCache.g;
}

// Geometric rotor-disc completion — the productized version of the fix for the
// blade tear-off bug. Model space is Z-up (XY horizontal, Z vertical), matching
// parseGlb's world positions and the joint anchor.
function rotorDisc(g, joint, baseNodes) {
  const a = joint.anchor || { x: 0, y: 0, z: 0 };
  const h = (n) => Math.hypot(n.wp[0] - a.x, n.wp[1] - a.y);
  const R = Math.max(1e-6, ...baseNodes.map(h));
  const dyTol = R * 1.5;
  const inDisc = (n) => h(n) <= R + 1e-6 && Math.abs(n.wp[2] - a.z) <= dyTol;

  // A node joins the spin set only if its WHOLE subtree stays inside the disc
  // (the corner node carrying landing legs/arms reaches outside → excluded).
  // Children adjacency is built once so the subtree walk is O(subtree), not O(N²).
  const kids = new Map();
  for (const n of g.nodes) if (n.parent >= 0) { const arr = kids.get(n.parent) || []; arr.push(n.i); kids.set(n.parent, arr); }
  const subtreeInside = (n) => {
    const stack = [n.i];
    while (stack.length) {
      const k = g.nodes[stack.pop()];
      if (!inDisc(k)) return false;
      const c = kids.get(k.i);
      if (c) for (const ci of c) stack.push(ci);
    }
    return true;
  };

  const baseSet = new Set(baseNodes.map((n) => n.name));
  const extra = [];
  const excluded = [];
  for (const n of baseNodes) if (!subtreeInside(n)) excluded.push(n.name);
  for (const n of g.nodes) {
    if (baseSet.has(n.name) || !n.wext) continue;
    if (inDisc(n) && subtreeInside(n)) extra.push({ name: n.name, worldPos: n.wp.map((v) => +v.toFixed(3)) });
  }
  return { rotorRadius: +R.toFixed(3), extraNodes: extra, excludedFromSpin: excluded };
}

export function jointRoutes(app, kernel) {
  // Hypothesis manifest from the phase-1 discovery loop (statuses + tests).
  app.get('/api/manifest', async () => ({ ok: true, manifest: kernel.current.manifest || [] }));

  // Phase 2: trigger one L2 AI-proposal round over the current manifest
  // (refines the needs-verdict frontier; reopen state survives). 503 when the
  // agent supervisor is in stub mode — proposals need a live model.
  app.post('/api/manifest/refine', async (req, reply) => {
    const r = await kernel.refineManifest();
    if (!r.ok) return reply.code(503).send(r);
    return r;
  });

  // Phase 3: trigger ONE vision round — the kernel plans poses, a connected
  // browser tab draws them, and a multimodal model reads the frames.
  //
  // The body is the round's own tuning surface (all optional): { round, mode,
  // focus, maxViews, minCoverage, allowGhost, ghostViews, maxFrames, maskPairs,
  // ghostFrames, orientation, rendererId, timeoutMs, viewport }.
  //
  // Status codes are per-CAUSE, mirroring /api/observe/*, because each one tells
  // the operator to do something different:
  //   400 no project loaded      -> POST /api/project
  //   409 renderer has no model  -> load the mesh in the viewer tab
  //   500 the planner threw      -> a bug, not an operator action
  //   502 the model failed       -> start the DSH host / check the vision_model
  //   503 nothing was available  -> open a viewer tab, or wait for a live agent
  // A refusal never touches the manifest, so the button is safe to press twice.
  app.post('/api/manifest/vision-refine', async (req, reply) => {
    const r = await kernel.visionRefine(req.body || {});
    if (!r.ok) {
      const code = r.code === 'NO_PROJECT' ? 400
        : r.code === 'NO_MODEL' ? 409
          : r.code === 'PLAN_FAILED' ? 500
            : (r.code === 'VISION_DEGRADED' || r.code === 'VISION_FAILED') ? 502
              : 503;
      return reply.code(code).send(r);
    }
    return r;
  });

  app.get('/api/joints', async () => ({
    ok: true,
    joints: (kernel.current.joints || []).map(jointSummary),
  }));

  // The render-id -> component/control contract, so the frontend renderer registry
  // and the backend slot graph cannot drift apart.
  app.get('/api/renders', async () => ({ ok: true, renders: KNOWN_RENDERS }));

  // Rig report for ONE joint: node names + parent chains + rest world positions,
  // joint anchor, rotor radius/disc membership (including completion + subtree
  // exclusions), and the cousin/sibling warning that prevents per-node rotation.
  app.get('/api/joints/:id/rig', async (req, reply) => {
    const joint = (kernel.current.joints || []).find((j) => j.id === req.params.id);
    if (!joint) return reply.code(404).send({ ok: false, error: `joint not found: ${req.params.id}` });
    const g = await parsed(kernel.current.glbPath);
    if (!g) return reply.code(400).send({ ok: false, error: 'no project loaded; POST /api/project first' });

    const byName = new Map(g.nodes.map((n) => [n.name, n]));
    const chainOf = (n) => {
      const chain = [];
      let cur = n;
      while (cur) { chain.push(cur.name); cur = cur.parent >= 0 ? g.nodes[cur.parent] : null; }
      return chain;
    };

    const baseNames = joint.nodes || [];
    const baseNodes = baseNames.map((nm) => byName.get(nm)).filter(Boolean);
    const nodes = baseNodes.map((n) => ({
      name: n.name,
      index: n.i,
      parent: n.parent >= 0 ? g.nodes[n.parent]?.name ?? null : null,
      parentChain: chainOf(n),
      worldPos: n.wp.map((v) => +v.toFixed(3)),
      hasMesh: n.mesh || n.children > 0,
    }));

    // Cousin/sibling detection: blades whose parent is NOT another joint node.
    const meta = joint.over?.meta || {};
    const bladeNames = new Set(meta.blades || []);
    const baseSet = new Set(baseNames);
    const cousins = baseNodes
      .filter((n) => bladeNames.has(n.name) && n.parent >= 0 && !baseSet.has(g.nodes[n.parent]?.name ?? ''))
      .map((n) => ({ name: n.name, parent: g.nodes[n.parent]?.name ?? null }));

    const warnings = [];
    if (joint.type === 'rotor') {
      // The hard-won rule — ALWAYS true for a rigid rotor assembly, independent
      // of the parent/child shape: spin the assembly about its anchor.
      warnings.push(
        'Rotate the whole rotor assembly about the joint ANCHOR via a pivot Object3D ' +
        '(re-parent the spin-set nodes with attach() so world transforms are preserved), ' +
        'then set pivot.rotation.z (model space is Z-up). NEVER set rotation on each node individually: per-node ' +
        'rotation spins every part about its OWN origin and tears blades/locks off the hub.',
      );
      if (cousins.length) {
        warnings.push(
          `${cousins.length} blade(s) are NOT direct children of the hub (parents: ` +
          `${[...new Set(cousins.map((c) => c.parent))].join(', ')}) — they are siblings/cousins in the ` +
          'hierarchy, which is exactly why per-node rotation fails and the anchor-pivot is required.',
        );
      }
      if (joint.params?.direction) {
        warnings.push(`direction=${joint.params.direction}: diagonal pairs must counter-rotate (FL/BR vs FR/BL).`);
      }
    }

    const disc = joint.type === 'rotor' ? rotorDisc(g, joint, baseNodes) : null;
    if (disc?.excludedFromSpin.length) {
      warnings.push(`exclude from the spin set (subtree leaves the rotor disc): ${disc.excludedFromSpin.join(', ')}.`);
    }
    if (disc?.extraNodes.length) {
      const names = disc.extraNodes.map((n) => n.name);
      const shown = names.slice(0, 12).join(', ') + (names.length > 12 ? `, … +${names.length - 12} more` : '');
      warnings.push(`discovery's node list missed ${names.length} in-disc node(s) that belong to the spinning assembly (see disc.extraNodes): ${shown}.`);
    }

    return {
      ok: true,
      joint: { id: joint.id, label: joint.label, type: joint.type, anchor: joint.anchor, axis: joint.axis, direction: joint.params?.direction ?? null },
      model: { up: 'Z (XY horizontal in model space; the viewer scene is Z-up too — spin is rotation.z)', radius: +g.radius.toFixed(3), center: g.center.map((v) => +v.toFixed(3)), nodeCount: g.count },
      nodes,
      disc,
      cousins,
      warnings,
      contract: ['createDroneController(root, THREE)', 'update(dt)', 'setSpeed', 'turnLeft/turnRight/goStraight', 'setGimbal', 'getState', 'describe'],
    };
  });
}

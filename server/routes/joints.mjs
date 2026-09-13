// Joint routes — list discovered joints, publish the renderer-registry contract
// (the render ids the frontend must implement), and serve the deterministic RIG
// REPORT the debugging assistant relies on (GET /api/joints/:id/rig). The
// per-joint slot graph lives in project.mjs (/api/joints/:id/slots).
//
// This module also carries the manifest's write surface — the phase-2 refine, the
// phase-3 vision campaign and the phase-3 human verdict — because all three are
// "change what we believe about the joints" and a reader looking for that should
// not have to know which phase produced it. Every one of them delegates straight
// to the kernel; nothing here decides anything.
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

  // Stop the in-flight STAGED refinement at its next boundary. Joints refined so
  // far stay committed (each was saved and revised at its own boundary); the rest
  // remain candidates. 409 when no refinement is running (nothing to stop).
  app.post('/api/refine/abort', async (req, reply) => {
    if (!kernel.abortRefine) return reply.code(501).send({ ok: false, error: 'abort is not available on this kernel' });
    const r = kernel.abortRefine();
    if (!r.ok) return reply.code(409).send(r);
    return r;
  });

  // Phase 3: trigger a vision CAMPAIGN — the kernel plans poses, a connected
  // browser tab draws them, a multimodal model reads the frames and says where it
  // was unsure, and a second round goes and looks there. One press, up to two
  // rounds, each with its own observation directory.
  //
  // The body is the campaign's own tuning surface (all optional): { round, mode,
  // focus, maxViews, minCoverage, allowGhost, ghostViews, maxFrames, maskPairs,
  // ghostFrames, orientation, rendererId, timeoutMs, viewport }.
  //
  // Task-16 knobs, and the important property is that they can only ever LOWER
  // the ceiling — `rounds` is clamped to MAX_VISION_ROUNDS and `extraViews` to
  // MAX_EXTRA_VIEWS, and a request above either is answered with the capped value
  // plus a warning saying so. A knob that could raise the bound would let a caller
  // talk the machine into a longer look than a human authorised, which is exactly
  // what the bounded-auto decision was there to prevent:
  //   rounds      how many rounds this press may run (1 = the old single round)
  //   extraViews  frames round 2 may buy ON TOP of round 1 (0 = no round 2)
  //   maxRegions  how many distinct doubts round 2 may aim at
  //   perRegion   close-up poses per aimed region
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

  // Phase 3 task 17: the evidence behind ONE claim — the frames the model was
  // looking at, what it said, where it said it was unsure, and who a verdict may
  // be offered to. One call rather than four because the panel is opened by a
  // click on a joint and a human waiting on four round trips before they can read
  // anything is a human who starts pressing buttons without looking.
  //
  // `frames` is the claim's own evidence and `rounds` is the whole observation
  // history, so the same panel can answer "what did it see" and "what did we ever
  // look at" without a second endpoint. Frame BYTES are never inlined — each
  // frame carries a servable `url` under the statically-mounted runs/ prefix.
  app.get('/api/joints/:id/evidence', async (req, reply) => {
    const r = kernel.jointEvidence(req.params.id);
    if (!r.ok) return reply.code(r.code === 'NO_RECORD' ? 404 : 400).send(r);
    return r;
  });

  // Phase 3 task 17: the symmetry peers of one joint — who a verdict on it may be
  // OFFERED to, and why each one qualifies. Read-only and safe to poll: the panel
  // calls it when a joint is selected so the checkboxes are already drawn by the
  // time the human has read the evidence.
  app.get('/api/joints/:id/peers', async (req, reply) => {
    const r = kernel.jointPeers(req.params.id);
    if (!r.ok) return reply.code(r.code === 'NO_RECORD' ? 404 : 400).send(r);
    return r;
  });

  // Phase 3 task 17: the human verdict. The only route to `confirmed`/`rejected`
  // — no model and no test can produce either, which is the whole point of having
  // a human gate.
  //
  // Body: { decision:'accept'|'reject'|'edit', edits:{label|type|nodes|anchor|axis},
  //         note, actor, amortizeTo:[peer ids] }
  //
  // `amortizeTo` is the lateral edge: it passes THIS verdict on to symmetry peers
  // the human explicitly selected. It is never defaulted to "all peers", and an
  // `edit` cannot be amortized at all — it is written in this joint's own node
  // names, and a mirror's nodes are different nodes.
  //
  // Status codes are per-CAUSE like the rest of this file. There are only two,
  // because the verdict write path only refuses for two reasons:
  //   404 no such joint
  //   400 no project loaded / unknown decision / an edit with nothing editable
  // A refusal leaves the on-disk manifest byte-identical, so this is safe to press
  // twice — `manifestUntouched:true` in the body says so explicitly.
  //
  // There is deliberately NO 409. The amortization outcome arrives nested under
  // `amortized`, never as the top-level `code`, because `amortizeVerdict` only
  // runs AFTER the verdict itself has been applied — so its four refusals
  // (NO_VERDICT, NOT_AMORTIZABLE, NO_PEERS, NOTHING_APPLIED) describe a footnote
  // on a write that succeeded. Promoting any of them to an HTTP error would tell
  // the human their accept did not happen, and they would press it again. The
  // verdict and its amortization are reported SEPARATELY for exactly that reason:
  // an accept that applied while one mirror was skipped is a success with a
  // footnote, not a failure.
  app.post('/api/joints/:id/verdict', async (req, reply) => {
    const r = kernel.setVerdict({ ...(req.body || {}), id: req.params.id });
    if (!r.ok) return reply.code(r.code === 'NO_RECORD' ? 404 : 400).send(r);
    return r;
  });

  // Remove a joint from the list entirely — the expression of "this proposal is
  // wrong, take it off the list", which neither a verdict (row stays) nor
  // dropCandidate (refuses refined records) could say. One call, any status;
  // the kernel commits a revision first so the removed node list survives in
  // the audit trail, and broadcasts so every open tab drops the row.
  app.post('/api/joints/:id/remove', async (req, reply) => {
    if (!kernel.removeJoint) return reply.code(501).send({ ok: false, error: 'remove is not available on this kernel' });
    const r = kernel.removeJoint(req.params.id, (req.body && req.body.actor) || 'human');
    if (!r.ok) return reply.code(r.code === 'NO_SUCH_JOINT' ? 404 : 400).send(r);
    return r;
  });

  // Phase 3 task 18: drive ONE joint through its motion and ask a multimodal model
  // a SEMANTIC-ONLY question — "what is this moving thing, is the motion sensible".
  // Which nodes move and by how much is already measured exactly by the rigidity
  // gate, so this round annotates the record (rec.motion) and never touches
  // confidence or status: the battery owns status, the human owns the verdict.
  //
  // Body (all optional): { angles:[deg], mode:'photo'|'solo', round, viewport,
  //   rendererId, timeoutMs }. angles defaults to MOTION_ANGLES [0,30,60]; the
  // fan plus one swept composite are drawn synchronously in the browser so the
  // preview tick can never re-parent the pivot mid-fan.
  //
  // Status codes are per-CAUSE like the rest of this file, because each tells the
  // operator to do something different:
  //   404 no such joint                -> check the id
  //   400 no project / no nodes        -> POST /api/project, or the joint is empty
  //   409 renderer has no model        -> load the mesh in the viewer tab
  //   500 the planner could not frame  -> a bug, not an operator action
  //   502 the model failed             -> start the DSH host / check vision_model
  //   503 nothing was available        -> open a viewer tab, or wait for a live agent
  // A refusal leaves the on-disk record byte-identical, so this is safe to press
  // twice — `manifestUntouched:true` in the body says so explicitly.
  app.post('/api/joints/:id/motion', async (req, reply) => {
    const r = await kernel.motionRefine({ ...(req.body || {}), jointId: req.params.id });
    if (!r.ok) {
      const code = r.code === 'NO_RECORD' ? 404
        : (r.code === 'NO_PROJECT' || r.code === 'NO_MANIFEST' || r.code === 'NO_NODES') ? 400
          : r.code === 'NO_MODEL' ? 409
            : (r.code === 'NO_REGION' || r.code === 'NO_VIEWS') ? 500
              : (r.code === 'VISION_DEGRADED' || r.code === 'MOTION_FAILED') ? 502
                : 503;
      return reply.code(code).send(r);
    }
    return r;
  });

  // Phase 3 task 19: the TIME axis. Every belief-changing write (a loop round, a
  // verdict, an amortization, a rigidity reopen) froze the whole manifest graph as
  // `manifest.r<N>.json`. These three read that chain back — list it, load one, and
  // diff one against its parent. All read-only, so they are safe to poll.
  //
  // Branching for the time axis, graph for the justification axis: a revision is a
  // commit of the graph, and `parent` is normally N-1 but need not be, so re-running
  // a round from an earlier state makes a branch with no VCS and no graph framework.
  app.get('/api/revisions', async () => kernel.revisions());

  app.get('/api/revisions/:n', async (req, reply) => {
    const r = kernel.revision(Number(req.params.n));
    if (!r.ok) return reply.code(404).send(r);
    return r;
  });

  // ?against=<m> diffs against a specific revision; with no query the diff is
  // against the snapshot's own parent, which answers "what did this round change?"
  app.get('/api/revisions/:n/diff', async (req, reply) => {
    const q = req.query?.against;
    const against = q != null && q !== '' ? Number(q) : null;
    const r = kernel.revisionDiff(Number(req.params.n), against);
    if (!r.ok) return reply.code(404).send(r);
    return r;
  });

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

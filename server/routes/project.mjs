// Project routes — the REST surface over the kernel pipeline. Thin: each handler
// delegates to the kernel facade and serializes a browser-friendly result.
import { resolveSlotGraph } from '../slots.mjs';

// Slim a joint for the wire (node arrays can be large; the list only needs counts).
// `carves` is the LIVE registry on the parsed graph (kernel.current.glb.carves):
// the record's evidence form deliberately carries no triangle list, but the
// viewer cannot cut the patch out of the shell without one, so the wire form
// merges the registry's tris in when they exist. A spec without live tris
// ships as-is and simply never materializes.
function jointSummary(j, carves) {
  const live = j.carve ? (carves || []).find((c) => c.id === j.carve.id) : null;
  return {
    id: j.id,
    label: j.label,
    type: j.type,
    status: j.status || 'candidate',
    evidence: j.evidence || [],
    confidence: j.confidence ?? null,
    tests: (j.tests || []).map((t) => ({ name: t.name, pass: !!t.pass, level: t.level || 'fail', detail: t.detail || '', ...(t.floaters?.length ? { floaters: t.floaters } : {}) })),
    nodeCount: (j.nodes || []).length,
    nodes: j.nodes || [],   // node names: the viewer preview rotates exactly these
    anchor: j.anchor,
    axis: j.axis,
    commands: (j.commands || []).map((c) => ({ name: c.name, kind: c.kind, min: c.min, max: c.max, step: c.step, unit: c.unit, default: c.default })),
    // Phase 3: what the vision model SAID and where it was UNSURE. These are the
    // two things a human gate actually reads — a confidence number alone cannot
    // be argued with, but "blade count unclear" can. Carried only when present so
    // phase-1/2 joints do not grow three empty fields each.
    ...(j.reasoning ? { reasoning: j.reasoning } : {}),
    ...(j.uncertainties?.length ? { uncertainties: j.uncertainties } : {}),
    // Which producer made the claim ('L2-ai', 'L2-vision', ...). The UI labels a
    // vision-sourced chip differently because its evidence is a frame a human can
    // open, not a sentence in a node dump.
    ...(j.origin ? { origin: j.origin } : {}),
    // Phase 3 task 17: what a human decided, and — when the decision was inherited
    // from a symmetry peer — whose verdict it really was. The panel renders a
    // confirmed chip differently when `amortizedFrom` is set, because "a person
    // looked at this joint" and "a person looked at its mirror" are different
    // claims and only one of them is direct evidence.
    ...(j.verdict ? { verdict: j.verdict } : {}),
    // On-surface OUT: this joint's part was cut out of a fused shell. The spec
    // (+ live tris when the registry has them) lets the viewer materialize the
    // carve as its own named subtree.
    ...(j.carve ? { carve: { ...j.carve, ...(live?.tris ? { tris: live.tris } : {}) } } : {}),
  };
}

export function projectRoutes(app, kernel) {
  // Load a GLB: register asset, discover joints, draft motion-spec IR.
  app.post('/api/project', async (req, reply) => {
    const { glb } = req.body || {};
    if (!glb) return reply.code(400).send({ error: 'body.glb required (repo-relative or absolute path)' });
    try {
      const d = await kernel.discover(glb);
      // Chained refinement: the geometry pass answers in milliseconds, then TWO
      // producers look at the result CONCURRENTLY and independently — the JSON
      // semantic lane (the node dump) and the vision lane (rendered frames) —
      // streaming their progress over the events WS and reconciled into ONE
      // revision. Fire-and-forget and self-guarding: a load never waits on it, and
      // a lane with no model or no renderer broadcasts its own skip while the
      // other lane carries on, so the geometry result always stands.
      if (kernel.autoRefine) setImmediate(() => { kernel.autoRefine().catch(() => {}); });
      return {
        ok: true,
        glb: d.glbPath,
        stats: d.stats,
        specCheck: d.specCheck,
        joints: d.joints.map((j) => jointSummary(j, kernel.current.glb?.carves)),
        viewer: kernel.viewerUrls(),
      };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // Validate an existing controller file against the loaded mesh.
  app.post('/api/validate', async (req, reply) => {
    const { file } = req.body || {};
    if (!file) return reply.code(400).send({ error: 'body.file required' });
    try {
      const r = await kernel.validate(file);
      return { ok: true, pass: r.pass, failures: r.failures, warnings: r.warnings, metrics: r.metrics, rigidity: r.rigidity || null, reopened: r.reopened || [], controller: r.controller, controllerUrl: r.controllerUrl, viewer: kernel.viewerUrls() };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // Generate a controller via the DSH bridge. Always a SINGLE emit→validate
  // pass (rounds fixed at 1); round progress is broadcast over the events WS.
  // `out` (optional) is the user-chosen destination the accepted controller is
  // copied to; omit it to keep the run-dir default.
  app.post('/api/generate', async (req, reply) => {
    const { lang = 'javascript', model = null, out = null } = req.body || {};
    const rounds = 1;
    try {
      const gen = await kernel.generate({
        lang, model, rounds, out,
        onRound: (r) => app.broadcast({ kind: 'round', ...r }),
      });
      const accepted = gen.failures.length === 0;
      if (accepted) kernel.viewerUrls(); // refresh controller.view.js
      const report = kernel.finalize({ accepted, roundsUsed: gen.roundsUsed, lang, model, failures: gen.failures, warnings: gen.warnings, metrics: gen.metrics });
      return { ok: true, accepted, roundsUsed: gen.roundsUsed, failures: gen.failures, warnings: gen.warnings, metrics: gen.metrics, controller: gen.controller, viewer: kernel.viewerUrls(), report };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // Current server-side state (for the UI on load / resume).
  app.get('/api/state', async () => {
    const c = kernel.current;
    return {
      ok: true,
      loaded: !!c.glb,
      glb: c.glbPath,
      stats: c.glb,
      joints: (c.joints || []).map((j) => jointSummary(j, c.glb?.carves)),
      validation: c.lastValidation,
      viewer: c.glb ? kernel.viewerUrls() : { glb: null, ctl: null },
      runDir: kernel.runDir,
    };
  });

  // Slot graph for a specific joint (data-driven knob/overlay routing).
  app.get('/api/joints/:id/slots', async (req, reply) => {
    const joint = kernel.current.joints.find((j) => j.id === req.params.id);
    if (!joint) return reply.code(404).send({ error: `joint not found: ${req.params.id}` });
    return { ok: true, graph: resolveSlotGraph(kernel, joint) };
  });
}

export { jointSummary };

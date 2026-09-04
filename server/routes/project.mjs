// Project routes — the REST surface over the kernel pipeline. Thin: each handler
// delegates to the kernel facade and serializes a browser-friendly result.
import { resolveSlotGraph } from '../slots.mjs';

// Slim a joint for the wire (node arrays can be large; the list only needs counts).
function jointSummary(j) {
  return {
    id: j.id,
    label: j.label,
    type: j.type,
    status: j.status || 'candidate',
    nodeCount: (j.nodes || []).length,
    nodes: j.nodes || [],   // node names: the viewer preview rotates exactly these
    anchor: j.anchor,
    axis: j.axis,
    commands: (j.commands || []).map((c) => ({ name: c.name, kind: c.kind, min: c.min, max: c.max, step: c.step, unit: c.unit, default: c.default })),
  };
}

export function projectRoutes(app, kernel) {
  // Load a GLB: register asset, discover joints, draft motion-spec IR.
  app.post('/api/project', async (req, reply) => {
    const { glb } = req.body || {};
    if (!glb) return reply.code(400).send({ error: 'body.glb required (repo-relative or absolute path)' });
    try {
      const d = await kernel.discover(glb);
      return {
        ok: true,
        glb: d.glbPath,
        stats: d.stats,
        specCheck: d.specCheck,
        joints: d.joints.map(jointSummary),
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
      return { ok: true, pass: r.pass, failures: r.failures, warnings: r.warnings, metrics: r.metrics, controller: r.controller, controllerUrl: r.controllerUrl, viewer: kernel.viewerUrls() };
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
      joints: (c.joints || []).map(jointSummary),
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

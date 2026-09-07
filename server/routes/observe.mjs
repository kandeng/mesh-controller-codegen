// Observe routes — the HTTP half of "go and look".
//
// Three jobs, deliberately separate:
//
//   PLAN     POST /api/observe/plan        run the NBV planner over the cached
//                                          parse table and persist the poses
//   CAPTURE  POST /api/observe/capture     block until one frame comes back
//   DELIVER  POST /api/observe/frame       the renderer's byte upload
//
// Why plan and capture are different calls: planning is pure math over a table
// the kernel already holds (no GPU, no browser, ~80ms for 520 candidate poses),
// while a capture needs a live browser tab with the model loaded. Coupling them
// would mean a missing renderer makes the plan unavailable too — and the plan is
// exactly what a human needs to see in order to decide whether to open a tab.
//
// Why the bytes go over REST and not the WebSocket: @fastify/websocket caps
// maxPayload at 1 MB and a 1024px PNG base64s to roughly 2 MB. Commands travel
// over /api/events (small, already connected); pixels travel here, reusing the
// 8 MB bodyLimit the server was built with. See server/render-farm.mjs.
//
// Every route degrades instead of throwing: no project → 400, no renderer → 503,
// renderer refused → 409, renderer too slow → 504. The observation store is
// written BEFORE the waiting capture is resolved, so a frame that arrives after
// its timeout is still evidence on disk (answered 409, delivered:false).
import { planViews, focusFromManifest, VIEWPORT } from '../../src/plugins/discovery/views.mjs';
import {
  FRAME_MODES, MAX_FRAMES_PER_ROUND, frameKey, framePath, listRounds, loadColorMap,
  loadPlan, loadRound, saveFrame, savePlan,
} from '../../src/plugins/discovery/observations.mjs';
import { toViewerUrl } from '../../src/pipeline.mjs';

// Rounds are a directory name and an array index. Bound them so neither a typo
// nor a hostile body can reach outside <runDir>/observations/.
const rnd = (v) => Math.max(0, Math.min(999, Number.parseInt(v, 10) || 0));

// A frame body may arrive as a bare base64 string or as a canvas dataURL. Only
// the payload is wanted; the media type is carried separately so saveFrame can
// pick the extension.
function splitImage(body) {
  const raw = body?.dataUrl || body?.dataBase64 || body?.image || '';
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(raw));
  if (m) return { dataBase64: m[3], mediaType: body?.mediaType || m[1] };
  return { dataBase64: String(raw), mediaType: body?.mediaType || 'image/png' };
}

// Map a stored artefact to a URL the browser can put in an <img src>. The run
// directory already sits under the statically-mounted runs/ prefix, so this is a
// path rewrite, not a copy.
const urlOf = (kernel, abs) => (abs ? toViewerUrl(kernel.host, kernel.runDir, abs) : null);

export function observeRoutes(app, kernel, farm) {
  // ---- farm status ----------------------------------------------------------

  // Cheap liveness probe the UI polls before offering a "run vision round"
  // button: a plan is always computable, a capture is not.
  app.get('/api/observe/farm', async () => ({
    ok: true,
    farm: farm ? farm.status() : null,
    renderers: farm ? farm.list() : [],
    available: !!farm && farm.status().ready > 0,
  }));

  // ---- planning -------------------------------------------------------------

  // body: { round, maxViews, minCoverage, mode: 'frontier'|'all'|'none',
  //         focus: [names], allowGhost, ghostViews, persist, viewport }
  app.post('/api/observe/plan', async (req, reply) => {
    const g = kernel.current.glb;
    if (!g) return reply.code(400).send({ ok: false, error: 'no project loaded; POST /api/project first' });

    const b = req.body || {};
    const round = rnd(b.round);
    const mode = b.mode === 'all' || b.mode === 'none' ? b.mode : 'frontier';

    // An explicit `focus` list wins: the UI can aim a round at one joint the
    // user is arguing with. Otherwise focus is derived from what discovery
    // already believes and suspects. `none` plans against the whole model, which
    // is the "what did we miss entirely" question and costs ~4x the frames.
    let focusNames = null;
    if (Array.isArray(b.focus) && b.focus.length) {
      focusNames = new Set(b.focus.map(String));
    } else if (mode !== 'none') {
      focusNames = focusFromManifest(g, kernel.current.manifest, kernel.current.joints, { mode });
    }

    const t0 = Date.now();
    let plan = null;
    try {
      plan = planViews(g, {
        maxViews: Number.isFinite(b.maxViews) ? Math.max(1, Math.min(64, b.maxViews | 0)) : 12,
        minCoverage: Number.isFinite(b.minCoverage) ? b.minCoverage : 0.99,
        viewport: b.viewport && b.viewport.w ? b.viewport : VIEWPORT,
        focusNames,
        allowGhost: b.allowGhost !== false,
        ghostViews: Number.isFinite(b.ghostViews) ? Math.max(0, Math.min(16, b.ghostViews | 0)) : 4,
      });
    } catch (e) {
      kernel.diagnostics?.note?.('observe plan failed', { error: e.message });
      return reply.code(500).send({ ok: false, error: `planner failed: ${e.message}` });
    }
    const ms = Date.now() - t0;

    const saved = b.persist === false ? null : savePlan(kernel.runDir, round, { ...plan, mode, focus: focusNames ? [...focusNames] : null });
    kernel.diagnostics?.note?.('observe plan', { round, mode, views: plan.views.length, coverage: plan.coverage, ms });

    return {
      ok: true,
      round,
      mode,
      ms,
      saved: urlOf(kernel, saved),
      // The plan is the evidence record: poses, what each one buys, and the part
      // of the model no opaque pose can reach at all.
      plan: {
        targets: plan.targets,
        covered: plan.covered,
        coverage: plan.coverage,
        unseen: plan.unseen,
        interiorOnly: plan.interiorOnly,
        focus: focusNames ? [...focusNames] : null,
        views: plan.views,
      },
      farm: farm ? farm.status() : null,
    };
  });

  // ---- capture --------------------------------------------------------------

  // body: { round, viewId | view, mode, focusNodes, viewport, rendererId,
  //         timeoutMs, persist }
  //
  // Blocks until the renderer POSTs the frame back. `viewId` is preferred over an
  // inline `view`: it forces the pose to come from a persisted plan, so a frame
  // on disk always has a plan that asked for it.
  app.post('/api/observe/capture', async (req, reply) => {
    if (!farm) return reply.code(503).send({ ok: false, error: 'render farm unavailable' });
    const b = req.body || {};
    const round = rnd(b.round);

    let view = b.view && typeof b.view === 'object' ? b.view : null;
    if (b.viewId) {
      const plan = loadPlan(kernel.runDir, round);
      const found = (plan?.views || []).find((v) => v.id === String(b.viewId));
      if (!found) {
        return reply.code(404).send({
          ok: false,
          error: `view ${b.viewId} is not in the round ${round} plan`,
          hint: plan ? 'POST /api/observe/plan for this round first' : 'no plan persisted for this round',
        });
      }
      view = found;
    }
    if (!view || !view.pose) return reply.code(400).send({ ok: false, error: 'capture needs a viewId from a saved plan, or an inline view with a pose' });

    const mode = FRAME_MODES.includes(b.mode) ? b.mode : (FRAME_MODES.includes(view.mode) ? view.mode : 'photo');

    let result = null;
    try {
      result = await farm.capture({
        round,
        view,
        mode,
        focusNodes: Array.isArray(b.focusNodes) ? b.focusNodes.map(String) : null,
        viewport: b.viewport && b.viewport.w ? b.viewport : VIEWPORT,
        rendererId: b.rendererId ? String(b.rendererId) : null,
        timeoutMs: Number.isFinite(b.timeoutMs) ? b.timeoutMs : null,
      });
    } catch (e) {
      // Each code maps to a distinct operator action, so they must not collapse
      // into one generic 500.
      const code = e.code === 'NO_RENDERER' ? 503 : e.code === 'NO_MODEL' ? 409 : 504;
      kernel.diagnostics?.note?.('observe capture failed', { round, viewId: view.id, code: e.code, error: e.message });
      return reply.code(code).send({ ok: false, error: e.message, code: e.code || 'CAPTURE_FAILED', farm: farm.status() });
    }

    // The frame route already persisted it; here we only echo where it landed.
    const entry = result?.frame || null;
    return {
      ok: true,
      round,
      requestId: result.requestId,
      rendererId: result.rendererId,
      mode,
      view: { id: view.id, kind: view.kind ?? null, mode },
      // The key the frame is stored under: pose AND mode, because one pose is
      // legitimately drawn several ways and re-saving a key replaces it.
      key: frameKey(view.id, mode),
      frame: entry,
      url: entry ? urlOf(kernel, framePath(kernel.runDir, round, entry.id)) : null,
    };
  });

  // ---- frame delivery (renderer -> server) ----------------------------------

  // The renderer's byte upload. Persist FIRST, then resolve the waiting capture:
  // a frame that lands after its timeout is still evidence, and answering 409
  // with delivered:false tells the browser nobody was listening any more.
  app.post('/api/observe/frame', async (req, reply) => {
    const b = req.body || {};
    const round = rnd(b.round);
    const { dataBase64, mediaType } = splitImage(b);
    const mode = FRAME_MODES.includes(b.mode) ? b.mode : (FRAME_MODES.includes(b.view?.mode) ? b.view.mode : 'photo');
    // The renderer's `id` is the VIEW id, not a storage key. Composing the key
    // here (rather than trusting the client) is what stops a multi-mode round
    // from overwriting its own evidence — see frameKey().
    const id = frameKey(b.viewId || b.id || b.view?.id || b.requestId, mode);

    const stored = saveFrame(kernel.runDir, round, {
      id,
      mode,
      viewId: String(b.viewId || b.id || b.view?.id || b.requestId || id),
      dataBase64,
      mediaType,
      width: Number.isFinite(b.width) ? b.width : null,
      height: Number.isFinite(b.height) ? b.height : null,
      spec: b.spec ?? b.view?.spec ?? null,
      pose: b.pose ?? b.view?.pose ?? null,
      focus: b.focus ?? b.focusNodes ?? null,
      note: b.note ?? null,
      colorMap: b.colorMap && typeof b.colorMap === 'object' ? b.colorMap : null,
    });

    if (!stored.ok) {
      // Fail the waiting capture immediately rather than letting it burn its
      // whole timeout on a frame that will never arrive.
      if (farm && b.requestId) farm.fail(String(b.requestId), stored.error);
      const code = /budget/.test(stored.error) ? 409 : /bytes/.test(stored.error) ? 413 : 400;
      return reply.code(code).send({ ok: false, error: stored.error });
    }

    const url = urlOf(kernel, stored.file);
    const delivered = farm && b.requestId ? farm.deliver(String(b.requestId), { frame: stored.entry, url }) : false;
    if (!delivered) {
      kernel.diagnostics?.note?.('observe frame orphaned', { round, id: stored.entry.id, requestId: b.requestId || null });
      return reply.code(409).send({ ok: true, delivered: false, frame: stored.entry, url, error: 'no capture was waiting for this requestId; the frame was stored anyway' });
    }
    return { ok: true, delivered: true, frame: stored.entry, url };
  });

  // ---- evidence read-back ---------------------------------------------------

  app.get('/api/observations', async () => ({
    ok: true,
    runDir: kernel.runDir,
    maxFramesPerRound: MAX_FRAMES_PER_ROUND,
    // The absolute dir is server-internal; the UI gets the servable URL instead.
    rounds: listRounds(kernel.runDir).map(({ dir, ...r }) => ({ ...r, url: urlOf(kernel, dir) })),
  }));

  app.get('/api/observations/:round', async (req, reply) => {
    const round = rnd(req.params.round);
    const rec = loadRound(kernel.runDir, round);
    if (!rec) return reply.code(404).send({ ok: false, error: `no observations for round ${round}` });
    return {
      ok: true,
      round,
      plan: rec.plan,
      reply: rec.reply,
      proposals: rec.proposals,
      frames: rec.frames.map((f) => ({
        ...f,
        url: urlOf(kernel, framePath(kernel.runDir, round, f.id)),
        colors: f.colorMap ? loadColorMap(kernel.runDir, round, f.id) : null,
      })),
    };
  });

  // One frame's colour map on its own: the map is ground truth for grounding and
  // can be thousands of entries, so it should not ride along in every listing.
  app.get('/api/observations/:round/colors/:id', async (req, reply) => {
    const round = rnd(req.params.round);
    const map = loadColorMap(kernel.runDir, round, req.params.id);
    if (!map) return reply.code(404).send({ ok: false, error: `no colour map for frame ${req.params.id} in round ${round}` });
    return { ok: true, round, id: String(req.params.id), colorMap: map };
  });
}

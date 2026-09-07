// Render farm — the server side of "ask a browser to draw this pose".
//
// Why the browser and not the server: the server deliberately has no WebGL
// context (it uses three for MATH only — buildScene, world transforms, the
// rigidity battery). The browser already has a live, correctly-lit scene with
// OrbitControls, so the cheapest correct renderer is the one that exists.
//
// Split transport, and the reason is a hard limit: @fastify/websocket defaults
// to a 1 MB maxPayload, and a 1024px PNG base64s to roughly 2 MB. So COMMANDS
// go over the existing /api/events socket (small, low latency, already
// connected) and BYTES go over REST (POST /api/observe/frame), which reuses the
// 8 MB Fastify bodyLimit. Raising the WS payload limit instead would make every
// event broadcast a potential multi-megabyte message.
//
// Correlation: the server mints a requestId, the browser echoes it in the POST
// body, and `deliver()` resolves exactly one waiting capture.
export const DEFAULT_CAPTURE_TIMEOUT_MS = 25_000;

// Single WS send helper. Silently drops on a closing socket: a renderer that
// vanishes mid-broadcast must not take the event bus down with it.
export function wsSend(socket, obj) {
  try {
    if (socket && socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(obj));
    return true;
  } catch { return false; }
}

export function createRenderFarm({ timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS, onEvent = null } = {}) {
  const renderers = new Map();  // socket -> entry
  const byId = new Map();       // renderer id -> socket
  const pending = new Map();    // requestId -> { resolve, reject, timer, rendererId }
  let seq = 0;

  const note = (type, data) => { try { onEvent?.({ type, ...data }); } catch { /* never let logging break a capture */ } };
  const nextId = () => `r${(seq += 1)}`;

  // ---- renderer registry ----------------------------------------------------

  // A browser announces itself as able to render. Called from the /api/events
  // inbound handler on `renderer-hello`.
  function attach(socket, meta = {}) {
    if (!socket) return null;
    let entry = renderers.get(socket);
    if (!entry) {
      entry = {
        id: meta.id && !byId.has(meta.id) ? String(meta.id) : nextId(),
        socket, joinedAt: Date.now(), lastUsed: 0, inflight: 0,
        hasModel: false, glb: null, label: null,
      };
      renderers.set(socket, entry);
      byId.set(entry.id, socket);
    }
    update(socket, meta);
    note('renderer:attached', { rendererId: entry.id, renderers: renderers.size });
    return entry;
  }

  function update(socket, meta = {}) {
    const entry = renderers.get(socket);
    if (!entry) return null;
    if (meta.hasModel != null) entry.hasModel = !!meta.hasModel;
    if (meta.glb !== undefined) entry.glb = meta.glb ? String(meta.glb) : null;
    if (meta.label !== undefined) entry.label = meta.label ? String(meta.label).slice(0, 80) : null;
    return entry;
  }

  // Detach fails every request that renderer owed, so callers get an immediate
  // error instead of waiting out the timeout.
  function detach(socket) {
    const entry = renderers.get(socket);
    if (!entry) return;
    renderers.delete(socket);
    byId.delete(entry.id);
    for (const [requestId, p] of [...pending]) {
      if (p.rendererId === entry.id) fail(requestId, `renderer ${entry.id} disconnected mid-capture`);
    }
    note('renderer:detached', { rendererId: entry.id, renderers: renderers.size });
  }

  const list = () => [...renderers.values()].map((e) => ({
    id: e.id, hasModel: e.hasModel, glb: e.glb, label: e.label,
    inflight: e.inflight, idleFor: e.lastUsed ? Date.now() - e.lastUsed : null,
  }));

  const status = () => ({
    renderers: renderers.size,
    ready: [...renderers.values()].filter((e) => e.hasModel).length,
    pending: pending.size,
    timeoutMs,
  });

  // Least-recently-used renderer that has a model and no capture in flight.
  // LRU rather than first-fit so a second browser tab shares the load instead of
  // one tab doing every frame.
  function pick(excludeId = null) {
    let best = null;
    for (const e of renderers.values()) {
      if (!e.hasModel || e.inflight > 0) continue;
      if (excludeId && e.id === excludeId) continue;
      if (!best || e.lastUsed < best.lastUsed) best = e;
    }
    return best;
  }

  // ---- capture --------------------------------------------------------------

  // Ask a renderer for one frame. Resolves with the payload POSTed back to
  // /api/observe/frame; rejects on timeout, disconnect, or an explicit nack.
  //
  // `request`: { view, mode, focusNodes, round, viewport, rendererId, timeoutMs }
  // `view` is the planner's own record (id/spec/pose) — it travels verbatim so
  // the frame on disk and the plan that asked for it share one description.
  async function capture(request = {}) {
    const renderer = request.rendererId
      ? (() => { const s = byId.get(request.rendererId); return s ? renderers.get(s) : null; })()
      : pick();
    if (!renderer) {
      const err = new Error(request.rendererId
        ? `no renderer with id ${request.rendererId}`
        : 'no browser renderer with a loaded model is connected');
      err.code = 'NO_RENDERER';
      throw err;
    }
    if (!renderer.hasModel) {
      const err = new Error('the connected renderer has no model loaded');
      err.code = 'NO_MODEL';
      throw err;
    }

    const requestId = `cap_${Date.now().toString(36)}_${nextId()}`;
    const budget = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : timeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(requestId, `renderer did not deliver a frame within ${budget}ms`);
      }, budget);
      pending.set(requestId, { resolve, reject, timer, rendererId: renderer.id });

      renderer.inflight += 1;
      renderer.lastUsed = Date.now();
      const sent = wsSend(renderer.socket, {
        kind: 'render-request',
        requestId,
        round: request.round ?? null,
        view: request.view ?? null,
        mode: request.mode || 'photo',
        focusNodes: Array.isArray(request.focusNodes) ? request.focusNodes : null,
        viewport: request.viewport ?? null,
        frameUrl: '/api/observe/frame',
      });
      if (!sent) fail(requestId, 'renderer socket is not writable');
    });
  }

  // Ask a renderer for a MOTION FAN: one joint driven through several angles from
  // a single fixed camera, plus a swept composite. Task 18.
  //
  // It shares the whole capture lifecycle — pick(), the pending map, deliver(),
  // fail(), release(), detach() — because a fan is one logical request that
  // resolves once, exactly like a single frame; only the WS message differs
  // (kind:'motion-request', carrying the joint and its angles) and only the upload
  // endpoint differs (/api/observe/motion, which takes the whole fan in one body).
  // Reusing `pending`/`deliver` is what lets a renderer nack or a disconnect fail a
  // fan through the identical code path, so a motion round degrades the same way a
  // vision round does.
  //
  // `request`: { joint, view, angles, mode, focusNodes, round, viewport,
  //              rendererId, timeoutMs }
  async function captureMotion(request = {}) {
    const renderer = request.rendererId
      ? (() => { const s = byId.get(request.rendererId); return s ? renderers.get(s) : null; })()
      : pick();
    if (!renderer) {
      const err = new Error(request.rendererId
        ? `no renderer with id ${request.rendererId}`
        : 'no browser renderer with a loaded model is connected');
      err.code = 'NO_RENDERER';
      throw err;
    }
    if (!renderer.hasModel) {
      const err = new Error('the connected renderer has no model loaded');
      err.code = 'NO_MODEL';
      throw err;
    }

    const requestId = `mot_${Date.now().toString(36)}_${nextId()}`;
    const budget = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : timeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(requestId, `renderer did not deliver a motion fan within ${budget}ms`);
      }, budget);
      pending.set(requestId, { resolve, reject, timer, rendererId: renderer.id });

      renderer.inflight += 1;
      renderer.lastUsed = Date.now();
      const sent = wsSend(renderer.socket, {
        kind: 'motion-request',
        requestId,
        round: request.round ?? null,
        // The joint travels whole: the viewer rebuilds the preview pivot from
        // { id, type, nodes, anchor, tests } and cannot drive a fan without them.
        joint: request.joint ?? null,
        view: request.view ?? null,
        angles: Array.isArray(request.angles) ? request.angles : null,
        mode: request.mode || 'photo',
        focusNodes: Array.isArray(request.focusNodes) ? request.focusNodes : null,
        viewport: request.viewport ?? null,
        motionUrl: '/api/observe/motion',
      });
      if (!sent) fail(requestId, 'renderer socket is not writable');
    });
  }

  // The renderer said "cannot do that" before trying (no model, unknown view,
  // WebGL context lost). Fail fast rather than burn the timeout.
  function nack(requestId, error = 'renderer refused the capture') {
    fail(requestId, error);
  }

  function fail(requestId, message) {
    const p = pending.get(requestId);
    if (!p) return false;
    pending.delete(requestId);
    clearTimeout(p.timer);
    release(p.rendererId);
    const err = new Error(message);
    err.code = 'CAPTURE_FAILED';
    err.requestId = requestId;
    note('render:failed', { requestId, rendererId: p.rendererId, error: message });
    p.reject(err);
    return true;
  }

  function release(rendererId) {
    const socket = byId.get(rendererId);
    const entry = socket ? renderers.get(socket) : null;
    if (entry && entry.inflight > 0) entry.inflight -= 1;
  }

  // Called by POST /api/observe/frame once the bytes are on disk. Returns false
  // for an unknown/expired requestId so the route can answer 409 instead of
  // silently accepting an orphan frame.
  function deliver(requestId, payload) {
    const p = pending.get(requestId);
    if (!p) return false;
    pending.delete(requestId);
    clearTimeout(p.timer);
    release(p.rendererId);
    note('render:delivered', { requestId, rendererId: p.rendererId, bytes: payload?.bytes ?? null });
    p.resolve({ requestId, rendererId: p.rendererId, ...payload });
    return true;
  }

  // Cancel a capture the caller no longer wants (e.g. the user closed the
  // round). The renderer is told too, so it does not waste a frame on it.
  function cancel(requestId, reason = 'cancelled') {
    const p = pending.get(requestId);
    if (!p) return false;
    const socket = byId.get(p.rendererId);
    if (socket) wsSend(socket, { kind: 'render-cancel', requestId, reason });
    fail(requestId, reason);
    return true;
  }

  function dispose() {
    for (const id of [...pending.keys()]) fail(id, 'render farm disposed');
    renderers.clear();
    byId.clear();
  }

  return {
    attach, update, detach, list, status, pick,
    capture, captureMotion, deliver, nack, cancel, fail, dispose,
  };
}

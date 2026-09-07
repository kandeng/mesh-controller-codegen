// Render farm client — this tab volunteering as a renderer.
//
// The server deliberately has no WebGL context (it uses three for MATH only:
// buildScene, world transforms, the rigidity battery). So the poses the NBV
// planner chooses are drawn by whichever browser tab already has the model
// loaded, correctly lit, with a live scene. This module is that tab's half of the
// contract; server/render-farm.mjs is the other half.
//
// It owns its OWN socket to /api/events rather than sharing the store's event
// bus. The render channel has a different lifecycle — it must re-announce itself
// after every reconnect, and a dropped capture must never disturb the UI event
// stream — and keeping the two apart means a bug in one cannot take down the
// other. The server keys renderers by socket, so two sockets from one tab simply
// look like two clients; only this one ever says `renderer-hello`.
//
// Split transport, and the reason is a hard limit: @fastify/websocket caps
// maxPayload at 1 MB and a 1024px PNG base64s to roughly 2 MB. COMMANDS arrive
// here over the socket; BYTES go back over REST (POST /api/observe/frame), which
// reuses the 8 MB bodyLimit the server was built with.
import { reactive } from 'vue';
import { useViewerCapture } from './useViewerCapture.js';

const state = reactive({
  connected: false,     // farm socket open
  rendererId: null,     // id the server minted for this tab
  hasModel: false,      // a mesh is loaded and drawable
  glb: null,            // which mesh, so the server can refuse a mismatched plan
  inflight: 0,          // captures being drawn right now
  rendered: 0,          // frames delivered since load
  failed: 0,            // captures refused or lost
  lastError: null,
});

let ws = null;
let attempts = 0;

const send = (obj) => {
  try {
    if (ws && ws.readyState === 1 /* OPEN */) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  } catch { return false; }
};

// Announce (or re-announce) what this tab can draw. Called on socket open and on
// every model change, so the farm never picks a tab that is showing a different
// mesh than the one the plan was made against.
//
// No client-chosen id: the server mints one and returns it in `renderer-welcome`.
// Reusing an id across a reconnect would collide with the stale entry the server
// may not have detached yet, and the fallback would silently rename us anyway.
function announce() {
  const info = useViewerCapture().model() || {};
  state.hasModel = !!info.hasModel;
  state.glb = info.glb || null;
  send({ kind: 'renderer-hello', hasModel: state.hasModel, glb: state.glb, label: `${location.host} tab` });
}

// One capture: draw the pose, then upload the bytes. Every failure path answers
// the server with a `render-ack` so the waiting capture fails FAST instead of
// burning its whole timeout on a frame that will never arrive.
async function onRenderRequest(msg) {
  const nack = (error) => {
    state.failed += 1;
    state.lastError = error;
    send({ kind: 'render-ack', requestId: msg.requestId, ok: false, error });
  };

  state.inflight += 1;
  let frame = null;
  try {
    frame = useViewerCapture().captureAt(msg.view, {
      mode: msg.mode || 'photo',
      focusNodes: msg.focusNodes,
      viewport: msg.viewport,
    });
  } catch (e) {
    nack(`render threw: ${e.message}`);
    return;
  } finally {
    state.inflight -= 1;
  }

  if (!frame?.dataUrl) { nack('renderer produced no frame (no model loaded, or the pose has no eye/target)'); return; }

  try {
    const res = await fetch(msg.frameUrl || '/api/observe/frame', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: msg.requestId,
        round: msg.round ?? 0,
        id: msg.view?.id || msg.requestId,
        mode: msg.mode || frame.mode || 'photo',
        dataUrl: frame.dataUrl,
        mediaType: 'image/png',
        width: frame.width,
        height: frame.height,
        spec: msg.view?.spec ?? null,
        pose: msg.view?.pose ?? null,
        focusNodes: msg.focusNodes ?? null,
        colorMap: frame.colorMap ?? null,
      }),
    });
    if (!res.ok) {
      // 409 means the server stored the frame but nobody was waiting any more —
      // the evidence is safe, so this is a warning, not a failure.
      const text = await res.text();
      if (res.status === 409) { state.rendered += 1; state.lastError = 'frame stored after its capture timed out'; return; }
      throw new Error(`${res.status} ${text.slice(0, 160)}`);
    }
    state.rendered += 1;
    state.lastError = null;
  } catch (e) {
    nack(`frame upload failed: ${e.message}`);
  }
}

// One MOTION FAN (task 18): draw the joint through its angles plus a swept
// composite, then upload the whole fan in ONE body. Same fail-fast discipline as
// onRenderRequest — every refusal answers with a `render-ack` so the waiting
// captureMotion fails immediately instead of burning its timeout. The requestId
// namespaces the ack, so one nack handler serves both single frames and fans.
async function onMotionRequest(msg) {
  const nack = (error) => {
    state.failed += 1;
    state.lastError = error;
    send({ kind: 'render-ack', requestId: msg.requestId, ok: false, error });
  };

  state.inflight += 1;
  let fan = null;
  try {
    fan = useViewerCapture().captureMotion(msg.joint, {
      view: msg.view,
      angles: msg.angles,
      mode: msg.mode || 'photo',
      focusNodes: msg.focusNodes,
      viewport: msg.viewport,
    });
  } catch (e) {
    nack(`motion render threw: ${e.message}`);
    return;
  } finally {
    state.inflight -= 1;
  }

  if (!fan?.frames?.length) { nack('renderer produced no motion fan (no model, no pivot for that joint, or the pose has no eye/target)'); return; }

  try {
    const res = await fetch(msg.motionUrl || '/api/observe/motion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: msg.requestId,
        round: msg.round ?? 0,
        jointId: msg.joint?.id || null,
        angles: fan.angles,
        mode: msg.mode || fan.mode || 'photo',
        view: msg.view ?? null,
        focusNodes: msg.focusNodes ?? null,
        frames: fan.frames.map((f) => ({
          index: f.index, angle: f.angle, tag: f.tag,
          dataUrl: f.dataUrl, width: f.width, height: f.height,
        })),
        composite: fan.composite ? { dataUrl: fan.composite.dataUrl, width: fan.composite.width, height: fan.composite.height, kind: fan.composite.kind } : null,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 409) { state.rendered += 1; state.lastError = 'motion fan stored after its capture timed out'; return; }
      throw new Error(`${res.status} ${text.slice(0, 160)}`);
    }
    state.rendered += 1;
    state.lastError = null;
  } catch (e) {
    nack(`motion upload failed: ${e.message}`);
  }
}

function connect() {
  if (ws) return ws;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/events`);
  ws.onopen = () => { state.connected = true; attempts = 0; announce(); };
  ws.onclose = () => {
    state.connected = false;
    state.rendererId = null;
    state.hasModel = false;   // the server dropped us; do not claim a capability we cannot use
    ws = null;
    // Backoff, capped: the backend is often still booting when the SPA loads.
    attempts = Math.min(attempts + 1, 6);
    setTimeout(connect, 500 * 2 ** attempts);
  };
  ws.onerror = () => { state.connected = false; };
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.kind === 'renderer-welcome') { state.rendererId = msg.rendererId ?? null; return; }
    if (msg.kind === 'render-request') { onRenderRequest(msg); return; }
    if (msg.kind === 'motion-request') { onMotionRequest(msg); return; }
    // `render-cancel` needs no action here: a capture is one synchronous draw,
    // so by the time a cancel arrives the frame is already uploaded or failed.
  };
  return ws;
}

export function useRenderFarm() {
  return {
    state,
    connect,
    // Re-announce after a model load/unload so the farm's `ready` count and its
    // glb check stay true without waiting for a reconnect.
    refresh: announce,
    disconnect() { send({ kind: 'renderer-bye' }); try { ws?.close(); } catch { /* ignore */ } ws = null; },
  };
}

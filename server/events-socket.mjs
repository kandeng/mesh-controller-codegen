// Event-bus -> WebSocket bridge. The kernel already emits typed events for every
// meaningful step (joint:discovered, validate:start/done, generate:start/done,
// asset:registered, diag). We tap bus.onAny and forward a slimmed copy to every
// connected browser, so the Vue UI shows live progress with zero extra plumbing.
// Also exposes app.broadcast() for server-originated messages (round progress,
// status, agent tokens) that are not bus events.
//
// The socket is bidirectional for exactly one purpose: the render farm. A
// browser announces itself as a renderer, and acks or nacks a capture request.
// Frame BYTES never travel here — @fastify/websocket caps maxPayload at 1 MB and
// a 1024px PNG base64s to about 2 MB, so those go over REST instead.
import { wsSend } from './render-farm.mjs';

// Defensive slimming: never ship huge arrays/strings (node dumps, code) over WS.
function slim(evt) {
  const out = {};
  for (const [k, v] of Object.entries(evt)) {
    if (v == null) continue;
    if (typeof v === 'string') out[k] = v.length > 500 ? `${v.slice(0, 500)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.length > 8 ? `[array:${v.length}]` : v;
    else out[k] = `[${typeof v}]`;
  }
  return out;
}

export function registerEventsSocket(app, kernel, farm = null) {
  const clients = new Set();

  const send = wsSend;

  const off = kernel.bus.onAny((evt) => {
    const msg = { kind: 'event', type: evt.type, ts: evt.ts, data: slim(evt) };
    for (const s of clients) send(s, msg);
  });

  app.decorate('broadcast', (obj) => { for (const s of clients) send(s, obj); });

  // Inbound messages. Unknown kinds are ignored on purpose: a newer browser tab
  // talking to an older server must degrade silently, not close the socket that
  // is also carrying every progress event.
  function onMessage(socket, raw) {
    if (!farm) return;
    let msg = null;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.kind) {
      case 'renderer-hello': {
        const entry = farm.attach(socket, msg);
        send(socket, { kind: 'renderer-welcome', rendererId: entry?.id ?? null, farm: farm.status() });
        break;
      }
      case 'renderer-state':
        farm.attach(socket, msg); // attach doubles as update, and self-heals a missed hello
        break;
      case 'renderer-bye':
        farm.detach(socket);
        break;
      case 'render-ack':
        // Only a refusal is interesting; success is proved by the frame arriving.
        if (msg.ok === false) farm.nack(msg.requestId, msg.error || 'renderer refused the capture');
        break;
      default:
        break;
    }
  }

  app.get('/api/events', { websocket: true }, (socket) => {
    clients.add(socket);
    send(socket, { kind: 'hello', plugins: kernel.pluginSummary, runDir: kernel.runDir });
    socket.on('message', (raw) => onMessage(socket, raw));
    socket.on('close', () => { clients.delete(socket); farm?.detach(socket); });
    socket.on('error', () => { clients.delete(socket); farm?.detach(socket); });
  });

  return function dispose() {
    off();
    farm?.dispose();
    for (const s of clients) { try { s.close(); } catch { /* ignore */ } }
    clients.clear();
  };
}

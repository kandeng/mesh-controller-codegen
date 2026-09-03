// Event-bus -> WebSocket bridge. The kernel already emits typed events for every
// meaningful step (joint:discovered, validate:start/done, generate:start/done,
// asset:registered, diag). We tap bus.onAny and forward a slimmed copy to every
// connected browser, so the Vue UI shows live progress with zero extra plumbing.
// Also exposes app.broadcast() for server-originated messages (round progress,
// status, agent tokens) that are not bus events.

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

export function registerEventsSocket(app, kernel) {
  const clients = new Set();

  const send = (socket, obj) => {
    try { if (socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(obj)); } catch { /* drop */ }
  };

  const off = kernel.bus.onAny((evt) => {
    const msg = { kind: 'event', type: evt.type, ts: evt.ts, data: slim(evt) };
    for (const s of clients) send(s, msg);
  });

  app.decorate('broadcast', (obj) => { for (const s of clients) send(s, obj); });

  app.get('/api/events', { websocket: true }, (socket) => {
    clients.add(socket);
    send(socket, { kind: 'hello', plugins: kernel.pluginSummary, runDir: kernel.runDir });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  return function dispose() {
    off();
    for (const s of clients) { try { s.close(); } catch { /* ignore */ } }
    clients.clear();
  };
}

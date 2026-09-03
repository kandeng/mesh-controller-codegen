// Agent route — the DSH-invisible conversational surface. The browser only ever
// sees "the assistant"; this WS bridges to the supervisor (stub in M1, persistent
// DSH web agent in M2). Also exposes GET /api/agent/status for the UI banner.
export function agentRoutes(app, kernel, agent) {
  app.get('/api/agent/status', async () => ({ ok: true, ...agent.status() }));

  app.get('/api/agent', { websocket: true }, (socket) => {
    const send = (obj) => { try { if (socket.readyState === 1) socket.send(JSON.stringify(obj)); } catch { /* drop */ } };
    send({ type: 'ready', mode: agent.mode, contract: agent.contract });

    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return send({ type: 'error', error: 'invalid json' }); }
      if (msg.type === 'status') return send({ type: 'status', ...agent.status() });
      if (msg.type === 'send') {
        const text = String(msg.text || '').trim();
        if (!text) return send({ type: 'error', error: 'empty message' });
        // Persist the user turn for resumability before answering.
        kernel.sessionStore?.append({ role: 'user', text, ts: Date.now() });
        try {
          const r = await agent.send(text);
          kernel.sessionStore?.append({ role: 'assistant', text: r.reply, ts: Date.now() });
          send({ type: 'reply', role: 'assistant', text: r.reply, mode: r.mode });
        } catch (e) {
          send({ type: 'error', error: e.message });
        }
      }
    });
  });
}

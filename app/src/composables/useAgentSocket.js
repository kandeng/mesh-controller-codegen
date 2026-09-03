// Agent socket — the DSH-invisible assistant channel. The user only ever sees a
// chat; underneath this WS talks to the agent supervisor (stub in M1, persistent
// DSH web agent in M2). On init it restores the prior transcript from the stable
// session store so reopening the localhost resumes the conversation.
import { useProjectStore } from './useProjectStore.js';
import { useKernelApi } from './useKernelApi.js';

let ws = null;

export function useAgentSocket() {
  const { state } = useProjectStore();
  const api = useKernelApi();

  function connect() {
    if (ws) return ws;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/agent`);
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === 'ready') { state.agent = { mode: msg.mode }; }
      else if (msg.type === 'reply') { state.transcript.push({ role: 'assistant', text: msg.text, ts: Date.now() }); state.busy = false; }
      else if (msg.type === 'error') { state.transcript.push({ role: 'system', text: `error: ${msg.error}`, ts: Date.now() }); state.busy = false; }
    };
    ws.onclose = () => { ws = null; setTimeout(connect, 2000); };
    return ws;
  }

  function send(text) {
    const t = String(text || '').trim();
    if (!t) return;
    state.transcript.push({ role: 'user', text: t, ts: Date.now() });
    if (ws && ws.readyState === 1) { state.busy = true; ws.send(JSON.stringify({ type: 'send', text: t })); }
    else state.transcript.push({ role: 'system', text: 'assistant not connected', ts: Date.now() });
  }

  // Restore the persisted transcript (resumability across localhost restarts).
  async function resume() {
    try {
      const r = await api.resume();
      if (r.ok && Array.isArray(r.session?.transcript)) state.transcript = r.session.transcript.slice();
    } catch { /* ignore */ }
  }

  return { connect, send, resume };
}

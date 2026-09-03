// Agent socket — the DSH-invisible assistant channel. The user only ever sees a
// chat; underneath this WS talks to the live DSH web agent supervisor (stub
// fallback). Frames: ready | delta (streaming tokens) | tool (activity line) |
// reply (authoritative final) | error. On init it restores the prior transcript
// (with attachment images + tool lines) from the stable session store.
import { useProjectStore } from './useProjectStore.js';
import { useKernelApi } from './useKernelApi.js';

let ws = null;
let streaming = false; // an assistant bubble is being built from deltas

export function useAgentSocket() {
  const { state } = useProjectStore();
  const api = useKernelApi();

  function finalizeStream() {
    if (!streaming) return;
    streaming = false;
    const i = state.transcript.findIndex((m) => m.streaming);
    if (i >= 0) state.transcript.splice(i, 1);
  }

  function connect() {
    if (ws) return ws;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/agent`);
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === 'ready') {
        state.agent = { mode: msg.mode };
      } else if (msg.type === 'delta') {
        // Live tokens: build a provisional bubble; the reply frame replaces it.
        const cur = state.transcript.find((x) => x.streaming);
        if (cur) cur.text += msg.text;
        else { streaming = true; state.transcript.push({ role: 'assistant', text: msg.text, ts: Date.now(), streaming: true }); }
      } else if (msg.type === 'tool') {
        const label = typeof msg.view === 'string' && msg.view ? msg.view : `${msg.kind}${msg.name ? ` ${msg.name}` : ''}`;
        state.transcript.push({ role: 'tool', text: label, ts: Date.now() });
      } else if (msg.type === 'reply') {
        finalizeStream();
        state.transcript.push({ role: 'assistant', text: msg.text, ts: Date.now(), tools: msg.tools });
        state.busy = false;
      } else if (msg.type === 'error') {
        finalizeStream();
        state.transcript.push({ role: 'system', text: `error: ${msg.error}`, ts: Date.now() });
        state.busy = false;
      }
    };
    ws.onclose = () => { ws = null; finalizeStream(); setTimeout(connect, 2000); };
    return ws;
  }

  // attachments: [{ id, url, name }] already uploaded via api.attach()
  function send(text, attachments = []) {
    const t = String(text || '').trim();
    if (!t && !attachments.length) return;
    state.transcript.push({ role: 'user', text: t, ts: Date.now(), attachments: attachments.length ? attachments : undefined });
    if (ws && ws.readyState === 1) {
      state.busy = true;
      ws.send(JSON.stringify({ type: 'send', text: t, attachments: attachments.map((a) => a.id) }));
    } else {
      state.transcript.push({ role: 'system', text: 'assistant not connected', ts: Date.now() });
    }
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

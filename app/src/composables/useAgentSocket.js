// Agent socket — the DSH-invisible assistant channel. The user only ever sees a
// chat; underneath this WS talks to the live DSH web agent supervisor (stub
// fallback). Every tab binds to the SINGLE install session: the server broadcasts
// live frames (delta | tool) and authoritative persisted entries (transcript) to
// all connected tabs, so every tab converges on the same conversation. Frames:
// ready | turn-start | delta | tool | transcript | turn-end | clear | error. On init the
// prior transcript (with attachment images + tool lines) is restored from the
// stable session store; monotonic `seq` numbers dedupe resume vs live frames.
import { useProjectStore } from './useProjectStore.js';
import { useKernelApi } from './useKernelApi.js';

let ws = null;
let streaming = false; // an assistant bubble is being built from deltas
let lastSeq = 0;       // highest persisted-transcript seq applied (dedupe key)

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
      } else if (msg.type === 'turn-start') {
        state.busy = true;
      } else if (msg.type === 'delta') {
        // Live tokens: build a provisional bubble; the transcript entry replaces it.
        const cur = state.transcript.find((x) => x.streaming);
        if (cur) cur.text += msg.text;
        else { streaming = true; state.transcript.push({ role: 'assistant', text: msg.text, ts: Date.now(), streaming: true }); }
      } else if (msg.type === 'tool') {
        const label = typeof msg.view === 'string' && msg.view ? msg.view : `${msg.kind}${msg.name ? ` ${msg.name}` : ''}`;
        state.transcript.push({ role: 'tool', text: label, ts: Date.now() });
      } else if (msg.type === 'transcript') {
        // Authoritative persisted entry (user or assistant). Seq dedupe keeps
        // every tab idempotent no matter which tab sent the message.
        const m = msg.msg;
        if (!m || (m.seq && m.seq <= lastSeq)) return;
        if (m.seq) lastSeq = m.seq;
        if (m.role === 'assistant') finalizeStream();
        state.transcript.push({ ...m });
      } else if (msg.type === 'turn-end') {
        finalizeStream();
        if (msg.mode) state.agent = { mode: msg.mode };
        state.busy = false;
      } else if (msg.type === 'clear') {
        // /clean: the supervisor wiped the persisted transcript; empty every tab.
        // lastSeq stays: the server's seq counter is monotonic across clears.
        finalizeStream();
        state.transcript = [];
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
    if (ws && ws.readyState === 1) {
      // No optimistic push: the server broadcasts the persisted user entry back
      // to every tab (including this one) as a `transcript` frame.
      state.busy = true;
      ws.send(JSON.stringify({ type: 'send', text: t, attachments: attachments.map((a) => a.id) }));
    } else {
      state.transcript.push({ role: 'user', text: t, ts: Date.now(), attachments: attachments.length ? attachments : undefined });
      state.transcript.push({ role: 'system', text: 'assistant not connected', ts: Date.now() });
    }
  }

  // Restore the persisted transcript (resumability across localhost restarts).
  async function resume() {
    try {
      const r = await api.resume();
      if (r.ok && Array.isArray(r.session?.transcript)) {
        state.transcript = r.session.transcript.slice();
        // Converge the dedupe cursor: entries the resume payload just restored
        // must not be re-appended when their live frames arrive (or arrived).
        lastSeq = Math.max(lastSeq, r.session.seq || 0, ...r.session.transcript.map((m) => m.seq || 0));
      }
    } catch { /* ignore */ }
  }

  return { connect, send, resume };
}

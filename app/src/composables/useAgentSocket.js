// Agent socket — the DSH-invisible assistant channel. The user only ever sees a
// chat; underneath this WS talks to the live DSH web agent supervisor (stub
// fallback). Every tab binds to the SINGLE install session: the server broadcasts
// live frames (delta | tool) and authoritative persisted entries (transcript) to
// all connected tabs, so every tab converges on the same conversation. Frames:
// ready | turn-start | delta | tool | transcript | turn-end | notice | clear | error.
// turn-end/error carry `queued` (pending sends behind the finished turn) so the
// composer stays live while the queue drains; `notice` shows transient queue
// hints. On init the
// prior transcript (with attachment images + tool lines) is restored from the
// stable session store; monotonic `seq` numbers dedupe resume vs live frames.
import { useProjectStore } from './useProjectStore.js';
import { useKernelApi } from './useKernelApi.js';

let ws = null;
let streaming = false; // an assistant bubble is being built from deltas
let lastSeq = 0;       // highest persisted-transcript seq applied (dedupe key)
let lastMode = null;   // last announced agent mode (transition detection)

export function useAgentSocket() {
  const { state, notify } = useProjectStore();
  const api = useKernelApi();

  // The shell carries no status chip: a mode CHANGE is news, a mode is not.
  // Booting into stub is the normal cold state (the host boots on first use), so
  // only transitions are worth a sentence in the chat.
  function noteMode(mode) {
    if (!mode || mode === lastMode) { state.agent = { mode: mode || lastMode || 'stub' }; return; }
    const prev = lastMode;
    lastMode = mode;
    state.agent = { mode };
    if (mode === 'live' && prev === 'stub') notify('the assistant host booted — answers now come from the live model');
    if (mode === 'stub' && prev === 'live') notify('the assistant host went away — answers degrade to placeholders until it boots again');
  }

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
        noteMode(msg.mode);
      } else if (msg.type === 'turn-start') {
        state.busy = true;
      } else if (msg.type === 'delta') {
        // Live tokens: build a provisional bubble; the transcript entry replaces it.
        // Deltas arriving after the final turn-end (a cancelled turn's tail) are
        // dropped: they would resurrect a streaming bubble nobody finalizes.
        if (!state.busy) return;
        const cur = state.transcript.find((x) => x.streaming);
        if (cur) cur.text += msg.text;
        else { streaming = true; state.transcript.push({ role: 'assistant', text: msg.text, ts: Date.now(), streaming: true }); }
      } else if (msg.type === 'tool') {
        // One line of the agent's own tool activity, pushed as its own transcript
        // entry so it appears in the order it happened. ChatPanel groups a RUN of
        // these into one foldable log block (first TOOL_LINES open, the rest behind
        // a toggle): a single turn can run 50+ commands, and a raw
        // `bash {"command":…}` line is longer than the answer it produced, so an
        // unfolded log would push that answer off the screen. Kept rather than
        // dropped because it is the only evidence of what the agent actually did.
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
      } else if (msg.type === 'notice') {
        // Transient queue hint ("queued as #2 — runs after…"); not persisted.
        state.notice = msg.text;
      } else if (msg.type === 'turn-end') {
        finalizeStream();
        noteMode(msg.mode);
        state.busy = (msg.queued || 0) > 0; // queue keeps the composer live
        if (!state.busy) state.notice = '';
      } else if (msg.type === 'clear') {
        // /clean: the supervisor wiped the persisted transcript; empty every tab.
        // lastSeq stays: the server's seq counter is monotonic across clears.
        finalizeStream();
        state.transcript = [];
        state.busy = false;
        state.notice = '';
      } else if (msg.type === 'error') {
        finalizeStream();
        state.transcript.push({ role: 'system', text: `error: ${msg.error}`, ts: Date.now() });
        state.busy = (msg.queued || 0) > 0;
      }
    };
    ws.onclose = () => { ws = null; finalizeStream(); setTimeout(connect, 2000); };
    return ws;
  }

  // attachments: [{ id, url, name }] already uploaded via api.attach()
  async function send(text, attachments = []) {
    const t = String(text || '').trim();
    if (!t && !attachments.length) return;

    // The composer ALWAYS talks to the assistant — including while discovery is in
    // flight. There is no special mode any more: the supervisor is a FIFO turn chain,
    // so a send made mid-job simply queues, and the staged orchestrator yields at
    // every boundary (after stage 1, and after each joint) until that queue drains.
    // The consequence is that a request served at a boundary can reshape the rest of
    // the plan (the boundaries re-read the live manifest), which is the whole reason
    // for staging. The old steering-note hijack is retired.
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

  // Stop — one button, one meaning: STOP EVERYTHING, now. The server side does the
  // four things a browser cannot: halt the staged discovery, kill a running
  // controller generation (a separate headless process that no turn cancel can
  // reach), cancel the model turn in flight, and REMOVE the queued messages so
  // nothing resurrects the job that was just stopped.
  //
  // Discovery semantics are unchanged where they matter: the joints already
  // refined STAY committed (each was saved and revisioned at its own boundary) and
  // the rest remain candidates rather than half-checked. What is new is that the
  // look in flight dies with the stop instead of running to its own end first.
  function stop() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));
    else api.abortRefine().catch(() => {}); // socket down: still halt discovery
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

  return { connect, send, resume, stop };
}

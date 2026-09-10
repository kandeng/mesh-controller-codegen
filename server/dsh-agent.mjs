// Persistent DSH agent supervisor — the invisible agent boundary for the app.
//
// LIVE mode (M2): spawns `dsh --profile web --port 0 --no-open` with the
// Bailian + workspace patches, then drives it over the empirically verified
// host-apiproxy wire contract:
//   - unary RPC:  POST /api/<method>  body {type:'client-request', rpcId, method, payload}
//                 -> {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}
//   - live stream: ws://127.0.0.1:<port>/api/events.mux (WEBSOCKET, downlink-only;
//                 a plain GET returns HTTP 426 Upgrade Required). Each WS message is
//                 {type:'server-request', rpcId, method:<frame.type>, payload:<MuxFrame>}.
//                 The frame is msg.payload. NEVER send anything upstream on this socket.
//   - approvals:  'approval/requested' arrives as a MUX FRAME with a STABLE envelope
//                 rpcId; answer via POST /api/respond {type:'client-response',
//                 rpcId:<echo msg.rpcId>, result:{ok:true, value:{sessionId, approvalId,
//                 outcome:'allowed-once'}}}.
// Launcher flags (--profile/--patch) MUST precede web-app flags (--port/--no-open).
// The session cwd is the kernel runDir, which agent-workspace.mjs pre-populates
// with AGENTS.md (persona), kernel-cli.mjs (validate/rig/joints/state tools) and
// the profile patches. We keep the atomic 'workspace-write' preset (sandbox=
// workspace-write, approval=ask) and auto-allow each request here — overriding the
// approval policy alone yields a 'custom' preset that aborts host boot.
//
// Falls back to a STUB reply when the dsh binary is missing or the web host
// fails to start, so the app shell keeps working without the agent.
import { spawn } from 'node:child_process';
import { existsSync, openSync, writeSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { defineAgentContract } from './agent-contract.mjs';
import { writeAgentWorkspace } from './agent-workspace.mjs';

export const STOP_MSG = 'agent turn stopped by user';
export const DROPPED_MSG = 'queued message dropped by user stop';
const STUB_NOTE =
  'The live DSH assistant is unavailable (web host did not start), so this is a stub reply. ' +
  'The app shell remains fully functional: load a mesh, pick a joint, drive its knobs, and validate/generate from the toolbar.';

export function createDshAgent(kernel) {
  const contract = defineAgentContract();
  const cfg = kernel.config;

  let mode = 'stub';            // 'live' once the web host answers
  let child = null;
  let base = null;              // http://127.0.0.1:<port> of the dsh web host
  let sessionId = null;
  let startPromise = null;
  let muxWs = null;             // the downlink-only events.mux WebSocket
  let disposed = false;
  let lastModel = null;         // last model handed to session.selectModel
  let lastAssistantText = '';   // final reply text captured from assistant/message this turn
  let logFd = null;

  // One in-flight turn at a time; later sends chain behind it (mode:'queue'
  // semantics on our side so WS replies stay ordered).
  let chain = Promise.resolve();
  let running = false; // a turn body is executing right now
  let waiting = 0;     // sends chained behind the running turn
  // The sends that have been chained but have NOT started yet, oldest first. A
  // promise chain cannot be spliced, so a queued send is removed from the queue
  // by MARKING it: the body sees the mark the instant the chain reaches it and
  // unwinds without prompting the model. This is the app-level queue — the DSH
  // host's own inbox stays empty because we only ever prompt once the previous
  // turn has ended (turnGate), so draining here drains everything a user typed.
  const queued = [];   // { origin: 'user' | 'lane', dropped }

  const log = (...a) => kernel.diagnostics?.note?.('dsh-agent', { msg: a.join(' ') });

  // ---------------------------------------------------------------- wire ----
  let rpcSeq = 0;
  async function rpc(method, payload, timeoutMs = 30_000) {
    const rpcId = `mcc-${++rpcSeq}`;
    const ctl = new AbortController();
    const killer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        signal: ctl.signal,
      });
      const env = await res.json();
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      if (env?.result?.ok === false) {
        const e = env.result.error;
        throw new Error(`${method}: ${typeof e === 'string' ? e : JSON.stringify(e)}`);
      }
      return env?.result?.value;
    } finally {
      clearTimeout(killer);
    }
  }

  // ------------------------------------------------------- event stream ----
  // events.mux is a downlink-only WebSocket. Each message is
  // {type:'server-request', rpcId, method, payload:<MuxFrame>}. We forward
  // assistant text deltas + tool lines to onEvent, auto-allow any approval
  // request, and resolve the pending turn on turn/end.
  let pendingTurn = null; // { resolve, reject, timer }
  // A turn/end event closes exactly one turn. When we settle pendingTurn
  // WITHOUT an event (user stop, timeout), that turn's late turn/end would
  // otherwise be misattributed to the NEXT prompt's pendingTurn and kill it.
  // The gate holds the next session.prompt back until the outstanding
  // turn/end has been consumed (or a force timeout opens it anyway).
  let turnGate = openGate();
  function openGate() { return { p: Promise.resolve(), open: () => {} }; }
  function closedGate() { let o; const p = new Promise((r) => { o = r; }); return { p, open: () => o() }; }
  function closeGate(forceMs = 5000) {
    const g = closedGate();
    turnGate = g;
    setTimeout(() => g.open(), forceMs); // never wedge the queue on a silent host
  }
  let responding = new Set();
  let turnTools = [];     // per-turn tool activity lines (persisted with the reply)
  const emit = (frame) => { try { agent.onEvent?.(frame); } catch { /* listener went away */ } };

  // f is the MuxFrame (msg.payload). Only session/event frames carry agent events.
  function frameEvent(f) {
    if (f?.type !== 'session/event' || f.sessionId !== sessionId) return;
    const ev = f.event || {};
    const kind = ev.type;
    if (kind === 'assistant/chunk') {
      // Live token delta: data.chunk.type === 'text-delta' -> data.chunk.text
      const chunk = ev.data?.chunk;
      if (chunk?.type === 'text-delta' && chunk.text) emit({ type: 'delta', text: String(chunk.text) });
    } else if (kind === 'assistant/message') {
      // Final content blocks; the authoritative reply text (dsh-headless method).
      const blocks = ev.data?.message?.content;
      if (Array.isArray(blocks)) {
        const joined = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
        if (joined.trim()) lastAssistantText = joined;
      }
    } else if (kind === 'tool/call') {
      const name = ev.data?.name || '';
      const args = typeof ev.data?.arguments === 'string' ? ev.data.arguments : '';
      const line = `${name}${args ? ` ${args.slice(0, 160)}` : ''}`.trim().slice(0, 300);
      if (turnTools.length < 200) turnTools.push(line);
      emit({ type: 'tool', kind, name, view: line });
    } else if (kind === 'tool/result') {
      const msg = ev.data?.message;
      const callId = msg?.source?.callId || ev.data?.callId || null;
      const isError = !!msg?.content?.[0]?.isError;
      emit({ type: 'tool', kind, name: '', callId, isError, view: isError ? 'tool error' : 'tool result' });
    } else if (kind === 'turn/end') {
      // Only a PROMPTED turn may be settled by an event: a late turn/end from
      // a cancelled/timed-out predecessor must not kill the next turn that is
      // still waiting at the gate (it only opens the gate).
      if (pendingTurn?.prompted) {
        const p = pendingTurn; pendingTurn = null; clearTimeout(p.timer);
        if (ev.data?.reason?.kind === 'error') {
          // Surface the host's reason detail — 'agent turn failed' alone is
          // undiagnosable (provider errors, image rejections, etc.).
          const r = ev.data.reason;
          const detail = r.message || r.error?.message
            || (typeof r.error === 'string' ? r.error : '')
            || JSON.stringify(r).slice(0, 300);
          p.reject(new Error(`agent turn failed: ${detail}`.slice(0, 400)));
        }
        else p.resolve();
      }
      turnGate.open(); // the cancelled/timed-out turn's late end lands here too
    } else if (kind === 'error') {
      if (pendingTurn?.prompted) { const p = pendingTurn; pendingTurn = null; clearTimeout(p.timer); p.reject(new Error(ev.data?.message || 'agent turn failed')); }
      turnGate.open();
    }
  }

  // msg is the FULL WebSocket message; approval carries a stable envelope rpcId
  // that MUST be echoed back to /api/respond.
  async function frameApproval(msg) {
    const f = msg?.payload;
    if (f?.type !== 'approval/requested') return;
    const { approvalId } = f;
    const sid = f.sessionId || sessionId;
    if (!approvalId || responding.has(approvalId)) return;
    responding.add(approvalId);
    const rpcId = msg.rpcId; // echo — do NOT mint a new id
    try {
      await fetch(`${base}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-response', rpcId,
          result: { ok: true, value: { sessionId: sid, approvalId, outcome: 'allowed-once' } },
        }),
      });
    } catch (e) { log('approval respond failed:', e.message); }
    finally { setTimeout(() => responding.delete(approvalId), 60_000); }
  }

  function connectMux() {
    const url = `${base.replace(/^http/, 'ws')}/api/events.mux`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { log('mux ws construct failed:', e.message); scheduleReconnect(); return; }
    muxWs = ws;
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(typeof e.data === 'string' ? e.data : ''); } catch { return; }
      frameApproval(msg);            // needs the envelope rpcId
      frameEvent(msg.payload || msg); // the frame lives in msg.payload
    };
    ws.onerror = () => { /* onclose follows; log there to avoid double noise */ };
    ws.onclose = () => { if (muxWs === ws) muxWs = null; scheduleReconnect(); };
  }

  function scheduleReconnect() {
    if (disposed) return;
    if (child && child.exitCode === null) setTimeout(() => { if (!disposed && !muxWs) connectMux(); }, 1000);
  }

  // ------------------------------------------------------------ lifecycle ----
  function spawnWebHost(runDir, patches) {
    return new Promise((res, rej) => {
      const args = [
        '--profile', 'web',
        '--patch', cfg.paths.bailianPatch,
        ...(patches.modelPatch ? ['--patch', patches.modelPatch] : []),
        '--patch', patches.webPatch,
        '--port', '0', '--no-open',
      ];
      const c = spawn(cfg.paths.dshBin, args, {
        cwd: runDir,
        env: { ...process.env, BAILIAN_API_KEY: cfg.apiKey },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      kernel.resources?.trackChild?.(c, 'dsh-web');
      const logFile = resolve(runDir, 'dsh-web.log');
      logFd = openSync(logFile, 'w');
      let settled = false;
      let outBuf = '';
      const fail = (err) => { if (!settled) { settled = true; c.kill('SIGTERM'); rej(err); } };
      const timer = setTimeout(() => fail(new Error(`dsh web host did not announce its port within 30s (see ${logFile})`)), 30_000);

      c.stdout.on('data', (d) => {
        writeSync(logFd, d);
        outBuf += d.toString();
        const m = outBuf.match(/dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)/);
        if (m && !settled) { settled = true; clearTimeout(timer); res({ child: c, base: `http://127.0.0.1:${m[1]}` }); }
      });
      c.stderr.on('data', (d) => writeSync(logFd, d));
      c.on('error', (e) => { clearTimeout(timer); fail(e); });
      c.on('close', (code) => {
        clearTimeout(timer);
        if (!settled) fail(new Error(`dsh web host exited early (code ${code}); see ${logFile}`));
        else { child = null; base = null; mode = 'stub'; log(`web host exited (code ${code}); degrading to stub`); }
      });
    });
  }

  async function selectModel(model) {
    if (!model || model === lastModel) return;
    try { await rpc('session.selectModel', { sessionId, provider: 'bailian', model }); lastModel = model; }
    catch (e) { log('selectModel failed:', e.message); }
  }

  async function start() {
    if (disposed) throw new Error('agent disposed');
    if (mode === 'live' && base) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      if (!existsSync(cfg.paths.dshBin)) throw new Error(`dsh binary not found at ${cfg.paths.dshBin}`);
      const runDir = kernel.runDir;
      const patches = writeAgentWorkspace({
        runDir, port: cfg.viewerPort, model: cfg.model, defaultModel: 'qwen3.8-max',
      });
      const spawned = await spawnWebHost(runDir, patches);
      child = spawned.child; base = spawned.base;

      try {
        // Resume with the persisted sessionId when we have one (session.create is
        // idempotent for same id+cwd); otherwise mint and persist a fresh id.
        const persisted = kernel.sessionStore?.get?.().sessionId;
        const wanted = typeof persisted === 'string' && persisted && persisted !== 'stub-session'
          ? persisted : `mcc-${randomUUID()}`;
        let created;
        try {
          created = await rpc('session.create', { cwd: runDir, sessionId: wanted });
        } catch (e) {
          // A stale id can conflict after host restarts — mint a fresh session.
          if (!/conflict/i.test(e.message)) throw e;
          created = await rpc('session.create', { cwd: runDir, sessionId: `mcc-${randomUUID()}` });
        }
        sessionId = created?.sessionId || wanted;
        kernel.sessionStore?.setSession({ sessionId });
        mode = 'live';
        lastModel = null;
        connectMux();
        log(`live: ${base} session=${sessionId}`);
      } catch (e) {
        // Handshake failed (e.g. an incompatible DSH runtime wire API): tear the
        // spawned host down before degrading to stub — never leak the child.
        try { child?.kill('SIGTERM'); } catch { /* already gone */ }
        child = null; base = null;
        throw e;
      }
    })();
    try { await startPromise; } finally { startPromise = null; }
  }

  async function sendLive(text, images = []) {
    await start();
    turnTools = [];
    lastAssistantText = '';
    // qwen3.8-max (the default) is multimodal, so image turns run on it unless
    // an explicit vision_model override is configured.
    const model = (images.length && cfg.visionModel) ? cfg.visionModel : cfg.model;
    await selectModel(model);

    const content = [{ type: 'text', text }];
    for (const img of images) content.push({ type: 'image', mediaType: img.mediaType, data: img.dataBase64, ...(img.name ? { name: img.name } : {}) });

    const turnDone = new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pendingTurn = null;
        closeGate(); // this turn's late turn/end must not hit the next prompt
        rpc('session.cancel', { sessionId }).catch(() => {});
        rej(new Error('agent turn timed out'));
      }, Math.max(cfg.dshTimeoutMs || 900_000, 300_000));
      pendingTurn = { resolve: res, reject: rej, timer, prompted: false };
    });
    await turnGate.p; // previous turn's end event consumed (or forced) — safe to prompt
    try {
      await rpc('session.prompt', { sessionId, mode: 'queue', content });
    } catch (e) {
      // Don't leak the pending turn if the prompt itself was rejected.
      if (pendingTurn) { clearTimeout(pendingTurn.timer); pendingTurn = null; }
      if (/MODEL_DOES_NOT_SUPPORT_IMAGES|does not support image input/i.test(e.message)) {
        throw new Error(
          `The model "${model}" refused the image (MODEL_DOES_NOT_SUPPORT_IMAGES). The default ` +
          'qwen3.8-max is multimodal and declared with `input: [text, image]` in bailian.patch.yml; if you ' +
          'switched models, declare image input for it there (or set a multimodal "vision_model" in config.json).'
        );
      }
      throw e;
    }
    if (pendingTurn) pendingTurn.prompted = true; // events may now settle this turn
    await turnDone;

    // The authoritative reply is the final assistant/message text captured during
    // the turn (deltas are for live UI only and may be coarser than the final
    // content blocks). Fall back to session.history if we somehow missed it.
    let reply = lastAssistantText.trim();
    if (!reply) {
      try {
        const hist = await rpc('session.history', { sessionId, maxMessages: 20 });
        const events = hist?.events || [];
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i]?.event;
          if (ev?.type === 'assistant/message') {
            const blocks = ev.data?.message?.content;
            if (Array.isArray(blocks)) {
              const joined = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('').trim();
              if (joined) { reply = joined; break; }
            }
          }
        }
      } catch (e) { log('history fallback failed:', e.message); }
    }
    return { reply: reply || '(the assistant produced no text this turn)', tools: turnTools.slice() };
  }

  // ----------------------------------------------------------------- api ----
  // Remove every QUEUED user send from the queue. Lane sends are deliberately
  // left alone: a lane send is an `await` INSIDE the running discovery, so
  // dropping it would strand that await and freeze the orchestrator — discovery
  // is halted through refineAbort instead (see kernel-host.abortRefine).
  function dropQueuedUsers() {
    let n = 0;
    for (const it of queued) if (it.origin === 'user' && !it.dropped) { it.dropped = true; n += 1; }
    return n;
  }

  const agent = {
    get mode() { return mode; },
    contract,

    // WS route installs this; delta/tool frames flow through it as they arrive.
    onEvent: null,

    status() {
      return {
        mode, sessionId, model: cfg.model, visionModel: cfg.visionModel || null,
        dsh: base ? { base, pid: child?.pid ?? null } : null,
        methods: contract.methods,
      };
    },

    async ensureSession() {
      await start();
      return { sessionId, resumed: true };
    },

    // images: [{ mediaType, dataBase64, name? }]
    // opts.origin: 'user' for a send typed in the composer; everything else (the
    // kernel's vision/lane prompts) counts as a 'lane' send. The distinction is
    // what makes a stop safe: only user sends may be dropped from the queue.
    send(text, images = [], opts = {}) {
      const item = { origin: opts?.origin === 'user' ? 'user' : 'lane', dropped: false };
      const behind = running;
      queued.push(item);
      if (behind) waiting += 1;
      const run = chain.then(async () => {
        const at = queued.indexOf(item);
        if (at >= 0) queued.splice(at, 1);
        if (behind) waiting -= 1;
        // Removed from the queue by a stop: never prompt the model, and say so
        // with a marker the WS route can tell apart from a real failure (it
        // owes the tabs a released busy state, not an error bubble).
        if (item.dropped) { const e = new Error(DROPPED_MSG); e.dropped = true; throw e; }
        running = true;
        try {
        if (disposed) throw new Error('agent disposed');
        const wasLive = mode === 'live';
        if (wasLive || existsSync(cfg.paths.dshBin)) {
          try {
            const r = await sendLive(text, images);
            return { role: 'assistant', text, reply: r.reply, tools: r.tools, mode: 'live' };
          } catch (e) {
            if (e.message === STOP_MSG) throw e; // user stop: never stub-mask it
            if (wasLive) throw e; // host was live but the turn failed — surface it
            if (/^agent turn failed/.test(e.message)) {
              // The host DID boot; the turn itself failed at the model provider
              // (e.g. 429 quota exhausted). Surface the real cause — the
              // boot-failure stub note would be a lie here.
              log('turn failed on fresh host:', e.message);
              const detail = e.message.replace(/^agent turn failed:\s*/, '').slice(0, 400);
              const reply = `The live DSH assistant started, but this turn failed at the model provider:\n${detail}\n\nThe app shell remains fully functional: load a mesh, pick a joint, drive its knobs, and validate/generate from the toolbar.\n\nYou said: "${text}"`;
              return { role: 'assistant', text, reply, mode: 'stub' };
            }
            log('start failed, stub fallback:', e.message);
          }
        }
        sessionId = sessionId || 'stub-session';
        const reply = `${STUB_NOTE}\n\nYou said: "${text}"`;
        return { role: 'assistant', text, reply, mode: 'stub' };
        } finally { running = false; }
      });
      chain = run.catch(() => {}); // keep the queue alive after failures
      return run;
    },

    // User-initiated stop: gracefully cancel the in-flight turn on the host
    // (same RPC the timeout path uses) and reject the pending turn so this
    // send unwinds — AND remove the queued user sends, because a stop that left
    // them chained would simply resurrect the job the user just killed. The
    // cancel is AWAITED before rejecting: otherwise the host can apply it to the
    // next queued prompt and kill that turn too.
    // Returns { stopped, dropped }: whether a turn was actually cancelled, and
    // how many queued user sends were removed.
    async stop() {
      const dropped = dropQueuedUsers();
      if (!pendingTurn) return { stopped: false, dropped };
      clearTimeout(pendingTurn.timer);
      const p = pendingTurn;
      pendingTurn = null;
      try { await rpc('session.cancel', { sessionId }, 5_000); } catch (e) { log('session.cancel failed:', e.message); }
      closeGate(); // this turn's late turn/end must not hit the next prompt
      p.reject(new Error(STOP_MSG));
      return { stopped: true, dropped };
    },
    isBusy() { return running || waiting > 0; },
    queueDepth() { return waiting; },

    // Boundary yield for the staged discovery orchestrator: resolves once no turn
    // is running and no send is chained behind one. Ordering never needed this —
    // the FIFO chain already guarantees a queued user turn completes before the
    // next lane prompt — what this buys the orchestrator is a moment where the
    // assistant has the floor to ITSELF (so a served request can reshape the plan)
    // before the next stage's prompt is issued.
    async idle() {
      await chain;
      while (running || waiting > 0) await new Promise((r) => setTimeout(r, 100));
    },

    async dispose() {
      disposed = true;
      try { muxWs?.close(); } catch { /* ignore */ }
      muxWs = null;
      if (pendingTurn) { clearTimeout(pendingTurn.timer); pendingTurn.reject(new Error('agent disposed')); pendingTurn = null; }
      const c = child; child = null; base = null; mode = 'stub';
      if (c && c.exitCode === null) {
        await new Promise((res) => {
          const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } res(); }, 3000);
          c.once('close', () => { clearTimeout(t); res(); });
          try { c.kill('SIGTERM'); } catch { clearTimeout(t); res(); }
        });
      }
      if (logFd !== null) { try { closeSync(logFd); } catch { /* ignore */ } logFd = null; }
    },
  };

  return agent;
}

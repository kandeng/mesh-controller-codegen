// Agent route — the DSH-invisible conversational surface. The browser only ever
// sees "the assistant"; this WS bridges to the live DSH web agent supervisor
// (with a stub fallback). Also owns image intake:
//   POST /api/agent/attach            base64 screenshot -> sessions/attachments/
//   GET  /api/agent/attachments/<id>  bytes back for transcript rendering
//   WS {type:'send', text, attachments:[id]} — server resolves ids to image
//   parts before session.prompt, and streams delta/tool frames back live.
// SINGLE-INSTALL SESSION (option A): every connected tab binds to the one
// session of this install. The server is the source of truth — persisted
// transcript entries are broadcast as `transcript` frames (monotonic `seq`
// makes each tab's apply idempotent), and live delta/tool frames plus
// turn-start/turn-end go to ALL tabs, not just the sender.
//   Frames out: ready | turn-start | delta | tool | transcript | turn-end | error
// Attachments live at a STABLE path (not the per-boot runDir) so persisted
// transcript image URLs still resolve after a server restart. The bytes and the
// id->image-part resolution live in ../attachments.mjs, which the kernel also
// calls when a steered second look folds a screenshot into a vision prompt.
import fastifyStatic from '@fastify/static';
import { COMMANDS, parseSlash, findCommand } from '../slash-commands.mjs';
import { STOP_MSG } from '../dsh-agent.mjs';
import { attachmentsDir, attachmentMeta, readImages, storeImage } from '../attachments.mjs';

export async function agentRoutes(app, kernel, agent) {
  const dir = attachmentsDir(kernel.host.repoRoot);
  await app.register(fastifyStatic, { root: dir, prefix: '/api/agent/attachments/', decorateReply: false });

  const metaOf = (id) => attachmentMeta(dir, id);

  app.post('/api/agent/attach', async (req, reply) => {
    const r = storeImage(dir, req.body || {});
    if (!r.ok) return reply.code(r.code).send({ ok: false, error: r.error });
    return { ok: true, attachmentId: r.attachmentId, url: r.url };
  });

  app.get('/api/agent/status', async () => ({ ok: true, ...agent.status() }));

  // Registry dump for UI affordances (composer autocomplete, docs).
  app.get('/api/agent/commands', async () => ({
    ok: true,
    commands: COMMANDS.map(({ name, usage, desc, example }) => ({ name, usage, desc, example })),
  }));

  // All connected tabs share the single install session: broadcast every live
  // frame and every authoritative transcript entry to every client.
  const clients = new Set();
  const broadcast = (obj) => { for (const s of clients) s(obj); };
  agent.onEvent = (frame) => broadcast(frame);

  app.get('/api/agent', { websocket: true }, (socket) => {
    const send = (obj) => { try { if (socket.readyState === 1) socket.send(JSON.stringify(obj)); } catch { /* drop */ } };
    clients.add(send);
    send({ type: 'ready', mode: agent.mode, contract: agent.contract });
    socket.on('close', () => { clients.delete(send); });

    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return send({ type: 'error', error: 'invalid json' }); }
      if (msg.type === 'status') return send({ type: 'status', ...agent.status() });
      if (msg.type === 'stop') {
        // Stop button / programmatic stop: cancel the in-flight turn on the
        // host; the unwinding send broadcasts the queue-aware turn-end.
        const stopped = await agent.stop();
        const note = stopped ? 'task stopped by user' : 'no task is running — nothing to stop';
        const sysEntry = kernel.sessionStore?.append({ role: 'system', text: note, ts: Date.now() })
          || { role: 'system', text: note, ts: Date.now() };
        broadcast({ type: 'transcript', msg: sysEntry });
        if (!stopped) broadcast({ type: 'turn-end', mode: agent.mode, queued: agent.queueDepth() });
        return;
      }
      if (msg.type === 'send') {
        const text = String(msg.text || '').trim();
        const ids = Array.isArray(msg.attachments) ? msg.attachments : [];
        if (!text && !ids.length) return send({ type: 'error', error: 'empty message' });
        const images = readImages(dir, ids);
        // Slash commands are answered deterministically here (no LLM round-trip).
        // No-arg commands only fire on an exact "/name"; trailing text falls
        // through to the assistant as prose so "/clean up X" cannot misfire.
        // An UNKNOWN "/xxx" is rejected outright with "no such slash command".
        const slash = ids.length ? null : parseSlash(text);
        const found = slash ? findCommand(slash.name) : null;
        const cmd = found && (found.takesArgs || !slash.args) ? found : null;
        // Quiet commands (/stop) emit NO turn frames: they must not disturb
        // the busy state of a live turn they are cancelling.
        const isQuiet = !!(cmd && cmd.quiet);
        if (!isQuiet) broadcast({ type: 'turn-start' });
        // Persist the user turn (with attachment refs) before answering, then
        // broadcast the authoritative entry so every tab appends it exactly once.
        const userEntry = kernel.sessionStore?.append({
          role: 'user', text, ts: Date.now(),
          attachments: images.length ? ids.map((id) => {
            const m = metaOf(id);
            return m ? { id, url: `/api/agent/attachments/${m.file}` } : { id };
          }) : undefined,
        }) || { role: 'user', text, ts: Date.now() };
        broadcast({ type: 'transcript', msg: userEntry });
        if (slash && !found) {
          // Out-of-scope slash command: deterministic notice, never an LLM turn.
          const note = `no such slash command: /${slash.name} — type /help to list available commands.`;
          const sysEntry = kernel.sessionStore?.append({ role: 'system', text: note, ts: Date.now() })
            || { role: 'system', text: note, ts: Date.now() };
          broadcast({ type: 'transcript', msg: sysEntry });
          broadcast({ type: 'turn-end', mode: agent.mode, queued: agent.queueDepth() });
          return;
        }
        if (cmd) {
          try {
            const out = await cmd.run({ kernel, agent, args: slash.args });
            if (out && out.clear) {
              broadcast({ type: 'clear' });
            } else {
              const cmdText = String(out && out.text != null ? out.text : out);
              const cmdEntry = kernel.sessionStore?.append({ role: 'assistant', text: cmdText, ts: Date.now(), command: cmd.name })
                || { role: 'assistant', text: cmdText, ts: Date.now(), command: cmd.name };
              broadcast({ type: 'transcript', msg: cmdEntry });
            }
            if (!isQuiet) broadcast({ type: 'turn-end', mode: agent.mode, queued: agent.queueDepth() });
          } catch (e) {
            broadcast({ type: 'error', error: e.message, queued: agent.queueDepth() });
          }
          return;
        }
        if (agent.isBusy()) {
          broadcast({ type: 'notice', text: `queued as #${agent.queueDepth() + 1} — runs after the current turn finishes` });
        }
        try {
          const r = await agent.send(text, images);
          const asstEntry = kernel.sessionStore?.append({ role: 'assistant', text: r.reply, ts: Date.now(), tools: r.tools || undefined })
            || { role: 'assistant', text: r.reply, ts: Date.now(), tools: r.tools || undefined };
          broadcast({ type: 'transcript', msg: asstEntry });
          broadcast({ type: 'turn-end', mode: r.mode, queued: agent.queueDepth() });
        } catch (e) {
          if (e.message === STOP_MSG) {
            // Stopped turn: the system note already explains it; just release
            // the tabs' busy state (queued sends, if any, keep it true).
            broadcast({ type: 'turn-end', mode: agent.mode, queued: agent.queueDepth() });
            return;
          }
          broadcast({ type: 'error', error: e.message, queued: agent.queueDepth() });
        }
      }
    });
  });
}

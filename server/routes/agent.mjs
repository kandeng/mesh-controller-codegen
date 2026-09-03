// Agent route — the DSH-invisible conversational surface. The browser only ever
// sees "the assistant"; this WS bridges to the live DSH web agent supervisor
// (with a stub fallback). Also owns image intake:
//   POST /api/agent/attach            base64 screenshot -> sessions/attachments/
//   GET  /api/agent/attachments/<id>  bytes back for transcript rendering
//   WS {type:'send', text, attachments:[id]} — server resolves ids to image
//   parts before session.prompt, and streams delta/tool frames back live.
// Attachments live at a STABLE path (not the per-boot runDir) so persisted
// transcript image URLs still resolve after a server restart.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import fastifyStatic from '@fastify/static';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_BYTES = 6 * 1024 * 1024;

export async function agentRoutes(app, kernel, agent) {
  const dir = resolve(kernel.host.repoRoot, 'sessions', 'attachments');
  mkdirSync(dir, { recursive: true });
  await app.register(fastifyStatic, { root: dir, prefix: '/api/agent/attachments/', decorateReply: false });

  const metaOf = (id) => {
    const p = resolve(dir, `${basename(String(id))}.meta.json`);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  };

  // Resolve attachment ids (client refs) into inline image parts for the prompt.
  const resolveImages = (ids) => {
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const meta = metaOf(id);
      if (!meta) continue;
      const file = resolve(dir, meta.file);
      if (!existsSync(file)) continue;
      out.push({ mediaType: meta.mediaType, dataBase64: readFileSync(file).toString('base64'), name: meta.name || null });
    }
    return out;
  };

  app.post('/api/agent/attach', async (req, reply) => {
    const { mediaType, dataBase64, name } = req.body || {};
    if (!IMAGE_TYPES.has(mediaType)) return reply.code(400).send({ ok: false, error: `unsupported mediaType: ${mediaType}` });
    const bytes = Buffer.from(String(dataBase64 || ''), 'base64');
    if (!bytes.length) return reply.code(400).send({ ok: false, error: 'empty image' });
    if (bytes.length > MAX_BYTES) return reply.code(413).send({ ok: false, error: `image too large (max ${MAX_BYTES >> 20}MB)` });
    const id = randomUUID();
    const file = `${id}.${EXT[mediaType]}`;
    writeFileSync(resolve(dir, file), bytes);
    writeFileSync(resolve(dir, `${id}.meta.json`), JSON.stringify({ id, file, mediaType, name: name || null, bytes: bytes.length, ts: Date.now() }, null, 2));
    return { ok: true, attachmentId: id, url: `/api/agent/attachments/${file}` };
  });

  app.get('/api/agent/status', async () => ({ ok: true, ...agent.status() }));

  app.get('/api/agent', { websocket: true }, (socket) => {
    const send = (obj) => { try { if (socket.readyState === 1) socket.send(JSON.stringify(obj)); } catch { /* drop */ } };
    send({ type: 'ready', mode: agent.mode, contract: agent.contract });

    // Live frames from the supervisor: token deltas + tool activity lines.
    // Each WS connection takes over the stream (single-panel UI).
    agent.onEvent = (frame) => send(frame);
    socket.on('close', () => { if (agent.onEvent) agent.onEvent = null; });

    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return send({ type: 'error', error: 'invalid json' }); }
      if (msg.type === 'status') return send({ type: 'status', ...agent.status() });
      if (msg.type === 'send') {
        const text = String(msg.text || '').trim();
        const ids = Array.isArray(msg.attachments) ? msg.attachments : [];
        if (!text && !ids.length) return send({ type: 'error', error: 'empty message' });
        const images = resolveImages(ids);
        // Persist the user turn (with attachment refs) before answering.
        kernel.sessionStore?.append({
          role: 'user', text, ts: Date.now(),
          attachments: images.length ? ids.map((id) => {
            const m = metaOf(id);
            return m ? { id, url: `/api/agent/attachments/${m.file}` } : { id };
          }) : undefined,
        });
        try {
          const r = await agent.send(text, images);
          kernel.sessionStore?.append({ role: 'assistant', text: r.reply, ts: Date.now(), tools: r.tools || undefined });
          send({ type: 'reply', role: 'assistant', text: r.reply, mode: r.mode, tools: r.tools || undefined });
        } catch (e) {
          send({ type: 'error', error: e.message });
        }
      }
    });
  });
}

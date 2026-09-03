// Fastify backend entrypoint. Boots ONE long-lived kernel host, wraps it in REST
// + WebSocket routes, and serves only the static prefixes the viewer needs.
// SECURITY: we deliberately do NOT serve the repo root (it holds config.json with
// the API key and sessions/); only samples, runs, node_modules/three, viewer, and
// the built SPA are exposed.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';

import { createKernelHost } from './kernel-host.mjs';
import { registerEventsSocket } from './events-socket.mjs';
import { projectRoutes } from './routes/project.mjs';
import { jointRoutes } from './routes/joints.mjs';
import { agentRoutes } from './routes/agent.mjs';
import { createDshAgent } from './dsh-agent.mjs';

export async function startServer({ configPath = null, port = 0, verbose = false } = {}) {
  const kernel = await createKernelHost({ configPath, verbose });
  const repoRoot = kernel.host.repoRoot;
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Targeted static mounts (first one keeps decorateReply).
  const mounts = [
    { root: resolve(repoRoot, 'samples'), prefix: '/samples/' },
    { root: resolve(repoRoot, 'runs'), prefix: '/runs/' },
    { root: resolve(repoRoot, 'node_modules'), prefix: '/node_modules/' },
    { root: resolve(repoRoot, 'viewer'), prefix: '/viewer/' },
  ];
  let first = true;
  for (const m of mounts) {
    if (!existsSync(m.root)) continue;
    await app.register(fastifyStatic, { root: m.root, prefix: m.prefix, decorateReply: first, wildcard: true });
    first = false;
  }
  // Serve the built SPA at '/' in production (vite build -> app/dist). In dev the
  // Vite server fronts the app and proxies /api + asset prefixes here.
  const dist = resolve(repoRoot, 'app', 'dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', decorateReply: first, wildcard: true });
  }

  const agent = createDshAgent(kernel);
  const disposeEvents = registerEventsSocket(app, kernel);
  projectRoutes(app, kernel);
  jointRoutes(app, kernel);
  agentRoutes(app, kernel, agent);

  // Resumability + health.
  app.get('/api/session/resume', async () => ({ ok: true, session: kernel.sessionStore.get() }));
  app.get('/api/health', async () => ({ ok: true, plugins: kernel.pluginSummary, runDir: kernel.runDir, agent: agent.status() }));

  const finalPort = port > 0 ? port : kernel.config.viewerPort;
  await app.listen({ host: '127.0.0.1', port: finalPort });
  const address = `http://127.0.0.1:${finalPort}`;
  console.log(`[mcc-server] listening on ${address} (runDir=${kernel.runDir})`);

  const close = async (signal = 'shutdown') => {
    try { disposeEvents(); } catch { /* ignore */ }
    try { await agent.dispose(); } catch { /* ignore */ }
    try { await app.close(); } catch { /* ignore */ }
    try { await kernel.shutdown(signal); } catch { /* ignore */ }
  };
  process.once('SIGINT', () => close('SIGINT').finally(() => process.exit(130)));
  process.once('SIGTERM', () => close('SIGTERM').finally(() => process.exit(143)));

  return { app, kernel, agent, port: finalPort, address, close };
}

// Direct run: node server/index.mjs [--port n] [--config f] [--verbose]
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
  startServer({ configPath: opt('config', null), port: parseInt(opt('port', '0'), 10), verbose: argv.includes('--verbose') })
    .catch((e) => { console.error('[mcc-server] boot failed:', e); process.exit(1); });
}

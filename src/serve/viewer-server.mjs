// Minimal static server for the human visual gate (zero dependencies). It serves
// the repo root so the viewer can reach /viewer/viewer.html, /node_modules/three,
// /samples/*.glb, and the run dir's controller.view.js. In the Vue 3 phase this is
// folded into the Fastify backend (the chosen framework) — same routing, swapped
// implementation. Registered with the resource GC so it always closes.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

export function startViewerServer({ root, port, host }) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'viewer/viewer.html';
      const filePath = resolve(join(root, normalize(pathname)));
      if (!filePath.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
      const s = await stat(filePath).catch(() => null);
      if (!s || !s.isFile()) { res.writeHead(404); return res.end(`not found: ${pathname}`); }
      const data = await readFile(filePath);
      res.writeHead(200, {
        'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });

  return new Promise((res) => {
    server.listen(port, '127.0.0.1', () => {
      host?.resources?.onDispose(() => new Promise((r) => server.close(r)));
      res({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

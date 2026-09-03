// REST client for the Fastify backend. All paths are relative so the Vite dev
// proxy (and the production same-origin mount) both work unchanged.
const asJson = (r) => r.json();
const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
}).then(asJson);
const get = (url) => fetch(url).then(asJson);

export function useKernelApi() {
  return {
    health: () => get('/api/health'),
    state: () => get('/api/state'),
    loadProject: (glb) => post('/api/project', { glb }),
    validate: (file) => post('/api/validate', { file }),
    generate: (opts) => post('/api/generate', opts || {}),
    slots: (id) => get(`/api/joints/${encodeURIComponent(id)}/slots`),
    renders: () => get('/api/renders'),
    resume: () => get('/api/session/resume'),
    agentStatus: () => get('/api/agent/status'),
  };
}

// REST client for the Fastify backend. All paths are relative so the Vite dev
// proxy (and the production same-origin mount) both work unchanged.
const asJson = (r) => r.json();
const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
}).then(asJson);
const get = (url) => fetch(url).then(asJson);

// Status-preserving POST. The observe routes encode WHICH recovery action the
// operator should take in the HTTP code (400 bad request / 404 unknown view /
// 409 conflict / 413 too large / 503 no renderer / 504 renderer too slow), so
// the vision UI needs the number, not just the body.
const postRaw = async (url, body) => {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  let json = null; try { json = await r.json(); } catch { /* non-JSON body */ }
  return { status: r.status, body: json };
};

export function useKernelApi() {
  return {
    health: () => get('/api/health'),
    state: () => get('/api/state'),
    loadProject: (glb) => post('/api/project', { glb }),
    validate: (file) => post('/api/validate', { file }),
    generate: (opts) => post('/api/generate', opts || {}),
    pickFile: (opts) => post('/api/fs/pick', opts || {}),
    slots: (id) => get(`/api/joints/${encodeURIComponent(id)}/slots`),
    joints: () => get('/api/joints'),
    refine: () => post('/api/manifest/refine'),
    // Phase 3: ONE vision round. postRaw, not post — a refusal is a 400/409/502/
    // 503 whose body carries `unmet`, the list of every precondition missing.
    // Throwing that away would leave the UI able to say only "it failed".
    // opts: { round, mode, focus, maxViews, maxFrames, allowGhost }
    visionRefine: (opts) => postRaw('/api/manifest/vision-refine', opts || {}),
    renders: () => get('/api/renders'),
    resume: () => get('/api/session/resume'),
    agentStatus: () => get('/api/agent/status'),
    attach: (mediaType, dataBase64, name) => post('/api/agent/attach', { mediaType, dataBase64, name }),

    // ---- phase 3: vision observation surface -------------------------------
    // Which browser tabs can draw right now. Cheap; the UI polls it to decide
    // whether a vision round is even possible.
    observeFarm: () => get('/api/observe/farm'),
    // Run the NBV planner over the cached parse table and persist the poses.
    // opts: { round, maxViews, mode: 'frontier'|'all'|'none', focus, allowGhost }
    observePlan: (opts) => post('/api/observe/plan', opts || {}),
    // Block until one planned frame comes back from a renderer.
    observeCapture: (opts) => postRaw('/api/observe/capture', opts || {}),
    // Evidence already on disk (survives a server restart).
    observations: () => get('/api/observations'),
    observation: (round) => get(`/api/observations/${Number(round) || 0}`),
    observationColors: (round, id) => get(`/api/observations/${Number(round) || 0}/colors/${encodeURIComponent(id)}`),
  };
}

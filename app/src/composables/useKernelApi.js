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
    // Staged discovery: stop the orchestrator at its NEXT BOUNDARY. Joints already
    // refined stay committed; the rest remain candidates. postRaw — a 409 means no
    // discovery is running, so there is nothing to stop, and the caller needs to know
    // that rather than swallow it. (Reshaping the plan — drop/postpone a candidate —
    // goes through the assistant's /discovery command, not REST.)
    abortRefine: () => postRaw('/api/refine/abort', {}),
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

    // ---- phase 3 task 19: the TIME axis — the revision chain ----------------
    // Every belief-changing write (a loop round, a verdict, an amortization, a
    // rigidity reopen) froze the whole manifest graph as `manifest.r<N>.json`.
    // These three read that chain back: list it (metadata only, no records), load
    // one full snapshot, and diff one against its parent. All read-only, so the
    // 3D scrubber can poll them freely while it replays discovery stop by stop.
    revisions: () => get('/api/revisions'),
    revision: (n) => get(`/api/revisions/${Number(n)}`),
    revisionDiff: (n, against) => get(`/api/revisions/${Number(n)}/diff${against != null ? `?against=${Number(against)}` : ''}`),

    // ---- phase 3 task 17: the human verdict gate ---------------------------
    // Everything the observation panel draws for ONE joint: the frames behind the
    // claim, the reasoning, the uncertainties, the current verdict and the
    // symmetry peers a verdict may be offered to. One call, so the panel is usable
    // the moment a joint is clicked.
    jointEvidence: (id) => get(`/api/joints/${encodeURIComponent(id)}/evidence`),
    // The peer offer on its own, for a panel that only needs to redraw the
    // checkboxes after a verdict rather than re-fetch every thumbnail.
    jointPeers: (id) => get(`/api/joints/${encodeURIComponent(id)}/peers`),
    // The ONLY route to `confirmed`/`rejected`. postRaw, not post: a refusal here
    // is a 400 or a 404 whose body names the field that was turned down and why,
    // and throwing the status away would leave the panel able to say only "it
    // failed" about an edit it could have repaired. Note there is deliberately no
    // 409 — a skipped amortization is a footnote on a verdict that SUCCEEDED, and
    // arrives nested under `amortized`, so the panel must not read it as a failure.
    // body: { decision:'accept'|'reject'|'edit', edits, note, actor, amortizeTo }
    setVerdict: (id, body) => postRaw(`/api/joints/${encodeURIComponent(id)}/verdict`, body || {}),
  };
}

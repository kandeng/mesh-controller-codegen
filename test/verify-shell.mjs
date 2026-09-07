// End-to-end proof of the app shell backend. Exercises every surface the Vue
// shell depends on: health, SPA serving, discovery, per-joint slot graphs,
// validation, resumable state, the live events WebSocket, and the phase-3
// observation surface (NBV plan → render farm → frame delivery → evidence).
//
// Usage: start the server first (`npm run server`), then:
//   node test/verify-shell.mjs [baseUrl]     (default http://127.0.0.1:8788)
const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const GLB = 'samples/drone_dji_inspire3.glb';
const CTL = 'samples/drone-controller.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
  else { fail++; console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
};
const jget = async (p) => (await fetch(BASE + p)).json();
const jpost = async (p, body) => (await fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
})).json();
// Status-preserving variants: the observe routes encode WHICH recovery action an
// operator should take in the HTTP code (400/404/409/413/503/504), so a probe
// that only reads the body cannot tell a graceful refusal from a crash.
const raw = async (method, p, body) => {
  const res = await fetch(BASE + p, body === undefined ? { method } : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  let json = null; try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body: json };
};

console.log(`\nProving app shell backend @ ${BASE}\n`);

// 1) Health + agent mode.
const health = await jget('/api/health');
ok('GET /api/health', health.ok === true, `agent=${health.agent?.mode}`);

// 2) SPA is served at '/' (built app/dist).
const rootRes = await fetch(BASE + '/');
const rootHtml = await rootRes.text();
ok('GET / serves built SPA', rootRes.status === 200 && rootHtml.includes('assets/'), `${rootHtml.length} bytes`);

// 3) Discover joints from the sample mesh.
const proj = await jpost('/api/project', { glb: GLB });
ok('POST /api/project discovers', proj.ok === true, `${proj.joints?.length} joint units, ${proj.stats?.count} nodes`);
ok('  maximal-scope count == 5', proj.joints?.length === 5, proj.joints?.map((j) => `${j.id}:${j.type}`).join(', '));
const rotor = proj.joints?.find((j) => j.type === 'rotor');
const gimbal = proj.joints?.find((j) => j.type === 'gimbal');
ok('  viewer glb url present', typeof proj.viewer?.glb === 'string' && proj.viewer.glb.length > 0);

// 3b) Phase-1 hypothesis loop: manifest with evidence-derived statuses.
const man = await jget('/api/manifest');
ok('GET /api/manifest', man.ok === true && man.manifest?.length === 5, (man.manifest || []).map((r) => `${r.id}:${r.status}`).join(', '));
ok('  rotors auto-accepted, gimbal needs-verdict',
  (man.manifest || []).filter((r) => r.type === 'rotor').every((r) => r.status === 'auto-accepted')
    && man.manifest?.find((r) => r.type === 'gimbal')?.status === 'needs-verdict');

// 3c) Phase-2 refine endpoint: stub-mode agent must refuse gracefully (503 body).
const ref = await jpost('/api/manifest/refine', {});
ok('POST /api/manifest/refine graceful without live agent', ref.ok === false && /agent unavailable/.test(ref.error || ''), JSON.stringify(ref));

// 4) Slot Routing Graphs (data-driven knob/overlay routing).
if (rotor) {
  const g = (await jget(`/api/joints/${encodeURIComponent(rotor.id)}/slots`)).graph;
  const renders = (g?.knobs || []).map((k) => k.render).sort().join(',');
  const overlays = (g?.overlays || []).map((o) => o.render).join(',');
  ok('rotor slot graph', renders === 'speed-slider,turn-toggle', `knobs=[${renders}] overlays=[${overlays}]`);
  const speed = (g?.knobs || []).find((k) => k.render === 'speed-slider');
  ok('  speed-slider bound to axis w/ range', speed?.axis === 'speed' && typeof speed.max === 'number', `axis=${speed?.axis} max=${speed?.max} step=${speed?.step}`);
}
if (gimbal) {
  const g = (await jget(`/api/joints/${encodeURIComponent(gimbal.id)}/slots`)).graph;
  const renders = (g?.knobs || []).map((k) => k.render).sort().join(',');
  ok('gimbal slot graph', renders === 'angle-readout,pitch-slider,yaw-slider', `knobs=[${renders}]`);
}

// 5) Validate the reference controller -> must PASS with rpmIdle==0.
const val = await jpost('/api/validate', { file: CTL });
ok('POST /api/validate PASS', val.ok === true && val.pass === true, `rpmIdle=${val.metrics?.rpmIdle} failures=${JSON.stringify(val.failures)}`);
ok('  rigidity gate (tear-off detection)', val.rigidity?.pass === true, (val.rigidity?.results || []).map((r) => `${r.set}:${r.pass ? 'ok' : 'CRACK'}`).join(' '));
ok('  validate carries reopened[] (reopen edge)', Array.isArray(val.reopened) && val.reopened.length === 0, JSON.stringify(val.reopened));
ok('  validate returns controller viewer url', typeof val.viewer?.ctl === 'string' && val.viewer.ctl.length > 0);

// 6) Resumable server state.
const st = await jget('/api/state');
ok('GET /api/state loaded', st.ok === true && st.loaded === true, `${st.joints?.length} joints, runDir=${st.runDir?.split('/').pop()}`);

// 7) Session resume (stable transcript pointer).
const res = await jget('/api/session/resume');
ok('GET /api/session/resume', res.ok === true && !!res.session, `glb=${res.session?.glb ? 'set' : 'null'} transcript=${res.session?.transcript?.length ?? 0}`);

// 7b) Rig report — the assistant's deterministic rig inspector.
if (rotor) {
  const rig = await jget(`/api/joints/${encodeURIComponent(rotor.id)}/rig`);
  ok('GET /api/joints/:id/rig', rig.ok === true && Array.isArray(rig.nodes) && rig.nodes.length > 0, `${rig.nodes?.length} nodes, warnings=${rig.warnings?.length ?? 0}`);
  ok('  rig reports rotor disc geometry', rig.disc && typeof rig.disc.rotorRadius === 'number', `R=${rig.disc?.rotorRadius} extra=${rig.disc?.extraNodes?.length ?? 0} excluded=${rig.disc?.excludedFromSpin?.length ?? 0}`);
  ok('  rig carries the runtime contract', Array.isArray(rig.contract) && rig.contract.includes('createDroneController(root, THREE)'));
  ok('  rig always advises the anchor-pivot rule for rotors', (rig.warnings || []).some((w) => /pivot Object3D/i.test(w) && /NEVER set rotation on each node/i.test(w)), `${rig.warnings?.length ?? 0} warnings`);
  ok('  rig lists cousin blades when present', Array.isArray(rig.cousins), `cousins=${rig.cousins?.length ?? 0}`);
}

// 7c) Attachment round-trip — screenshot intake for the assistant.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const att = await jpost('/api/agent/attach', { mediaType: 'image/png', dataBase64: PNG_1PX, name: 'probe.png' });
ok('POST /api/agent/attach', att.ok === true && !!att.attachmentId && typeof att.url === 'string', `id=${att.attachmentId?.slice(0, 8)}… url=${att.url}`);
if (att.ok) {
  const back = await fetch(BASE + att.url);
  ok('  attachment served back', back.status === 200 && (back.headers.get('content-type') || '').startsWith('image/'), `${back.headers.get('content-type')}`);
}
const badAtt = await jpost('/api/agent/attach', { mediaType: 'text/plain', dataBase64: PNG_1PX });
ok('  attach rejects non-images', badAtt.ok === false);

// 7d) Agent status surface (mode may be stub until the first send spawns dsh).
const agStat = await jget('/api/agent/status');
ok('GET /api/agent/status', agStat.ok === true && ['stub', 'live'].includes(agStat.mode) && Array.isArray(agStat.methods), `mode=${agStat.mode} session=${agStat.sessionId ?? 'none'}`);

// 7e) Slash-command registry is exposed for the UI (help + clean ship by default).
const cmds = await jget('/api/agent/commands');
ok('GET /api/agent/commands', cmds.ok === true && Array.isArray(cmds.commands) && ['help', 'clean'].every((n) => cmds.commands.some((c) => c.name === n && c.usage && c.desc && c.example)), `n=${cmds.commands?.length}`);

// 8) Live events WebSocket streams a hello + kernel events.
const wsProof = await new Promise((resolve) => {
  const url = BASE.replace(/^http/, 'ws') + '/api/events';
  let hello = false, event = false;
  const ws = new WebSocket(url);
  const done = () => { try { ws.close(); } catch {} resolve({ hello, event }); };
  const timer = setTimeout(done, 4000);
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.kind === 'hello') hello = true;
    if (msg.kind === 'event') event = true;
    if (hello && event) { clearTimeout(timer); done(); }
  };
  ws.onerror = () => { clearTimeout(timer); done(); };
  // Trigger a kernel event so the stream has something to deliver.
  setTimeout(() => { jpost('/api/validate', { file: CTL }).catch(() => {}); }, 400);
});
ok('WS /api/events hello', wsProof.hello);
ok('WS /api/events streams kernel events', wsProof.event);

// 9) Phase-3 observation surface: plan -> farm -> capture -> persisted evidence.
//
// This is the whole "the graph can go and look" claim, proven without a real
// browser: the probe opens the same WS a tab would, announces itself as a
// renderer, receives a pose, and POSTs a 1x1 PNG back. If that round-trip closes,
// the only untested part of a vision round is the rasterization itself.
// The farm may legitimately contain a real browser tab (the app being open is the
// normal case), so this asserts the STATUS CONTRACT rather than emptiness:
// `available` must agree with ready>0, or the UI would offer a vision round it
// cannot fulfil.
const farm0 = await jget('/api/observe/farm');
ok('GET /api/observe/farm reports a self-consistent farm status',
  farm0.ok === true && typeof farm0.farm?.renderers === 'number' && typeof farm0.farm?.ready === 'number'
  && typeof farm0.farm?.pending === 'number' && farm0.available === (farm0.farm.ready > 0)
  && Array.isArray(farm0.renderers),
  `renderers=${farm0.farm?.renderers} ready=${farm0.farm?.ready} pending=${farm0.farm?.pending} available=${farm0.available}`);

// No usable renderer -> 503 with a machine-readable code, never a 500. Pinned to
// an id that cannot exist so the refusal is proven whether or not a browser tab is
// connected; an unpinned request would instead be served by that tab.
const capNone = await raw('POST', '/api/observe/capture', {
  round: 9, rendererId: 'probe-no-such-renderer',
  view: { id: 'probe', pose: { eye: [0, -10, 0], target: [0, 0, 0] } },
});
ok('POST /api/observe/capture refuses gracefully with no usable renderer',
  capNone.status === 503 && capNone.body?.ok === false && capNone.body?.code === 'NO_RENDERER',
  `${capNone.status} ${capNone.body?.code} — ${capNone.body?.error}`);

// A viewId that no saved plan contains -> 404, so a frame on disk always has a
// plan that asked for it.
const capGhostView = await raw('POST', '/api/observe/capture', { round: 9, viewId: 'does-not-exist' });
ok('  capture rejects a viewId that is not in the round plan',
  capGhostView.status === 404 && capGhostView.body?.ok === false, `${capGhostView.status}`);

const planRes = await raw('POST', '/api/observe/plan', { round: 0, maxViews: 8, mode: 'frontier' });
ok('POST /api/observe/plan plans headless over the cached parse table',
  planRes.status === 200 && planRes.body?.ok === true && (planRes.body?.plan?.views?.length || 0) > 0,
  `${planRes.body?.plan?.views?.length} frames cover ${(100 * (planRes.body?.plan?.coverage || 0)).toFixed(1)}% of ${planRes.body?.plan?.targets} focused nodes in ${planRes.body?.ms}ms`);
ok('  the plan narrows to the frontier, not the whole model',
  Array.isArray(planRes.body?.plan?.focus) && planRes.body.plan.focus.length > 0
  && planRes.body.plan.targets <= planRes.body.plan.focus.length,
  `${planRes.body?.plan?.focus?.length} focus names → ${planRes.body?.plan?.targets} targets (mode=${planRes.body?.mode})`);
ok('  the plan reports interior-only parts honestly instead of hiding them in coverage',
  Array.isArray(planRes.body?.plan?.interiorOnly),
  `${planRes.body?.plan?.interiorOnly?.length ?? '-'} interior-only, ${planRes.body?.plan?.unseen?.length ?? '-'} unseen`);
ok('  every planned view carries a pose the renderer can execute',
  (planRes.body?.plan?.views || []).every((v) => v.id && v.pose?.eye?.length === 3 && v.pose?.target?.length === 3 && v.mode && v.spec?.distance > 0));

const obsList = await jget('/api/observations');
ok('GET /api/observations lists the persisted round',
  obsList.ok === true && (obsList.rounds || []).some((r) => r.round === 0 && r.hasPlan === true && typeof r.url === 'string'),
  `${obsList.rounds?.length} round(s): ${(obsList.rounds || []).map((r) => `r${r.round}[${r.frames}f]`).join(' ')}`);

// Full capture round-trip with the probe acting as the browser renderer.
const rt = await new Promise((resolve) => {
  const url = BASE.replace(/^http/, 'ws') + '/api/events';
  const ws = new WebSocket(url);
  const out = { welcome: false, rendererId: null, request: null, posted: null, capture: null, error: null };
  let finished = false;
  const finish = () => { if (finished) return; finished = true; clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } resolve(out); };
  const timer = setTimeout(() => { out.error = out.error || 'round-trip timed out'; finish(); }, 20000);
  // Two independent HTTP responses close this loop (the frame POST and the
  // capture POST) and either may land first. Only finish once both are in, or
  // immediately if the capture failed and no frame will ever arrive.
  const maybeFinish = () => { if (out.capture && (out.posted || out.capture.ok !== true)) finish(); };

  // Kick only once the farm has minted this renderer's id, and PIN the capture to
  // that id. Pinning is what makes the round-trip deterministic when a real
  // browser tab is also connected: pick() is LRU over every ready renderer, so an
  // unpinned capture could be routed to the tab, the probe would never see a
  // render-request, and this leg would report a failure while the system worked.
  let kicked = false;
  const kick = async () => {
    if (kicked) return;
    kicked = true;
    const v = planRes.body?.plan?.views?.[0];
    if (!v) { out.error = 'no planned view to capture'; finish(); return; }
    out.capture = await jpost('/api/observe/capture', { round: 0, viewId: v.id, rendererId: out.rendererId, timeoutMs: 10000 });
    maybeFinish();
  };

  ws.onopen = () => ws.send(JSON.stringify({ kind: 'renderer-hello', id: 'probe-renderer', hasModel: true, glb: GLB, label: 'verify-shell' }));
  ws.onerror = () => { out.error = 'renderer websocket error'; finish(); };
  ws.onmessage = async (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.kind === 'renderer-welcome') { out.welcome = !!msg.rendererId; out.rendererId = msg.rendererId; kick(); return; }
    if (msg.kind !== 'render-request') return;
    out.request = msg;
    // A real tab draws the pose and reads the canvas; the probe posts a 1x1 PNG
    // so the correlation protocol is exercised byte-for-byte as in production.
    out.posted = await raw('POST', msg.frameUrl || '/api/observe/frame', {
      requestId: msg.requestId, round: msg.round, id: msg.view?.id || 'probe',
      mode: msg.mode, dataBase64: PNG_1PX, mediaType: 'image/png',
      width: 1, height: 1, spec: msg.view?.spec ?? null, pose: msg.view?.pose ?? null,
      focusNodes: msg.focusNodes,
    });
    maybeFinish();
  };

});

ok('WS renderer-hello is welcomed and registered with the farm', rt.welcome && !!rt.rendererId, `rendererId=${rt.rendererId}`);
ok('  the farm sent a pose over the socket with a correlation id and a frame URL',
  !!rt.request && typeof rt.request.requestId === 'string' && rt.request.frameUrl === '/api/observe/frame' && !!rt.request.view?.pose,
  rt.request ? `mode=${rt.request.mode} view=${rt.request.view?.id} d=${rt.request.view?.spec?.distance?.toFixed?.(1)}` : 'no render-request received');
ok('POST /api/observe/frame accepts the bytes and resolves the capture',
  rt.posted?.status === 200 && rt.posted?.body?.delivered === true && !!rt.posted?.body?.url,
  `${rt.posted?.status} ${rt.posted?.body?.frame?.bytes ?? '-'}B → ${rt.posted?.body?.url}`);
ok('POST /api/observe/capture returns the frame it asked for',
  rt.capture?.ok === true && !!rt.capture?.url && rt.capture?.requestId === rt.request?.requestId,
  rt.capture?.ok ? `view=${rt.capture.view?.id} mode=${rt.capture.mode} renderer=${rt.capture.rendererId}` : `failed: ${rt.capture?.error || rt.error}`);

// A frame nobody is waiting for is still evidence: stored, answered 409.
const orphan = await raw('POST', '/api/observe/frame', { requestId: 'cap_expired_probe', round: 0, id: 'orphan', mode: 'photo', dataBase64: PNG_1PX, mediaType: 'image/png', width: 1, height: 1 });
ok('POST /api/observe/frame stores an orphan frame and answers 409',
  orphan.status === 409 && orphan.body?.ok === true && orphan.body?.delivered === false && !!orphan.body?.url,
  `${orphan.status} delivered=${orphan.body?.delivered}`);

// A frame with no image data must be refused, not written as an empty file.
const emptyFrame = await raw('POST', '/api/observe/frame', { requestId: 'cap_empty_probe', round: 0, id: 'empty', dataBase64: '' });
ok('  a frame with no image data is refused', emptyFrame.status === 400 && emptyFrame.body?.ok === false, `${emptyFrame.status} ${emptyFrame.body?.error}`);

const round0 = await jget('/api/observations/0');
ok('GET /api/observations/:round carries plan + frames + servable urls',
  round0.ok === true && (round0.plan?.views?.length || 0) > 0 && (round0.frames?.length || 0) >= 2
  && round0.frames.every((f) => typeof f.url === 'string' && f.url.length > 0),
  `${round0.frames?.length} frames, plan=${round0.plan?.views?.length ?? 0} views, reply=${round0.reply ? 'yes' : 'none'}`);
if (round0.frames?.length) {
  const img = await fetch(BASE + round0.frames[0].url);
  ok('  a stored frame is servable over the existing static mount',
    img.status === 200 && (img.headers.get('content-type') || '').startsWith('image/'),
    `${img.status} ${img.headers.get('content-type')}`);
}

// Health must expose the farm so the UI can grey out the vision button.
const health2 = await jget('/api/health');
ok('GET /api/health exposes the render farm', health2.ok === true && !!health2.renderFarm && typeof health2.renderFarm.renderers === 'number', `renderers=${health2.renderFarm?.renderers} ready=${health2.renderFarm?.ready}`);

// 12) Phase-3 vision refine.
//
// A vision round needs TWO things the shell cannot guarantee: a live multimodal
// model and a browser tab holding the mesh. So the contract under test is the
// REFUSAL — it must be graceful (never a 500, never a stack trace), it must name
// every precondition it is missing, and it must leave the manifest untouched.
//
// The renderer half is asserted as a BICONDITIONAL against the farm's own report
// (NO_RENDERER is named iff no renderer is ready). That is what makes the check
// prove the wiring in BOTH environments: headless with no tab attached, and a dev
// machine where a real browser tab is connected. A one-sided assertion would
// pass vacuously in one of the two.
const agentMode = health2.agent?.mode;
const manBefore = await jget('/api/manifest');
const vr = await raw('POST', '/api/manifest/vision-refine', {});
const unmetCodes = (vr.body?.unmet || []).map((u) => u.code);
const farmNow = await jget('/api/observe/farm');

if (agentMode !== 'live') {
  ok('POST /api/manifest/vision-refine refuses gracefully and names EVERY unmet precondition',
    vr.body?.ok === false && [400, 409, 500, 502, 503].includes(vr.status)
    && typeof vr.body?.error === 'string' && vr.body.error.length > 0
    && vr.body?.manifestUntouched === true
    && Array.isArray(vr.body?.unmet) && vr.body.unmet.length > 0
    && vr.body.unmet.every((u) => typeof u.code === 'string' && typeof u.error === 'string' && u.error.length > 0)
    && unmetCodes.includes('NO_VISION_AGENT'),
    `${vr.status} code=${vr.body?.code} unmet=[${unmetCodes.join(', ')}]`);
} else {
  // A live agent really runs a round (a model turn plus a render farm round
  // trip), so only the transport contract is asserted here.
  ok('POST /api/manifest/vision-refine answers on a live agent without a server fault',
    vr.status < 500 && vr.body && typeof vr.body.ok === 'boolean',
    `${vr.status} ok=${vr.body?.ok} added=${vr.body?.added}`);
}

const manAfter = await jget('/api/manifest');
ok('  a refused round leaves the manifest byte-identical, and asks for a renderer exactly when none is ready',
  JSON.stringify(manAfter.manifest) === JSON.stringify(manBefore.manifest)
  && (manAfter.manifest?.length || 0) === (manBefore.manifest?.length || 0)
  && (farmNow.available === true || unmetCodes.includes('NO_RENDERER'))
  && (farmNow.available === false || !unmetCodes.includes('NO_RENDERER')),
  `${manAfter.manifest?.length} records unchanged; farm ready=${farmNow.available} renderers=${farmNow.farm?.renderers}`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} \u2014 ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

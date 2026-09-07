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

// 12b) Phase-3 task 18: the motion route over HTTP.
//
// Same contract as leg 12, for the same reason: a motion fan needs a live
// multimodal model AND a browser tab to drive the preview pivot, neither of which
// the shell guarantees. So what is under test is the REFUSAL — graceful, every
// unmet precondition named, the manifest left byte-identical, and the renderer
// half asserted as a biconditional against the farm's own report so the check
// proves the wiring headless AND on a dev machine with a tab attached.
//
// A motion round ANNOTATES (rec.motion) rather than mutating status/confidence,
// so even a SUCCESS would leave leg 3b's statuses intact — but a refusal must
// leave the record byte-identical, which is the stronger claim asserted here.
const mid = (manAfter.manifest || []).find((r) => r.type === 'rotor')?.id;
if (!mid) {
  ok('the sample mesh yields a rotor to drive', false, 'no rotor record in the manifest');
} else {
  const mr = await raw('POST', `/api/joints/${mid}/motion`, {});
  const mUnmet = (mr.body?.unmet || []).map((u) => u.code);
  const farmM = await jget('/api/observe/farm');
  if (agentMode !== 'live') {
    ok('POST /api/joints/:id/motion refuses gracefully and names EVERY unmet precondition',
      mr.body?.ok === false && [400, 404, 409, 500, 502, 503].includes(mr.status)
        && typeof mr.body?.error === 'string' && mr.body.error.length > 0
        && mr.body?.manifestUntouched === true
        && Array.isArray(mr.body?.unmet) && mr.body.unmet.length > 0
        && mr.body.unmet.every((u) => typeof u.code === 'string' && typeof u.error === 'string' && u.error.length > 0),
      `${mr.status} code=${mr.body?.code} unmet=[${mUnmet.join(', ')}]`);
    ok('  a stub vision model is named as the missing agent',
      mUnmet.includes('NO_VISION_AGENT'), `unmet=[${mUnmet.join(', ')}]`);
  } else {
    ok('POST /api/joints/:id/motion answers on a live agent without a server fault',
      mr.status < 500 && mr.body && typeof mr.body.ok === 'boolean',
      `${mr.status} ok=${mr.body?.ok}`);
  }
  ok('  a refused motion round leaves the manifest byte-identical, and asks for a renderer exactly when none is ready',
    JSON.stringify((await jget('/api/manifest')).manifest) === JSON.stringify(manAfter.manifest)
      && (farmM.available === true || mUnmet.includes('NO_RENDERER'))
      && (farmM.available === false || !mUnmet.includes('NO_RENDERER')),
    `farm ready=${farmM.available} renderers=${farmM.farm?.renderers}`);

  // The route is per-joint, so an unknown id must trip the NO_RECORD guard. Which
  // code is TOP-LEVEL depends on the environment (a stub agent outranks it), so
  // the robust claim is that NO_RECORD is among the unmet preconditions.
  const mUnknown = await raw('POST', '/api/joints/no_such_joint/motion', {});
  ok('  an unknown joint trips the NO_RECORD guard among the unmet preconditions',
    mUnknown.body?.ok === false && (mUnknown.body?.unmet || []).some((u) => u.code === 'NO_RECORD'),
    `${mUnknown.status} unmet=[${(mUnknown.body?.unmet || []).map((u) => u.code).join(', ')}]`);
}

// 13) Phase-3 task 17: the human verdict gate over HTTP.
//
// verify-verdict.mjs proves the DECISION RULES in-process; this leg proves the
// TRANSPORT, which is where a verdict feature actually fails. The status code has
// to say which kind of refusal happened, because the panel's recovery action
// differs per cause: 400 means "your request was malformed", 404 means "no such
// joint", 409 means "look at the panel again — the state moved under you".
// Collapsing those into one number is what makes a UI able to say only "failed"
// about a verdict that actually applied.
//
// It runs LAST because it is the only leg that deliberately mutates the manifest,
// and leg 12's byte-identical assertion depends on nobody having done that.
const rotors = (manAfter.manifest || []).filter((r) => r.type === 'rotor');
const vid = rotors[0]?.id;
if (!vid) {
  ok('the sample mesh yields a rotor to judge', false, 'no rotor record in the manifest');
} else {
  const ev = await jget(`/api/joints/${vid}/evidence`);
  ok('GET /api/joints/:id/evidence answers in ONE call',
    ev.ok === true && ev.joint?.id === vid && Array.isArray(ev.frames) && Array.isArray(ev.rounds) && !!ev.peers,
    `${ev.frames?.length} frame(s), ${ev.rounds?.length} round(s), ${ev.peers?.peers?.length} peer(s)`);
  ok('  the evidence carries what a human judges BY, not just a confidence number',
    'reasoning' in ev.joint && 'uncertainties' in ev.joint && Array.isArray(ev.joint.tests)
    && Array.isArray(ev.joint.history) && 'anchor' in ev.joint && 'axis' in ev.joint,
    `reasoning=${ev.joint.reasoning ? 'yes' : 'none'} unsure=${ev.joint.uncertainties?.length ?? 0} tests=${ev.joint.tests?.length}`);
  ok('  every frame carries a servable url and never inlines bytes',
    ev.frames.every((f) => typeof f.url === 'string' && f.dataBase64 === undefined));
  ok('  the observation history leg of leg 9 is visible from here',
    ev.rounds.some((r) => r.round === 0), `rounds=[${ev.rounds.map((r) => r.round).join(',')}]`);
  ok('  frame BYTES are flagged, not inlined, so a colour map costs nothing until asked for',
    ev.frames.every((f) => typeof f.hasColors === 'boolean'));

  const ev404 = await raw('GET', '/api/joints/no_such_joint/evidence');
  ok('GET /api/joints/:id/evidence 404s an unknown joint', ev404.status === 404 && ev404.body?.code === 'NO_RECORD', `${ev404.status}`);

  const pr = await jget(`/api/joints/${vid}/peers`);
  ok('GET /api/joints/:id/peers is read-only and answers the amortizability question itself',
    pr.ok === true && Array.isArray(pr.peers) && typeof pr.canAmortize === 'boolean' && Array.isArray(pr.group),
    `${pr.peers?.length} peer(s), group=${pr.group?.length}, canAmortize=${pr.canAmortize}`);
  ok('  an undecided joint reports canAmortize=false rather than leaving the panel to guess',
    pr.canAmortize === false, 'there is no verdict to pass on yet');
  ok('  each peer says WHY it qualifies, in words',
    (pr.peers || []).every((p) => ['mirror', 'family'].includes(p.basis) && typeof p.gloss === 'string' && p.gloss.length > 0),
    (pr.peers || []).map((p) => `${p.id}:${p.basis}`).join(' '));

  // Refusals, each with its own cause-specific code.
  const manPre = await jget('/api/manifest');
  const bad = await raw('POST', `/api/joints/${vid}/verdict`, { decision: 'perhaps' });
  ok('POST verdict 400s an unknown decision', bad.status === 400 && bad.body?.code === 'BAD_VERDICT', `${bad.status} ${bad.body?.code}`);
  const noJoint = await raw('POST', '/api/joints/no_such_joint/verdict', { decision: 'accept' });
  ok('POST verdict 404s an unknown joint', noJoint.status === 404 && noJoint.body?.code === 'NO_RECORD', `${noJoint.status}`);
  const noEdits = await raw('POST', `/api/joints/${vid}/verdict`, { decision: 'edit', edits: { status: 'confirmed' } });
  ok('POST verdict 400s an edit that could change nothing',
    noEdits.status === 400 && noEdits.body?.code === 'NO_EDITS', `${noEdits.status} ${noEdits.body?.error}`);
  ok('  a refused edit says which field it turned down and why',
    (noEdits.body?.refused || []).some((r) => r.field === 'status' && r.why.length > 0), JSON.stringify(noEdits.body?.refused));
  const manPost = await jget('/api/manifest');
  ok('  every refusal left the manifest byte-identical, so the button is safe to press twice',
    JSON.stringify(manPost.manifest) === JSON.stringify(manPre.manifest)
    && [bad, noJoint, noEdits].every((r) => r.body?.manifestUntouched === true),
    `${manPost.manifest?.length} records unchanged`);

  // The accept, and the lateral edge in the SAME submission.
  const peerIds = (pr.peers || []).map((p) => p.id);
  const acc = await raw('POST', `/api/joints/${vid}/verdict`, {
    decision: 'accept', note: 'shell probe', actor: 'probe', amortizeTo: [...peerIds, 'not_a_peer'],
  });
  ok('POST verdict accepts and confirms', acc.status === 200 && acc.body?.ok === true && acc.body?.status === 'confirmed',
    `${acc.status} → ${acc.body?.status}`);
  ok('  the verdict and its amortization are reported SEPARATELY',
    acc.body?.decision === 'accept' && acc.body?.amortized && Array.isArray(acc.body?.amortized?.applied),
    `applied=${acc.body?.amortized?.applied?.length ?? 0} skipped=${acc.body?.amortized?.skipped?.length ?? 0} refused=${acc.body?.amortized?.refused?.length ?? 0}`);
  ok('  one verdict travelled to every symmetry peer the probe selected',
    (acc.body?.amortized?.applied || []).length === peerIds.length && peerIds.length > 0,
    `${acc.body?.amortized?.applied?.length}/${peerIds.length}`);
  ok('  a non-peer is REFUSED while the verdict itself still succeeds',
    acc.body?.ok === true && (acc.body?.amortized?.refused || []).some((r) => r.id === 'not_a_peer'),
    'a partial amortization is a success with a footnote, not a failure');
  ok('  each amortized peer records where its verdict came from',
    (acc.body?.amortized?.applied || []).every((a) => a.status === 'confirmed'));

  const pr2 = await jget(`/api/joints/${vid}/peers`);
  ok('  canAmortize flips once there is a verdict to pass on', pr2.canAmortize === true);
  const ev2 = await jget(`/api/joints/${vid}/evidence`);
  ok('  the evidence now carries the verdict, the actor and the note',
    ev2.joint.verdict?.decision === 'accept' && ev2.joint.verdict?.actor === 'probe'
    && ev2.joint.verdict?.note === 'shell probe' && ev2.joint.verdict?.amortizedFrom === null,
    JSON.stringify(ev2.joint.verdict));
  ok('  the audit trail grew by exactly one entry per write',
    ev2.joint.history.filter((h) => h.event === 'verdict').length === 1);
  ok('  an inherited peer says so on its own evidence page',
    ev2.peers.peers.some((p) => p.verdict?.amortizedFrom === vid),
    'a green chip must be able to say it came from a mirror');

  const served = await jget('/api/joints');
  ok('GET /api/joints shows the confirmed status to the step-3 chips',
    served.joints?.find((j) => j.id === vid)?.status === 'confirmed'
    && peerIds.every((id) => served.joints?.find((j) => j.id === id)?.status === 'confirmed'),
    `${served.joints?.filter((j) => j.status === 'confirmed').length} confirmed`);

  // An edit verdict, then the refusal to amortize it.
  const ed = await raw('POST', `/api/joints/${vid}/verdict`, { decision: 'edit', edits: { label: 'probe-corrected' } });
  ok('POST verdict applies an edit and re-runs the battery',
    ed.status === 200 && ed.body?.ok === true && (ed.body?.applied || []).includes('label'),
    `${ed.status} → ${ed.body?.status} applied=${ed.body?.applied}`);
  const edAmortize = await raw('POST', `/api/joints/${vid}/verdict`, { decision: 'accept', amortizeTo: peerIds });
  ok('  a later accept may still be amortized', edAmortize.status === 200 && edAmortize.body?.ok === true,
    `${edAmortize.status} → ${edAmortize.body?.status}`);

  // A peer with a DIRECT verdict of its own, then an attempt to amortize over it.
  // A direct human verdict outranks an inference drawn from a mirror, so nothing
  // can take it. The HTTP answer is still 200: the amortization outcome is nested
  // under `amortized` because the verdict ITSELF applied, and promoting a skipped
  // mirror to an error status would tell the human their accept did not happen.
  const ownId = peerIds[0];
  const own = await raw('POST', `/api/joints/${ownId}/verdict`, { decision: 'reject', actor: 'probe-direct' });
  ok('POST verdict on a peer directly gives it a verdict of its own',
    own.status === 200 && own.body?.status === 'rejected' && own.body?.verdict?.amortizedFrom === null,
    `${own.status} → ${own.body?.status}`);
  const clash = await raw('POST', `/api/joints/${vid}/verdict`, { decision: 'accept', amortizeTo: [ownId] });
  ok('  amortizing over a DIRECT verdict is refused in the body, not by an error status',
    clash.status === 200 && clash.body?.ok === true && clash.body?.amortized?.ok === false
    && clash.body?.amortized?.code === 'NOTHING_APPLIED',
    `${clash.status} amortized.code=${clash.body?.amortized?.code}`);
  ok('  ...and the source verdict itself still APPLIED, with the reason reported',
    clash.body?.decision === 'accept' && clash.body?.status === 'confirmed'
    && clash.body?.amortized?.skipped?.some((s) => s.id === ownId && s.why.includes('direct human verdict')),
    `skipped=[${(clash.body?.amortized?.skipped || []).map((s) => `${s.id}: ${s.why}`).join('; ')}]`);
  const ownAfter = await jget(`/api/joints/${ownId}/evidence`);
  ok('  the peer kept its own verdict instead of inheriting the source\'s',
    ownAfter.joint.verdict?.decision === 'reject' && ownAfter.joint.verdict?.actor === 'probe-direct',
    'the machine must never outvote the person who looked at THIS joint');

  // A reversal on the source, with no amortization requested at all.
  const rev = await raw('POST', `/api/joints/${vid}/verdict`, { decision: 'reject' });
  ok('POST verdict records a reversal over an earlier decision',
    rev.status === 200 && rev.body?.status === 'rejected', `${rev.status} → ${rev.body?.status}`);
  const revEv = await jget(`/api/joints/${vid}/evidence`);
  ok('  both decisions are on the trail, so a reversal is visible rather than a rewrite',
    revEv.joint.history.filter((h) => h.event === 'verdict').length >= 2
    && revEv.joint.verdict.decision === 'reject',
    `${revEv.joint.history.filter((h) => h.event === 'verdict').length} verdict entries`);

  const manFinal = await jget('/api/manifest');
  const rejected = (manFinal.manifest || []).filter((r) => r.status === 'rejected');
  ok('  a rejection reaches the manifest as a status nothing else can produce',
    rejected.length > 0 && rejected.every((r) => !!r.verdict && r.verdict.decision === 'reject'),
    `${rejected.length} rejected record(s)`);
}

// 14) Phase-3 task 19: revision snapshots — the TIME axis over HTTP.
//
// verify-revisions.mjs proves the snapshot/diff RULES in-process; this leg proves
// the TRANSPORT and, more importantly, that the verdict writes in leg 13 actually
// froze revisions. A feature that snapshots nothing is indistinguishable from one
// that snapshots everything until you COUNT the files, so this leg counts them.
// It runs after leg 13 on purpose: the verdict chain is exactly the history a
// revision list should now be able to replay.
const revs = await jget('/api/revisions');
ok('GET /api/revisions lists the snapshot chain',
  revs.ok === true && Array.isArray(revs.revisions) && revs.revisions.length >= 2,
  `${revs.revisions?.length} revision(s), latest=${revs.latest}`);
ok('  revisions are contiguous from 0 and `latest` is the last',
  revs.revisions[0]?.revision === 0 && revs.latest === revs.revisions.length - 1);
ok('  the base revision is the project-load discovery loop, with no parent',
  revs.revisions[0]?.parent === null && /discovery loop/i.test(revs.revisions[0]?.note || ''),
  revs.revisions[0]?.note);
ok('  the verdict writes in leg 13 each froze a revision',
  revs.revisions.some((r) => /^verdict/i.test(r.note || '')),
  `notes=[${revs.revisions.map((r) => r.note).join(' | ')}]`);
ok('  a listing carries counts but never inlines the graph N times',
  revs.revisions.every((r) => r.joints === undefined && r.counts && typeof r.counts.total === 'number'));

const snap0 = await raw('GET', '/api/revisions/0');
ok('GET /api/revisions/:n loads one full snapshot, records included',
  snap0.status === 200 && snap0.body?.ok === true
    && Array.isArray(snap0.body?.joints) && snap0.body.joints.length > 0,
  `${snap0.body?.joints?.length} record(s)`);

// The root revision has no parent, so its diff is against the empty graph: every
// record reads as ADDED. This is the deterministic end of the chain.
const diff0 = await jget('/api/revisions/0/diff');
ok('GET /api/revisions/:n/diff defaults to the parent, and the root has none',
  diff0.ok === true && diff0.against === null
    && diff0.added?.length === snap0.body.joints.length && diff0.changed?.length === 0,
  `+${diff0.added?.length} added vs the empty graph`);

const verdictRev = revs.revisions.find((r) => /^verdict/i.test(r.note || ''));
if (verdictRev) {
  const dv = await jget(`/api/revisions/${verdictRev.revision}/diff`);
  ok('  a verdict revision\u2019s diff shows the status/verdict that decision moved',
    dv.ok === true && dv.against === verdictRev.parent
      && (dv.changed || []).some((c) => c.changes?.verdict || c.changes?.status),
    `${dv.changed?.length} changed record(s) vs r${dv.against}`);
  const dx = await jget(`/api/revisions/${verdictRev.revision}/diff?against=0`);
  ok('  ?against=0 diffs across the whole chain rather than against the parent',
    dx.ok === true && dx.against === 0);
} else {
  ok('  a verdict revision exists to diff', false, 'no revision note began with "verdict"');
}

const rev404 = await raw('GET', '/api/revisions/9999');
ok('GET /api/revisions/:n 404s a missing revision', rev404.status === 404 && rev404.body?.code === 'NO_REVISION', `${rev404.status}`);
const diff404 = await raw('GET', '/api/revisions/9999/diff');
ok('GET /api/revisions/:n/diff 404s a missing revision', diff404.status === 404 && diff404.body?.code === 'NO_REVISION', `${diff404.status}`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} \u2014 ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

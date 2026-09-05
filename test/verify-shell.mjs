// End-to-end proof of the app shell backend. Exercises every surface the Vue
// shell depends on: health, SPA serving, discovery, per-joint slot graphs,
// validation, resumable state, and the live events WebSocket.
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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} \u2014 ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

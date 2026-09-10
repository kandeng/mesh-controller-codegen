// Live render-node proof — the automated answer to "can a real browser draw the
// poses the planner chose, in all four vision modes, and get the bytes back?"
//
// This probe needs a browser tab open on the app with a mesh loaded, because the
// server deliberately has no WebGL context. It therefore SKIPS (exit 0) when the
// farm reports no ready renderer, so it can sit in the gate suite without a
// display; when a tab IS open it is the only test that exercises captureAt().
//
// What it proves, and why each check is shaped the way it is:
//   * the frame is 1024x1024 — read straight out of the PNG IHDR, so a capture
//     that silently used the live canvas aspect is caught without a decoder
//   * the frame is a real render, not a cleared buffer — a blank 1024px PNG
//     compresses to a few hundred bytes; a detailed drone is tens of kilobytes
//   * the four modes are NOT the same picture — if the material/visibility swap
//     in captureAt() were a no-op, photo and ghost would be byte-identical
//   * solo really hides the rest — hiding 95% of the model leaves mostly flat
//     background, which compresses far better
//   * colorId returns an exact pixel->name map — the deterministic grounding
//     channel, which needs no model inference at all
//   * a capture is DETERMINISTIC — the same pose twice must give the same bytes,
//     or the evidence on disk is not reproducible
//
// Usage: start the server (`npm run server`), open the app in a browser with a
// mesh loaded, then:  node test/verify-render.mjs [baseUrl]
const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const ROUND = 900;   // probe round, kept well away from real evidence
const GLB = 'samples/drone_dji_inspire3.glb';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}${extra ? ' \u2014 ' + extra : ''}`); } else { fail += 1; console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
};

const jget = async (p) => (await fetch(BASE + p)).json();
const jpost = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  let json = null; try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body: json };
};

// PNG IHDR: width and height are big-endian u32 at byte offsets 16 and 20. No
// decoder needed, and reading the header rather than trusting the JSON means we
// verify the bytes that actually landed on disk.
function pngSize(buf) {
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

console.log(`\nProving the browser render node @ ${BASE}\n`);

const farm = await jget('/api/observe/farm');
if (!farm.ok) { console.log(`RENDER_PROBE_FAILED \u2014 backend not reachable at ${BASE}\n`); process.exit(1); }
if (!farm.available) {
  console.log(`  \u2022 no browser renderer is connected (farm=${JSON.stringify(farm.farm)})`);
  console.log('    open the app in a browser with a mesh loaded, then re-run this probe.\n');
  console.log('RENDER_PROBE_SKIPPED \u2014 0 passed, 0 failed\n');
  process.exit(0);
}
ok('a browser tab is registered as a render node', farm.farm.ready >= 1,
  `${farm.renderers.map((r) => `${r.id}[${r.hasModel ? 'model' : 'empty'}] inflight=${r.inflight}`).join(', ')}`);

// A server restart forgets the loaded project while the browser tab keeps its own
// scene, so the planner would 400 on a fresh backend even with a renderer ready.
// Loading the sample here makes this probe stand alone rather than only runnable
// in verify-shell's wake. It is also what keeps plan and frame honest: the tab
// draws the model the server planned against.
const st0 = await jget('/api/state');
if (st0.ok !== true || st0.loaded !== true) {
  const proj = await jpost('/api/project', { glb: GLB });
  ok('POST /api/project loads the mesh the probe plans against',
    proj.status === 200 && proj.body?.ok === true,
    `${proj.body?.joints?.length} joint units, ${proj.body?.stats?.count} nodes`);
}
// Whatever is loaded is what this probe measures, and the mode assertions below
// depend on the model (a machine with no enclosed interior has nothing for a
// ghost frame to reveal). Say which one it is, with the two numbers that decide
// framing: the placed-bbox circumradius the cameras are fitted to, and the node
// spread. A wradius far larger than the machine really is means the running
// server predates a parser fix — restart it before believing a failure here.
const st1 = await jget('/api/state');
console.log(`  \u2022 probing against ${st1.glb || '(unknown)'} \u2014 wradius ${Number(st1.stats?.wradius ?? 0).toFixed(2)}, node spread ${Number(st1.stats?.radius ?? 0).toFixed(2)}, ${st1.stats?.count ?? '?'} nodes`);

// Plan against the whole model so the probe gets poses at several distances, then
// capture the same pose in every mode — mode differences must come from the mode.
// Ghosts are allowed because the ghost shot below needs the planner to name the
// interior-only parts, which is the only thing a transparent shell can reveal.
const plan = await jpost('/api/observe/plan', { round: ROUND, maxViews: 4, mode: 'none', allowGhost: true });
ok('POST /api/observe/plan produced poses for the probe round',
  plan.status === 200 && plan.body?.ok === true && (plan.body?.plan?.views?.length || 0) >= 1,
  `${plan.body?.plan?.views?.length} views, ${(100 * (plan.body?.plan?.coverage || 0)).toFixed(1)}% of ${plan.body?.plan?.targets} nodes in ${plan.body?.ms}ms`);

const views = plan.body?.plan?.views || [];
if (!views.length) { console.log(`\nRENDER_PROBE_FAILED \u2014 ${pass} passed, ${fail} failed\n`); process.exit(1); }

// mode -> { view, entry, bytes, size, url, colorMap }
const shots = {};
async function shoot(mode, view, focusNodes = null) {
  const r = await jpost('/api/observe/capture', { round: ROUND, viewId: view.id, mode, focusNodes, timeoutMs: 30000 });
  if (r.status !== 200 || !r.body?.ok) {
    return { error: `${r.status} ${r.body?.code || ''} ${r.body?.error || ''}`.trim(), status: r.status, body: r.body };
  }
  const res = await fetch(BASE + r.body.url);
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: r.status, url: r.body.url, entry: r.body.frame, bytes: buf,
    size: pngSize(buf), requestId: r.body.requestId, rendererId: r.body.rendererId, view,
  };
}

const v0 = views[0];

// ---- photo -------------------------------------------------------------------
shots.photo = await shoot('photo', v0);
ok('photo mode renders and delivers a frame', shots.photo.status === 200 && !!shots.photo.bytes,
  shots.photo.error || `${shots.photo.bytes.length} bytes via ${shots.photo.rendererId}`);
if (shots.photo.bytes) {
  ok('  the frame is the planned 1024x1024 viewport, not the live canvas size',
    shots.photo.size?.width === 1024 && shots.photo.size?.height === 1024,
    `${shots.photo.size?.width}x${shots.photo.size?.height}`);
  ok('  the frame is a real render, not a cleared buffer',
    shots.photo.bytes.length > 20000, `${(shots.photo.bytes.length / 1024).toFixed(1)} kB PNG`);
  ok('  the frame entry records the pose it was drawn from',
    shots.photo.entry?.pose?.eye?.length === 3 && shots.photo.entry?.spec?.distance > 0,
    `d=${shots.photo.entry?.spec?.distance?.toFixed?.(1)} kind=${shots.photo.entry?.spec?.kind}`);
  ok('  the plan records what the planner predicted this pose would show',
    Array.isArray(v0.sees) && v0.sees.length > 0 && v0.sees.length <= v0.covers,
    `${v0.sees?.length} of ${v0.covers} predicted parts named, e.g. ${(v0.sees || []).slice(0, 3).join(', ')}`);
  ok('  the stored entry says which mode produced it', shots.photo.entry?.mode === 'photo');
}

// ---- ghost -------------------------------------------------------------------
// Interior parts are enclosed by a closed shell, so no opaque pose can ever see
// them. Ghost is the mode that reveals them: everything OUTSIDE the focus goes
// translucent. So the probe focuses the interior-only parts the planner named —
// exactly what the loop does — and then the frame MUST be a different picture, or
// the transparency swap in captureAt() silently did nothing. A model with no
// enclosed interior has nothing to reveal and ghost legitimately equals photo,
// which is reported rather than asserted either way.
const interior = Array.isArray(plan.body?.plan?.interiorOnly) ? plan.body.plan.interiorOnly : [];
const ghostFocus = interior.length ? interior.slice(0, 8) : null;
shots.ghost = await shoot('ghost', v0, ghostFocus);
ok('ghost mode renders and delivers a frame', shots.ghost.status === 200 && !!shots.ghost.bytes,
  shots.ghost.error || `${shots.ghost.bytes.length} bytes`);
if (shots.ghost.bytes && shots.photo.bytes) {
  const delta = Math.abs(shots.ghost.bytes.length - shots.photo.bytes.length) / shots.photo.bytes.length;
  if (ghostFocus) {
    ok('  ghost is not the same picture as photo (the shell really went translucent)',
      !shots.ghost.bytes.equals(shots.photo.bytes) && delta > 0.02,
      `photo ${(shots.photo.bytes.length / 1024).toFixed(1)} kB vs ghost ${(shots.ghost.bytes.length / 1024).toFixed(1)} kB (${(delta * 100).toFixed(0)}% apart), ${ghostFocus.length}/${interior.length} interior parts focused`);
  } else {
    console.log(`  \u2022 this model reports no interior-only parts (${interior.length}), so a ghost frame has nothing to reveal \u2014 difference check skipped`);
  }
}

// ---- solo --------------------------------------------------------------------
// Rendering only part of the mesh is what makes grounding a sub-assembly easy.
// Focus on the parts the planner itself predicts this pose shows, so the focus is
// real geometry rather than an invented name list.
const focus = (Array.isArray(v0.sees) ? v0.sees : []).slice(0, 6);
shots.solo = await shoot('solo', v0, focus.length ? focus : null);
ok('solo mode renders and delivers a frame', shots.solo.status === 200 && !!shots.solo.bytes,
  shots.solo.error || `${shots.solo.bytes.length} bytes, focus=${focus.length || 'none'}`);
if (shots.solo.bytes && shots.photo.bytes) {
  // Hiding most of the model leaves large flat areas, which PNG compresses far
  // better. If solo were as big as photo, nothing was hidden.
  ok('  solo really hides everything outside the focus',
    shots.solo.bytes.length < shots.photo.bytes.length,
    `solo ${(shots.solo.bytes.length / 1024).toFixed(1)} kB vs photo ${(shots.photo.bytes.length / 1024).toFixed(1)} kB (${(100 * shots.solo.bytes.length / shots.photo.bytes.length).toFixed(0)}%)`);
}

// ---- colorId -----------------------------------------------------------------
// The deterministic grounding channel: flat unlit unique colour per part, plus an
// exact colour->name map. No model inference is involved in reading it back.
const cid = await jpost('/api/observe/capture', { round: ROUND, viewId: v0.id, mode: 'colorId', focusNodes: focus.length ? focus : null, timeoutMs: 30000 });
ok('colorId mode renders and delivers a frame', cid.status === 200 && cid.body?.ok === true,
  cid.body?.ok ? cid.body.url : `${cid.status} ${cid.body?.code || ''} ${cid.body?.error || ''}`.trim());
if (cid.body?.ok) {
  const res = await fetch(BASE + cid.body.url);
  const buf = Buffer.from(await res.arrayBuffer());
  shots.colorId = { status: 200, bytes: buf, size: pngSize(buf), entry: cid.body.frame };
  ok('  the colorId frame is a 1024x1024 mask', shots.colorId.size?.width === 1024 && shots.colorId.size?.height === 1024,
    `${shots.colorId.size?.width}x${shots.colorId.size?.height}, ${(buf.length / 1024).toFixed(1)} kB`);
  const colors = await jget(`/api/observations/${ROUND}/colors/${encodeURIComponent(cid.body.frame.id)}`);
  const map = colors.colorMap || {};
  const names = Object.values(map);
  ok('  the colour map is stored beside the frame and readable back',
    colors.ok === true && names.length > 0,
    `${names.length} colours, e.g. ${Object.entries(map).slice(0, 3).map(([c, n]) => `${c}\u2192${n}`).join(' ')}`);
  ok('  every colour id is unique and maps to a manifest-vocabulary name',
    new Set(Object.keys(map)).size === names.length
    && names.every((n) => typeof n === 'string' && n.length > 0 && !/^Object_\d+$/.test(n)),
    `${new Set(names).size} distinct names for ${names.length} colours`);
  ok('  the mask is not the photograph (materials really were swapped)',
    shots.photo.bytes && !buf.equals(shots.photo.bytes));
}

// ---- determinism -------------------------------------------------------------
// Evidence must be reproducible: the same pose, drawn twice, is the same picture.
// If this fails the frames on disk cannot be re-derived from plan.json, which is
// the whole point of persisting the plan.
const again = await shoot('photo', v0);
ok('a repeated capture of the same pose is byte-identical',
  again.status === 200 && shots.photo.bytes && again.bytes?.equals(shots.photo.bytes),
  again.bytes ? `${again.bytes.length} bytes, equal=${again.bytes.equals(shots.photo.bytes)}` : again.error);

// ---- a second pose is a different picture ------------------------------------
if (views.length > 1) {
  const v1shot = await shoot('photo', views[1]);
  ok('a different planned pose gives a different frame',
    v1shot.status === 200 && shots.photo.bytes && !v1shot.bytes.equals(shots.photo.bytes),
    v1shot.entry ? `view ${v1shot.entry.id} d=${v1shot.entry.spec?.distance?.toFixed?.(1)}, ${(v1shot.bytes.length / 1024).toFixed(1)} kB` : v1shot.error);
}

// ---- the round is now durable evidence ---------------------------------------
const round = await jget(`/api/observations/${ROUND}`);
ok('every probe frame is persisted as round evidence',
  round.ok === true && (round.frames?.length || 0) >= 5 && round.plan?.views?.length === views.length,
  `${round.frames?.length} frames, plan=${round.plan?.views?.length} views, modes=${[...new Set((round.frames || []).map((f) => f.mode))].join('/')}`);
ok('  each stored frame carries a servable url',
  (round.frames || []).every((f) => typeof f.url === 'string' && f.url.startsWith('/runs/')),
  (round.frames || []).map((f) => f.id).join(', '));

console.log(`\n${fail === 0 ? 'RENDER_PROBE_OK' : 'RENDER_PROBE_FAILED'} \u2014 ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

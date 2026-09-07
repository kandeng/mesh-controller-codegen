<script setup>
// MeshViewer — Vue port of viewer/viewer.html. Owns the three.js scene and an
// ISOLATED single-joint preview: the data-driven knobs rotate ONLY the active
// joint's own nodes (rotor spin w/ CCW-CW direction, gimbal pitch/yaw, hinge
// angle) and publish readouts back to the store. Also renders the active
// joint's viewer-overlay slot (spin-axis marker at the joint anchor).
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useTheme } from '../composables/useTheme.js';
import { registerViewerCapture, registerViewerCaptureAt, registerViewerCaptureMotion, registerViewerModel } from '../composables/useViewerCapture.js';
import { useRenderFarm } from '../composables/useRenderFarm.js';

const { state } = useProjectStore();
const { state: themeState } = useTheme();

const container = ref(null);
const status = ref('');

let renderer, scene, camera, orbit, clock, raf = 0;
let drone = null, center = new THREE.Vector3(), radius = 1;
let overlay = null, grid = null;
let loadedGlb = null;
let nodeByName = new Map();      // node name -> THREE.Object3D (preview targets)
let restWorld = new Map();       // node name -> rest-pose world position (scene space)
let previewAngle = 0;            // accumulated spin angle (deg) of active joint
let pivot = null;                // temp pivot the active joint is parented to
let pivotNodes = [];             // nodes currently parented to the pivot
let pivotParents = [];           // their original parents (for restore)
let pivotJointId = null;         // joint id the pivot belongs to
let lastPublish = 0;             // throttle readout publishing (~5 Hz)
const DEG2RAD = Math.PI / 180;

// Read the active theme's 3D scene tokens (defined on <html> by style.css).
// THREE.Color accepts CSS hex strings; computed values carry surrounding spaces.
function sceneColors() {
  const cs = getComputedStyle(document.documentElement);
  const read = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim();
  return {
    bg: read('--scene-bg', '#101418'),
    gridMajor: read('--scene-grid-major', '#334455'),
    gridMinor: read('--scene-grid-minor', '#222233'),
  };
}

// Re-tint the backdrop + ground grid for the current theme. Lights stay fixed so
// the mesh itself renders identically in dark and light.
function applySceneTheme() {
  if (!scene) return;
  const c = sceneColors();
  scene.background = new THREE.Color(c.bg);
  if (grid) { scene.remove(grid); grid.dispose?.(); }
  grid = new THREE.GridHelper(20, 20, c.gridMajor, c.gridMinor);
  scene.add(grid);
}

function initScene() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(devicePixelRatio);
  container.value.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30281e, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(5, 10, 6);
  scene.add(sun);
  applySceneTheme();   // backdrop + grid follow the active theme

  camera = new THREE.PerspectiveCamera(50, 1, 0.01, 2000);
  orbit = new OrbitControls(camera, renderer.domElement);
  clock = new THREE.Clock();
  resize();
}

function resize() {
  if (!container.value || !renderer) return;
  const w = container.value.clientWidth, h = container.value.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function tick() {
  raf = requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  try { applyPreview(dt); } catch (e) { status.value = `preview() threw: ${e.message}`; }
  orbit.update();
  renderer.render(scene, camera);
}

// Screenshot the live scene as a PNG data URL. WebGL clears its drawing buffer
// after each composite, so we render and read the buffer in the SAME synchronous
// task — no preserveDrawingBuffer flag and no cost to the normal render loop.
function captureFrame() {
  if (!renderer) return null;
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}

// ---- phase-3 pose-driven capture --------------------------------------------
// The NBV planner works in ABSOLUTE parseGlb world space; this scene is that same
// space minus the model's own bbox centre (`drone.position.sub(center)` above).
// A planned pose therefore arrives as absolute eye/target and both are shifted by
// -center. The eye-target VECTOR is preserved exactly, so direction, distance and
// framing are faithful; only the aim point inherits any tiny difference between
// parseGlb's placed-bbox centre and THREE's Box3 centre.
//
// The planner also projects against a fixed virtual viewport (1024x1024, fov 45).
// A capture must use the SAME intrinsics or the projected pixel areas the planner
// reasoned about describe a different image than the one we send. So captureAt
// overrides size, pixel ratio, fov, aspect, near/far and the camera basis, then
// restores every one of them in a finally — the live view resumes untouched.
const DUP_NAME = /^Object_\d+$/;

// Nearest non-duplicate ancestor: the name the manifest, the joints and the
// planner's own `namedIndex` all speak in. Mirrors views.mjs exactly, because a
// colour id that resolves to `Object_211` is useless to the grounding step.
function namedOf(o) {
  let cur = o; let guard = 0;
  while (cur && DUP_NAME.test(cur.name || '') && cur.parent && guard < 64) { cur = cur.parent; guard += 1; }
  return (cur && cur.name) || o.name || `node_${o.id}`;
}

// Low-discrepancy colour ids. Consecutive parts must land FAR apart in colour
// space: the context is antialiased, so an edge between two parts blends, and a
// blend of two neighbouring ids can itself be a valid id. Spread over three
// irrationals and keep every channel clear of 0 so no id can be mistaken for the
// black backdrop either.
const SPREAD = [0.6180339887498949, 0.7548776662466927, 0.5698402909980532];
function colorIdOf(k) {
  const n = k + 1;
  const ch = SPREAD.map((a) => Math.max(24, Math.min(255, Math.round(((n * a) % 1) * 255))));
  return (ch[0] << 16) | (ch[1] << 8) | ch[2];
}
const hex6 = (v) => `#${v.toString(16).padStart(6, '0')}`;

// Draw ONE frame from a planned pose. Modes:
//   photo    the model as it is — what a human would photograph
//   ghost    shell translucent, focus opaque: reaches the parts the planner
//            reported as interior-only, which no opaque pose can ever see
//   solo     ONLY the focus draws: the cheapest way to ground what a sub-assembly
//            (e.g. a gimbal) is actually made of
//   colorId  flat unlit unique colour per focused part -> a segmentation mask and
//            an exact pixel->name map, so grounding needs no model inference
// Returns { dataUrl, width, height, mode, colorMap } or null.
function captureAt(view, { mode = 'photo', focusNodes = null, viewport = null } = {}) {
  if (!renderer || !drone) return null;
  const pose = view?.pose;
  if (!Array.isArray(pose?.eye) || !Array.isArray(pose?.target)) return null;

  const vp = {
    w: Math.max(16, Number(viewport?.w) || 1024),
    h: Math.max(16, Number(viewport?.h) || 1024),
    fov: Math.max(1, Math.min(170, Number(viewport?.fov) || 45)),
  };

  // Scene space = world space - center.
  const eye = [pose.eye[0] - center.x, pose.eye[1] - center.y, pose.eye[2] - center.z];
  const tgt = [pose.target[0] - center.x, pose.target[1] - center.y, pose.target[2] - center.z];
  const dist = Math.hypot(eye[0] - tgt[0], eye[1] - tgt[1], eye[2] - tgt[2]);
  if (!(dist > 1e-6)) return null;

  const focus = Array.isArray(focusNodes) && focusNodes.length ? new Set(focusNodes.map(String)) : null;
  // A focus name is usually a CONTAINER, and the things that actually draw are
  // its descendants, so membership is decided by walking up the parent chain.
  const inFocus = (o) => {
    if (!focus) return true;
    let cur = o; let guard = 0;
    while (cur && guard < 64) { if (focus.has(cur.name)) return true; cur = cur.parent; guard += 1; }
    return false;
  };

  const saved = {
    size: renderer.getSize(new THREE.Vector2()),
    pixelRatio: renderer.getPixelRatio(),
    fov: camera.fov, aspect: camera.aspect, near: camera.near, far: camera.far, zoom: camera.zoom,
    up: camera.up.clone(), position: camera.position.clone(), quaternion: camera.quaternion.clone(),
    background: scene.background,
    gridVisible: grid ? grid.visible : null,
    overlayVisible: overlay ? overlay.visible : null,
    orbitEnabled: orbit.enabled, orbitTarget: orbit.target.clone(),
    pivotRotation: pivot ? pivot.rotation.clone() : null,
  };

  const meshes = [];
  drone.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const savedMats = new Map();
  const savedVis = new Map();
  const disposables = [];
  const colorMap = {};

  const applyMode = () => {
    if (mode === 'photo') return;
    if (mode === 'colorId') {
      // One colour per NAMED part, not per mesh: a part can be several meshes and
      // grounding must return the name the manifest speaks in.
      const ids = new Map();
      for (const m of meshes) {
        if (!inFocus(m)) { savedVis.set(m, m.visible); m.visible = false; continue; }
        const nm = namedOf(m);
        if (!ids.has(nm)) {
          const v = colorIdOf(ids.size);
          ids.set(nm, v);
          colorMap[hex6(v)] = nm;
        }
        savedMats.set(m, m.material);
        // Unlit and tone-mapping-free: the pixel must be EXACTLY the id colour.
        const mat = new THREE.MeshBasicMaterial({ color: ids.get(nm), toneMapped: false, fog: false });
        disposables.push(mat);
        m.material = mat;
      }
      return;
    }
    if (mode === 'solo') {
      for (const m of meshes) if (!inFocus(m)) { savedVis.set(m, m.visible); m.visible = false; }
      return;
    }
    if (mode === 'ghost') {
      // Everything still draws, but the enclosing shell goes translucent so the
      // interior-only parts become visible. depthWrite stays on for the focused
      // parts only, so ghosts do not occlude each other by draw order.
      for (const m of meshes) {
        savedMats.set(m, m.material);
        const hot = inFocus(m);
        const src = Array.isArray(m.material) ? m.material[0] : m.material;
        const mat = new THREE.MeshStandardMaterial({
          color: src?.color ? src.color.clone() : new THREE.Color(0x8899aa),
          transparent: true, opacity: hot ? 0.95 : 0.12,
          depthWrite: hot, side: THREE.DoubleSide,
        });
        disposables.push(mat);
        m.material = mat;
      }
    }
  };

  const restore = () => {
    for (const [m, mat] of savedMats) m.material = mat;
    for (const [m, v] of savedVis) m.visible = v;
    for (const d of disposables) { try { d.dispose(); } catch { /* ignore */ } }
    savedMats.clear(); savedVis.clear(); disposables.length = 0;
    scene.background = saved.background;
    if (grid) grid.visible = saved.gridVisible ?? true;
    if (overlay) overlay.visible = saved.overlayVisible ?? true;
    if (pivot && saved.pivotRotation) { pivot.rotation.copy(saved.pivotRotation); pivot.updateMatrixWorld(true); }
    renderer.setPixelRatio(saved.pixelRatio);
    renderer.setSize(saved.size.x, saved.size.y);
    camera.fov = saved.fov; camera.aspect = saved.aspect;
    camera.near = saved.near; camera.far = saved.far; camera.zoom = saved.zoom;
    camera.up.copy(saved.up); camera.position.copy(saved.position);
    camera.quaternion.copy(saved.quaternion);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    orbit.target.copy(saved.orbitTarget);
    orbit.enabled = saved.orbitEnabled;
    orbit.update();
  };

  try {
    // Freeze the animated preview at the REST pose: a vision frame must show the
    // model as discovered, not mid-spin, or the model is being asked to name
    // parts of a configuration that does not exist in the rig.
    if (pivot) { pivot.rotation.set(0, 0, 0); pivot.updateMatrixWorld(true); }
    // The grid and the joint-axis marker are UI, not geometry. A vision frame
    // carrying a 20x20 grid invites the model to comment on the grid.
    if (grid) grid.visible = false;
    if (overlay) overlay.visible = false;
    orbit.enabled = false;

    applyMode();

    // updateStyle=false leaves the CSS box alone: the drawing buffer becomes the
    // planned frame size while the visible canvas keeps its layout size, and the
    // restore below puts both back before the browser ever composites.
    renderer.setPixelRatio(1);
    renderer.setSize(vp.w, vp.h, false);
    // A mask needs a backdrop that is not a valid id colour; photo/ghost/solo
    // keep the user's theme so the frame looks like the model, not like a CAD
    // viewport.
    scene.background = mode === 'colorId' ? new THREE.Color(0x000000) : saved.background;

    camera.fov = vp.fov;
    camera.aspect = vp.w / vp.h;
    camera.up.set(0, 0, 1);            // model space is Z-up
    camera.near = Math.max(0.01, dist * 0.01);
    camera.far = dist * 4 + radius * 4 + 10;
    camera.zoom = 1;
    camera.position.set(eye[0], eye[1], eye[2]);
    camera.lookAt(tgt[0], tgt[1], tgt[2]);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    return {
      dataUrl, width: vp.w, height: vp.h, mode,
      colorMap: mode === 'colorId' ? colorMap : null,
      parts: mode === 'colorId' ? Object.keys(colorMap).length : null,
    };
  } catch (e) {
    status.value = `captureAt(${mode}) threw: ${e.message}`;
    return null;
  } finally {
    restore();
  }
}

// ---- phase-3 task 18: motion-fan capture ------------------------------------
// captureAt FREEZES the preview at rest; a motion fan needs the exact opposite —
// the SAME preview pivot driven through a fan of angles from ONE fixed camera, so
// the only thing that changes between frames is this joint's own rotation.
//
// The question these frames answer is SEMANTIC ONLY: "what is this moving thing,
// is the motion sensible". WHICH nodes move and by how much is already measured
// exactly by the rigidity gate, so nothing here is a measurement — it is evidence
// for a judgement. That is why the fan is small (a few poses) and the frames are
// modest: a 12-frame 1024px survey would answer a question nobody is asking.
//
// FULLY SYNCHRONOUS, and that is load-bearing rather than a convenience: every
// pose is rendered, tagged and swept inside one task, so the preview tick — which
// re-parents the pivot for the ACTIVE joint on every animation frame — can never
// interleave between two poses and silently redraw the fan about the wrong joint.
// The swept composite is an onion-skin built by accumulating each render onto a
// second 2D canvas (earliest pose faintest, latest solid), so the arc of motion is
// visible in a single image without a video path.
//
// The burned-in corner tag is REDUNDANCY, not the primary annotation: the prompt
// text says "frame 2 = 30 deg" authoritatively, and the tag is what survives a
// model that reorders the images.
const MAX_MOTION_ANGLES = 6;

// Small high-contrast pill in the top-left. Kept small and cornered so it never
// covers the moving part, but legible enough to do its job as reordering
// insurance. roundRect is guarded because a tag that fails to draw must degrade to
// no tag, not to a thrown capture.
function drawCornerTag(ctx, text, vp) {
  try {
    const pad = Math.max(4, Math.round(vp.h * 0.014));
    const fs = Math.max(13, Math.round(vp.h * 0.05));
    ctx.font = `600 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = 'top';
    const w = Math.ceil(ctx.measureText(text).width);
    const bw = w + pad * 2, bh = fs + pad * 2, r = Math.round(pad * 0.9);
    ctx.fillStyle = 'rgba(8,10,14,0.72)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(pad, pad, bw, bh, r); else ctx.rect(pad, pad, bw, bh);
    ctx.fill();
    ctx.fillStyle = '#e8eef6';
    ctx.fillText(text, pad * 2, pad);
  } catch { /* a missing tag must never cost the frame */ }
}

// Drive the pivot to ONE explicit angle about the joint's primary axis. Mirrors
// applyPreview's per-type mapping, but from a given angle instead of accumulated
// knob values, and setting all three components so a previous pose can never leak
// into the next. Model space is Z-up: rotor spin and hinge angle are about Z; a
// gimbal fan shows pitch, about a horizontal (X) axis.
function setDriveAngle(j, angleDeg) {
  if (!pivot) return;
  const a = (Number(angleDeg) || 0) * DEG2RAD;
  if (j?.type === 'gimbal') pivot.rotation.set(a, 0, 0);
  else pivot.rotation.set(0, 0, a);
  pivot.updateMatrixWorld(true);
}

// Draw the fan. Returns { frames, composite, joint, angles, mode, view } or null.
function captureMotion(joint, { view, angles = null, mode = 'photo', focusNodes = null, viewport = null } = {}) {
  if (!renderer || !drone) return null;
  if (!joint || !joint.id) return null;
  const pose = view?.pose;
  if (!Array.isArray(pose?.eye) || !Array.isArray(pose?.target)) return null;

  const fan = (Array.isArray(angles) && angles.length ? angles : [0, 30, 60])
    .map((a) => Number(a) || 0).slice(0, MAX_MOTION_ANGLES);
  // One pose is not motion. Refuse rather than hand back a "fan" that cannot show
  // an arc — the whole point is the change between frames.
  if (fan.length < 2) { status.value = 'motion fan needs at least 2 angles'; return null; }

  const vp = {
    w: Math.max(16, Number(viewport?.w) || 768),
    h: Math.max(16, Number(viewport?.h) || 768),
    fov: Math.max(1, Math.min(170, Number(viewport?.fov) || 45)),
  };

  // Scene space = world space - center (identical to captureAt; see its note).
  const eye = [pose.eye[0] - center.x, pose.eye[1] - center.y, pose.eye[2] - center.z];
  const tgt = [pose.target[0] - center.x, pose.target[1] - center.y, pose.target[2] - center.z];
  const dist = Math.hypot(eye[0] - tgt[0], eye[1] - tgt[1], eye[2] - tgt[2]);
  if (!(dist > 1e-6)) return null;

  const focus = Array.isArray(focusNodes) && focusNodes.length ? new Set(focusNodes.map(String)) : null;
  const inFocus = (o) => {
    if (!focus) return true;
    let cur = o; let guard = 0;
    while (cur && guard < 64) { if (focus.has(cur.name)) return true; cur = cur.parent; guard += 1; }
    return false;
  };

  const saved = {
    size: renderer.getSize(new THREE.Vector2()),
    pixelRatio: renderer.getPixelRatio(),
    fov: camera.fov, aspect: camera.aspect, near: camera.near, far: camera.far, zoom: camera.zoom,
    up: camera.up.clone(), position: camera.position.clone(), quaternion: camera.quaternion.clone(),
    background: scene.background,
    gridVisible: grid ? grid.visible : null,
    overlayVisible: overlay ? overlay.visible : null,
    orbitEnabled: orbit.enabled, orbitTarget: orbit.target.clone(),
    pivotRotation: pivot ? pivot.rotation.clone() : null,
    // Whether the live pivot ALREADY belongs to this joint. If so it is the active
    // preview's own pivot and must be restored, not torn down; otherwise we built
    // one for a non-active joint and must dismantle it so the tick can rebuild the
    // active one.
    wasPivot: !!(pivot && pivotJointId === joint.id),
  };

  // solo hides everything outside the focus so the swept arc reads as just the
  // moving assembly against the backdrop — the clearest possible "is this motion
  // sensible" picture. photo keeps the whole machine for context.
  const savedVis = new Map();
  const applySolo = () => {
    if (mode !== 'solo') return;
    drone.traverse((o) => { if (o.isMesh && !inFocus(o)) { savedVis.set(o, o.visible); o.visible = false; } });
  };
  const restoreVis = () => { for (const [o, v] of savedVis) o.visible = v; savedVis.clear(); };

  const mkCanvas = () => { const c = document.createElement('canvas'); c.width = vp.w; c.height = vp.h; return c; };
  const tagCanvas = mkCanvas(); const tagCtx = tagCanvas.getContext('2d');
  const sweepCanvas = mkCanvas(); const sweepCtx = sweepCanvas.getContext('2d');

  try {
    ensurePivot(joint);
    if (!pivot) { status.value = `motion: no pivot could be built for ${joint.id} (no nodes or anchor)`; return null; }
    if (grid) grid.visible = false;
    if (overlay) overlay.visible = false;
    orbit.enabled = false;
    applySolo();

    renderer.setPixelRatio(1);
    renderer.setSize(vp.w, vp.h, false);
    scene.background = saved.background;

    camera.fov = vp.fov;
    camera.aspect = vp.w / vp.h;
    camera.up.set(0, 0, 1);            // model space is Z-up
    camera.near = Math.max(0.01, dist * 0.01);
    camera.far = dist * 4 + radius * 4 + 10;
    camera.zoom = 1;
    camera.position.set(eye[0], eye[1], eye[2]);
    camera.lookAt(tgt[0], tgt[1], tgt[2]);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    const frames = [];
    const n = fan.length;
    fan.forEach((angle, i) => {
      setDriveAngle(joint, angle);
      renderer.render(scene, camera);
      // Read the WebGL buffer in the SAME synchronous task (no preserveDrawingBuffer),
      // exactly as captureAt does, then tag it on a 2D canvas.
      tagCtx.clearRect(0, 0, vp.w, vp.h);
      tagCtx.drawImage(renderer.domElement, 0, 0, vp.w, vp.h);
      const tag = `${i + 1} \u00b7 ${angle}\u00b0`;
      drawCornerTag(tagCtx, tag, vp);
      frames.push({ index: i + 1, angle, tag, dataUrl: tagCanvas.toDataURL('image/png'), width: vp.w, height: vp.h });
      // Onion-skin accumulation: earliest pose faintest, latest solid, so the sweep
      // reads as motion from the first pose to the last.
      sweepCtx.globalAlpha = n <= 1 ? 1 : 0.25 + 0.75 * (i / (n - 1));
      sweepCtx.drawImage(renderer.domElement, 0, 0, vp.w, vp.h);
    });
    sweepCtx.globalAlpha = 1;
    drawCornerTag(sweepCtx, `sweep ${fan[0]}\u2013${fan[n - 1]}\u00b0`, vp);

    return {
      frames,
      composite: { kind: 'sweep', dataUrl: sweepCanvas.toDataURL('image/png'), width: vp.w, height: vp.h, angles: fan },
      joint: { id: joint.id, type: joint.type || null },
      angles: fan,
      mode,
      view: { id: view?.id ?? null, spec: view?.spec ?? null, pose: view?.pose ?? null },
    };
  } catch (e) {
    status.value = `captureMotion threw: ${e.message}`;
    return null;
  } finally {
    restoreVis();
    scene.background = saved.background;
    if (grid) grid.visible = saved.gridVisible ?? true;
    if (overlay) overlay.visible = saved.overlayVisible ?? true;
    if (saved.wasPivot && pivot) { pivot.rotation.copy(saved.pivotRotation); pivot.updateMatrixWorld(true); }
    else teardownPivot();
    renderer.setPixelRatio(saved.pixelRatio);
    renderer.setSize(saved.size.x, saved.size.y);
    camera.fov = saved.fov; camera.aspect = saved.aspect;
    camera.near = saved.near; camera.far = saved.far; camera.zoom = saved.zoom;
    camera.up.copy(saved.up); camera.position.copy(saved.position);
    camera.quaternion.copy(saved.quaternion);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    orbit.target.copy(saved.orbitTarget);
    orbit.enabled = saved.orbitEnabled;
    orbit.update();
  }
}

// Tell the render farm what this tab can currently draw. Called on every model
// change so the server never picks a tab that is showing a different mesh than
// the one the plan was made against.
function announceModel() {
  registerViewerModel({ hasModel: !!drone, glb: loadedGlb });
  useRenderFarm().refresh();
}

async function loadModel(url) {
  if (!url || url === loadedGlb) return;
  teardownPivot();
  if (drone) { scene.remove(drone); drone = null; }
  loadedGlb = url;
  status.value = `loading mesh…`;
  const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
  drone = gltf.scene;
  scene.add(drone);
  nodeByName = new Map();
  drone.traverse((o) => { if (o.name) nodeByName.set(o.name, o); });
  const box = new THREE.Box3().setFromObject(drone);
  const size = box.getSize(new THREE.Vector3());
  center = box.getCenter(new THREE.Vector3());
  radius = Math.max(size.x, size.y, size.z) || 1;
  drone.position.sub(center);
  restWorld = new Map();
  drone.updateMatrixWorld(true);
  drone.traverse((o) => { if (o.name) restWorld.set(o.name, o.getWorldPosition(new THREE.Vector3()).clone()); });
  camera.position.set(radius * 1.8, radius * 1.2, radius * 1.8);
  camera.far = radius * 20; camera.updateProjectionMatrix();
  orbit.target.set(0, 0, 0);
  orbit.update();
  status.value = '';
  // Announce LAST: the farm may pick this tab the instant it hears "model
  // loaded", and every part of the scene must already be in its rest state.
  announceModel();
}

// ---- isolated single-joint preview -----------------------------------------
// The knobs drive ONLY the active joint, never the whole drone and never the
// generated controller. Rotor blades are often SIBLINGS/cousins of the hub (not
// children), so rotating each node about its OWN origin spins each blade around
// its own centre and tears it off the hub. Instead we re-parent the joint's
// nodes under a temporary pivot placed at the joint anchor (world transforms
// preserved via attach()), then spin/tilt the pivot: the whole assembly rotates
// rigidly about its own axis and every part stays connected.
function jointNodeObjects(j) {
  return (j?.nodes || []).map((n) => nodeByName.get(n)).filter(Boolean);
}

// Discovery's node list can omit small rotor hardware (locks, nuts) that is
// visually part of the spinning assembly. Complete the set geometrically: any
// node sitting inside the rotor disc (horizontal distance <= the discovered
// rotor radius R, and within the disc plane band) joins the spin. Nodes whose
// subtree reaches OUTSIDE the disc (e.g. the corner node carrying the landing
// leg) are skipped so legs/arms never rotate.
// NOTE the data is Z-UP (XY horizontal, Z vertical — parseGlb world space;
// GLTFLoader applies the same node transforms, so the viewer scene is Z-up too).
function rotorAssemblyNodes(j, base) {
  const a = { x: j.anchor.x - center.x, y: j.anchor.y - center.y, z: j.anchor.z - center.z };
  let R = 0.5;
  for (const o of base) {
    const p = restWorld.get(o.name);
    if (p) R = Math.max(R, Math.hypot(p.x - a.x, p.y - a.y));
  }
  const dzTol = R * 1.5;
  const inDisc = (p) => Math.hypot(p.x - a.x, p.y - a.y) <= R && Math.abs(p.z - a.z) <= dzTol;
  const inBase = new Set(base.map((o) => o.name));
  const extras = [];
  for (const [name, o] of nodeByName) {
    if (inBase.has(name)) continue;
    const p = restWorld.get(name);
    if (!p || !inDisc(p)) continue;
    let whole = true;
    o.traverse((d) => { const q = restWorld.get(d.name); if (q && !inDisc(q)) whole = false; });
    if (whole) extras.push(o);
  }
  return base.concat(extras);
}

// The set the preview actually drives. Rotors get geometric disc completion
// (the disc is the physical truth; attachment-sanity floaters there are real
// blades the warn over-flags, and the completion re-adds them anyway —
// skipping them would LEAVE A BLADE BEHIND). Gimbal/hinge have no completion,
// so the battery's floater verdict is applied as the guard: a floating member
// is discovery over-collection — e.g. the gimbal regex also matched the
// belly-plate subtree 13.7 units from the anchor, and attach()ing it swung
// 51 nodes about the gimbal pivot (the torn sheet in the viewer).
function driveSet(j) {
  const base = jointNodeObjects(j);
  if (j?.type === 'rotor') return rotorAssemblyNodes(j, base);
  const skip = new Set(
    (j?.tests || [])
      .filter((t) => t.name === 'attachment-sanity' && t.pass === false)
      .flatMap((t) => t.floaters || []),
  );
  return base.filter((o) => !skip.has(o.name));
}

function teardownPivot() {
  if (!pivot) { pivotJointId = null; return; }
  pivot.rotation.set(0, 0, 0);
  pivot.updateMatrixWorld(true);
  for (let i = 0; i < pivotNodes.length; i++) {
    if (pivotParents[i]) pivotParents[i].attach(pivotNodes[i]);  // restore rest pose
  }
  scene.remove(pivot);
  pivot = null; pivotNodes = []; pivotParents = []; pivotJointId = null;
  previewAngle = 0;
}

function ensurePivot(j) {
  if (pivot && pivotJointId === j.id) return;
  teardownPivot();
  const nodes = driveSet(j);
  if (!nodes.length || !j.anchor) return;
  pivot = new THREE.Object3D();
  pivot.position.set(j.anchor.x - center.x, j.anchor.y - center.y, j.anchor.z - center.z);
  scene.add(pivot);
  pivotParents = nodes.map((n) => n.parent);
  for (const n of nodes) pivot.attach(n);   // keeps world transform, re-parents
  pivotNodes = nodes;
  pivotJointId = j.id;
  previewAngle = 0;
}

function publishGimbal(pitch, yaw, now) {
  if (now - lastPublish < 200) return;   // ~5 Hz is plenty for readouts
  lastPublish = now;
  state.gimbal = { pitch, yaw };
}

function applyPreview(dt) {
  const now = performance.now();
  const j = state.joints.find((x) => x.id === state.activeJointId);
  if (!j || !drone) { teardownPivot(); return; }
  ensurePivot(j);
  if (!pivot) { publishGimbal(0, 0, now); return; }
  const kv = state.knobValues;

  if (j.type === 'rotor') {
    const speed = Number(kv.speed || 0);
    const dir = Number(kv.turn || 1) < 0 ? -1 : 1;   // -1 = CCW, +1 = CW
    // Slow-motion visual rate so the spin DIRECTION stays readable by eye.
    // Scene is Z-up: the rotor spin axis is world Z — NEVER rotation.y (that
    // is a horizontal axis here and flips the propeller out of plane).
    previewAngle = (previewAngle + speed * 36 * dir * dt) % 360;
    pivot.rotation.z = previewAngle * DEG2RAD;
    publishGimbal(0, 0, now);
  } else if (j.type === 'gimbal') {
    const p = Number(kv.pitch || 0);
    const y = Number(kv.yaw || 0);
    pivot.rotation.x = p * DEG2RAD;   // pitch about a horizontal axis
    pivot.rotation.z = y * DEG2RAD;   // yaw about the vertical (Z) axis
    publishGimbal(p, y, now);
  } else {
    pivot.rotation.z = Number(kv.angle || 0) * DEG2RAD;
    publishGimbal(0, 0, now);
  }
}

// Viewer-overlay slot: a small axes marker at the active joint's anchor.
function updateOverlay() {
  if (overlay) { scene.remove(overlay); overlay = null; }
  const j = state.joints.find((x) => x.id === state.activeJointId);
  const wantsAxis = (state.slotGraph?.overlays || []).some((o) => o.render === 'spin-axis');
  if (!j || !j.anchor || !wantsAxis || !drone) return;
  overlay = new THREE.AxesHelper(radius * 0.12);
  overlay.position.set(j.anchor.x - center.x, j.anchor.y - center.y, j.anchor.z - center.z);
  scene.add(overlay);
}

async function reload() {
  try {
    await loadModel(state.viewer.glb);
    updateOverlay();
  } catch (e) {
    status.value = `load failed: ${e.message}`;
    announceModel();
  }
}

watch(() => state.viewer.glb, reload);
watch(() => [state.activeJointId, state.slotGraph], updateOverlay, { deep: true });
watch(() => state.activeJointId, teardownPivot);
watch(() => themeState.mode, applySceneTheme);   // re-tint the 3D scene on theme switch

onMounted(() => {
  initScene();
  tick();
  addEventListener('resize', resize);
  registerViewerCapture(captureFrame);
  registerViewerCaptureAt(captureAt);
  registerViewerCaptureMotion(captureMotion);
  announceModel();
  if (state.viewer.glb) reload();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  removeEventListener('resize', resize);
  registerViewerCapture(null);
  registerViewerCaptureAt(null);
  registerViewerCaptureMotion(null);
  registerViewerModel(null);
  try { renderer?.dispose(); } catch { /* ignore */ }
});
</script>

<template>
  <div class="viewer">
    <div ref="container" class="canvas"></div>
    <div v-if="status" class="status">{{ status }}</div>
    <div v-if="!state.viewer.glb" class="hint">Load a mesh to begin</div>
  </div>
</template>

<style scoped>
.viewer { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--bg); }
.canvas { position: absolute; inset: 0; }
.status {
  position: absolute; bottom: 8px; left: 8px; font-family: ui-monospace, monospace;
  font-size: 11px; color: var(--good); background: var(--overlay-bg); padding: 3px 7px; border-radius: 5px;
}
.hint {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--muted); font-size: 14px; pointer-events: none;
}
</style>

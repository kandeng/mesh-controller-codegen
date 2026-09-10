<script setup>
// MeshViewer — Vue port of viewer/viewer.html. Owns the three.js scene and an
// ISOLATED single-joint preview: the data-driven knobs rotate ONLY the active
// joint's own nodes (rotor spin w/ CCW-CW direction, gimbal pitch/yaw, hinge
// angle) and publish readouts back to the store. Also renders the active
// joint's viewer-overlay slot (spin-axis marker at the joint anchor).
import { nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useTheme } from '../composables/useTheme.js';
import { useSlotRouting } from '../composables/useSlotRouting.js';
import { registerViewerCapture, registerViewerCaptureAt, registerViewerCaptureMotion, registerViewerModel } from '../composables/useViewerCapture.js';
import { useRenderFarm } from '../composables/useRenderFarm.js';
import { useKernelApi } from '../composables/useKernelApi.js';

const { state } = useProjectStore();
const { state: themeState } = useTheme();
const { selectJoint } = useSlotRouting();
const api = useKernelApi();

const container = ref(null);
const status = ref('');
const hover = ref(null);   // marker tooltip { id,label,type,status,x,y }
const inkRef = ref(null);  // 2D annotation canvas layered over the WebGL view
const textInput = ref(null);

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
  sizeInk();   // the annotation layer tracks the panel; marks stay put (normalised)
}

function tick() {
  raf = requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  try { applyPreview(dt); } catch (e) { status.value = `preview() threw: ${e.message}`; }
  stepTour(dt);
  orbit.update();
  renderer.render(scene, camera);
}

// Screenshot the live scene as a PNG data URL. WebGL clears its drawing buffer
// after each composite, so we render and read the buffer in the SAME synchronous
// task — no preserveDrawingBuffer flag and no cost to the normal render loop.
function captureFrame() {
  if (!renderer) return null;
  renderer.render(scene, camera);
  const gl = renderer.domElement;
  // The human's pen rides along: composite the annotation layer over the WebGL
  // buffer so a screenshot shows exactly what the human was pointing at. The AI's
  // own frames (captureAt / captureMotion) read the buffer directly and stay
  // clean — a human's mark is a message, not evidence.
  const ink = inkRef.value;
  if (!ink || !marks.value.length) return gl.toDataURL('image/png');
  const out = document.createElement('canvas');
  out.width = gl.width; out.height = gl.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(gl, 0, 0);
  ctx.drawImage(ink, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

// ---- human annotation layer: pens over the 3D view --------------------------
// Marks live on a 2D canvas layered ABOVE the WebGL view, stored in NORMALISED
// coordinates so they survive a panel resize, and are composited into the
// screenshot the chat attaches (captureFrame). With a pen armed the layer takes
// the pointer (orbit stays untouched underneath); with none it is click-through.
// Icons are inline SVG paths on a 20x20 grid so every pen reads at the same visual
// weight as the colour swatch beside it — unicode glyphs rendered too small next
// to the solid block, and the rectangle glyph was a flat bar, not the near-square
// the tool actually draws.
const TOOLS = [
  { id: 'arrow', path: 'M3 10 H16 M16 10 L11 5.5 M16 10 L11 14.5', title: 'Arrow — drag from tail to head' },
  { id: 'rect', path: 'M4 4 H16 V16 H4 Z', title: 'Rectangle — drag corner to corner' },
  { id: 'curve', path: 'M3 13 C6 3, 8 17, 11 9 C13 4, 15 6, 17 8', title: 'Free curve — drag to draw' },
  { id: 'text', path: 'M5 5 H15 M10 5 V16', title: 'Text — click, type, Enter places it' },
];
const tool = ref(null);            // armed pen, or null = orbit as usual
const inkColor = ref('#ff3b30');
const marks = ref([]);             // committed marks, normalised 0..1
let draft = null;                  // the mark currently being drawn
const textAt = ref(null);          // { x, y } css px where a text mark is typed
const textDraft = ref('');

function sizeInk() {
  const c = inkRef.value;
  if (!c || !container.value) return;
  const dpr = window.devicePixelRatio || 1;
  const w = container.value.clientWidth, h = container.value.clientHeight;
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  c.style.width = `${w}px`; c.style.height = `${h}px`;
  redrawInk();
}

function drawMark(ctx, m, w, h) {
  ctx.strokeStyle = m.color; ctx.fillStyle = m.color;
  ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (m.kind === 'arrow') {
    const x0 = m.x0 * w, y0 = m.y0 * h, x1 = m.x1 * w, y1 = m.y1 * h;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const head = 12;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(ang - 0.42), y1 - head * Math.sin(ang - 0.42));
    ctx.lineTo(x1 - head * Math.cos(ang + 0.42), y1 - head * Math.sin(ang + 0.42));
    ctx.closePath(); ctx.fill();
  } else if (m.kind === 'rect') {
    ctx.strokeRect(
      Math.min(m.x0, m.x1) * w, Math.min(m.y0, m.y1) * h,
      Math.abs(m.x1 - m.x0) * w, Math.abs(m.y1 - m.y0) * h,
    );
  } else if (m.kind === 'curve') {
    if ((m.pts || []).length < 2) return;
    ctx.beginPath();
    m.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px * w, py * h) : ctx.moveTo(px * w, py * h)));
    ctx.stroke();
  } else if (m.kind === 'text') {
    ctx.font = `${m.px}px ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    ctx.fillText(m.text, m.x * w, m.y * h);
  }
}

function redrawInk() {
  const c = inkRef.value;
  const ctx = c ? c.getContext('2d') : null;
  if (!c || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, c.width / dpr, c.height / dpr);
  const w = c.width / dpr, h = c.height / dpr;
  for (const m of marks.value) drawMark(ctx, m, w, h);
  if (draft) drawMark(ctx, draft, w, h);
}

function inkPos(ev) {
  const r = inkRef.value.getBoundingClientRect();
  return {
    x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height,
    cx: ev.clientX - r.left, cy: ev.clientY - r.top,
  };
}

function inkDown(ev) {
  if (!tool.value) return;
  ev.preventDefault();
  const p = inkPos(ev);
  if (tool.value === 'text') {
    textAt.value = { x: p.cx, y: p.cy };
    textDraft.value = '';
    nextTick(() => textInput.value?.focus());
    return;
  }
  draft = tool.value === 'curve'
    ? { kind: 'curve', pts: [[p.x, p.y]], color: inkColor.value }
    : { kind: tool.value, x0: p.x, y0: p.y, x1: p.x, y1: p.y, color: inkColor.value };
  inkRef.value.setPointerCapture?.(ev.pointerId);
  redrawInk();
}

function inkMove(ev) {
  if (!draft) return;
  const p = inkPos(ev);
  if (draft.kind === 'curve') draft.pts.push([p.x, p.y]);
  else { draft.x1 = p.x; draft.y1 = p.y; }
  redrawInk();
}

function inkUp() {
  if (!draft) return;
  const m = draft;
  draft = null;
  // A click that barely moved is a slip, not a mark: drop it.
  const real = m.kind === 'curve' ? m.pts.length > 2 : Math.hypot(m.x1 - m.x0, m.y1 - m.y0) > 0.01;
  if (real) marks.value = [...marks.value, m];
  redrawInk();
}

function commitText() {
  const at = textAt.value;
  const t = textDraft.value.trim();
  textAt.value = null;
  textDraft.value = '';
  if (!at || !t || !inkRef.value) return;
  const r = inkRef.value.getBoundingClientRect();
  marks.value = [...marks.value, { kind: 'text', x: at.x / r.width, y: at.y / r.height, text: t, px: 14, color: inkColor.value }];
  redrawInk();
}

function toggleTool(id) {
  tool.value = tool.value === id ? null : id;
  draft = null;
  textAt.value = null;
  redrawInk();
}

function clearMarks() {
  marks.value = [];
  draft = null;
  redrawInk();
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

// The pose carries the up vector the PLANNER projected with, so the frame has to be
// drawn with it. Anything else rolls the picture relative to the maths that grounds
// it, and the roll is not recoverable: three.js resolves a degenerate lookAt (eye
// straight above or below the target with up = +Z) by nudging the view axis 0.0001,
// which is finite but arbitrary. The omni survey tier shoots exactly those two pole
// poses, so without this a regionBox a model draws on the top-down frame would
// ground to the wrong parts — confidently, and with no warning anywhere.
// Poses planned before the up vector was stamped fall back to model space Z-up.
function applyPoseUp(pose) {
  const up = Array.isArray(pose?.up) && pose.up.length === 3 && pose.up.every(Number.isFinite)
    ? pose.up : [0, 0, 1];
  camera.up.set(up[0], up[1], up[2]);
}

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
    theater: markersGroup ? markersGroup.visible : true,
    tour: tourGroup ? tourGroup.visible : true,
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
    if (markersGroup) markersGroup.visible = saved.theater ?? true;
    if (tourGroup) tourGroup.visible = saved.tour ?? true;
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
    if (markersGroup) markersGroup.visible = false;
    if (tourGroup) tourGroup.visible = false;
    clearHighlight();

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
    applyPoseUp(pose);                 // the planner's basis, not an assumed one
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
    updateHighlight();
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
    theater: markersGroup ? markersGroup.visible : true,
    tour: tourGroup ? tourGroup.visible : true,
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
    if (markersGroup) markersGroup.visible = false;
    if (tourGroup) tourGroup.visible = false;
    clearHighlight();
    applySolo();

    renderer.setPixelRatio(1);
    renderer.setSize(vp.w, vp.h, false);
    scene.background = saved.background;

    camera.fov = vp.fov;
    camera.aspect = vp.w / vp.h;
    applyPoseUp(pose);                 // the planner's basis, not an assumed one
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
    if (markersGroup) markersGroup.visible = saved.theater ?? true;
    if (tourGroup) tourGroup.visible = saved.tour ?? true;
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
    updateHighlight();
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
  // Markers depend on center/radius, so (re)build them once the model is placed.
  makeHighlightMaterial();
  rebuildMarkers();
  updateHighlight();
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

// ---- discovery theater: in-scene joint markers -----------------------------
// The 3D view is the primary process surface: every discovered joint is painted
// ONTO the mesh at its anchor, not only listed in the mid panel. Two encodings
// carry the honesty rule — COLOUR is the record's status (same palette the list
// chips use), and FILL is provenance: geometry/rigidity-derived marks are SOLID
// (measured), while ai/vision claims are HOLLOW wireframe until a human confirms
// them, so a guess never reads as a measurement. Marker size tracks confidence.
const STATUS_HEX = {
  confirmed: 0x3fb950, 'auto-accepted': 0x3fb950,
  'needs-verdict': 0xb58900,
  rejected: 0xe5484d,
  candidate: 0x8b949e,
};
let markersGroup = null;
let markerHits = [];        // sphere meshes the raycaster tests
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downX = 0, downY = 0;

function clearMarkers() {
  if (!markersGroup) return;
  for (const o of markersGroup.children) {
    o.traverse?.((c) => { c.geometry?.dispose?.(); c.material?.dispose?.(); });
  }
  markersGroup.clear();
  markerHits = [];
}

function buildMarker(j) {
  const color = STATUS_HEX[j.status] ?? STATUS_HEX.candidate;
  const size = Math.max(0.02, radius * 0.02) * (0.8 + 0.6 * (Number(j.confidence) || 0.5));
  const geo = new THREE.SphereGeometry(size, 16, 12);
  // FILL is provenance: a claim (ai/vision) stays HOLLOW wireframe while it is
  // still unjudged. A human verdict is a measurement, not a claim, so confirmed
  // and rejected marks go SOLID — that flip is the visible half of the gate.
  const hollow = (j.origin === 'ai' || j.origin === 'vision')
    && j.status !== 'confirmed' && j.status !== 'rejected';
  const mat = hollow
    ? new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.9 })
    : new THREE.MeshBasicMaterial({ color });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(j.anchor.x - center.x, j.anchor.y - center.y, j.anchor.z - center.z);
  m.userData.jointId = j.id;
  markersGroup.add(m);
  markerHits.push(m);

  // How the part is driven: a spin/hinge axis arrow, or a pitch+yaw pair (gimbal).
  const alen = radius * 0.12;
  const addArrow = (dir, col) => {
    const v = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
    if (v.lengthSq() < 1e-8) return;
    markersGroup.add(new THREE.ArrowHelper(v, m.position, alen, col, alen * 0.3, alen * 0.18));
  };
  if (j.type === 'gimbal') { addArrow([1, 0, 0], 0x7aa5c9); addArrow([0, 0, 1], 0x7aa5c9); }
  else if (j.axis) addArrow([j.axis.x, j.axis.y, j.axis.z], color);
}

// Markers always come from the live joint map: ONE source, so the theater can
// never disagree with the list about what is drawn.
function markerSource() { return state.joints || []; }

function rebuildMarkers() {
  if (!scene) return;
  if (!markersGroup) { markersGroup = new THREE.Group(); scene.add(markersGroup); }
  clearMarkers();
  if (!drone) return;
  const src = markerSource();
  // Only the selected joint's ball + axis arrows: the artifact tracks the
  // selection instead of decorating every joint at once.
  const j = src.find((x) => x.id === state.activeJointId);
  if (j?.anchor) buildMarker(j);
}

// ---- selected-joint mask: tint the joint's own components ------------------
// Clicking a joint in step 2 recolours the parts that BELONG to it (the exact set
// the preview drives) in one distinguishing colour, instead of drawing a wireframe
// box around them. A box only says "something lives in here"; a mask says WHICH
// meshes move together — which is the claim actually being verified. Originals are
// saved per-mesh and put back on deselect, so at any moment exactly ONE joint is
// masked and nothing about the model is mutated.
//
// The mask colour is chosen AGAINST the model, not fixed: we average the mesh's own
// material colours and take the complementary hue at an opposite lightness, so a
// dark craft gets a bright mask and a light craft a deep one. A fixed blue can
// vanish into a blue-ish model; a computed contrast cannot.
let highlightMat = null;
let highlighted = new Map();   // mesh -> its original material

function modelAverageColor() {
  const acc = { r: 0, g: 0, b: 0 }; let n = 0;
  drone.traverse((m) => {
    if (!m.isMesh) return;
    for (const mt of (Array.isArray(m.material) ? m.material : [m.material])) {
      if (mt?.color) { acc.r += mt.color.r; acc.g += mt.color.g; acc.b += mt.color.b; n++; }
    }
  });
  return n ? new THREE.Color(acc.r / n, acc.g / n, acc.b / n) : null;
}

function makeHighlightMaterial() {
  if (highlightMat) highlightMat.dispose();
  const hsl = { h: 0, s: 0, l: 0.5 };
  modelAverageColor()?.getHSL(hsl);
  // Complementary hue, pushed to an opposite lightness for maximum separation.
  const color = new THREE.Color().setHSL((hsl.h + 0.5) % 1, Math.max(0.7, hsl.s), hsl.l < 0.5 ? 0.62 : 0.38);
  highlightMat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05 });
}

function clearHighlight() {
  for (const [mesh, mat] of highlighted) mesh.material = mat;
  highlighted.clear();
}

function updateHighlight() {
  clearHighlight();
  if (!scene || !drone) return;
  const j = state.joints.find((x) => x.id === state.activeJointId);
  if (!j) return;
  if (!highlightMat) makeHighlightMaterial();
  // A drive set can contain a node AND its descendant, so traverse would visit a
  // mesh twice; saving its (already-tinted) material the second time would make
  // clearHighlight re-apply the mask to the old joint. Dedupe so each mesh stores
  // its TRUE original and switching joints restores cleanly.
  const seen = new Set();
  for (const o of driveSet(j)) {
    o.traverse((m) => {
      if (!m.isMesh || seen.has(m)) return;
      seen.add(m);
      highlighted.set(m, m.material);
      m.material = highlightMat;
    });
  }
}

function pickMarker(ev) {
  if (!renderer || !markerHits.length) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(markerHits, false);
  return hits.length ? hits[0].object.userData.jointId : null;
}

function onHover(ev) {
  if (state.discovering) return;   // input locked while the vision campaign looks
  const id = pickMarker(ev);
  if (!id) { hover.value = null; renderer.domElement.style.cursor = ''; return; }
  const j = markerSource().find((x) => x.id === id);
  renderer.domElement.style.cursor = 'pointer';
  hover.value = { id, label: j?.label || id, type: j?.type || '', status: j?.status || '', x: ev.clientX, y: ev.clientY };
}

function onDown(ev) { downX = ev.clientX; downY = ev.clientY; }
// A click that barely moved is a pick; a click after a drag was an orbit gesture.
function onClick(ev) {
  if (state.discovering) return;   // input locked while the vision campaign looks
  if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 4) return;
  const id = pickMarker(ev);
  if (id) selectJoint(id);
}

// ---- vision-round camera tour (post-hoc replay) ----------------------------
// The vision round is the part of discovery where the AI physically goes and
// looks: the NBV planner picks a handful of poses, a browser tab draws them, and
// the model reads the frames. That camera path is persisted with the round
// (plan.views[].pose), so the 3D view can REPLAY the tour: a glyph travelling
// stop to stop, and a filmstrip of the exact frames the model was handed,
// highlighted in sync. The camera PATH itself is deliberately NOT drawn — a
// polyline through the eye positions reads as visual noise over the machine and
// says nothing a filmstrip cannot, so only the moving glyph marks where the
// camera was. Post-hoc rather than live on
// purpose — a round's poses and frames are only complete once it finishes, and a
// replay of what actually happened is honest in a way a live guess-animation is not.
let tourGroup = null;
let tourGlyph = null;
const tour = ref(null);          // { round, stops:[{id,mode,url,eyeV,targetV}] }
let tourClock = 0;
const TOUR_SEC_PER_STOP = 1.4;

function clearTour() {
  if (tourGroup && scene) {
    scene.remove(tourGroup);
    tourGroup.traverse?.((c) => { c.geometry?.dispose?.(); c.material?.dispose?.(); });
  }
  tourGroup = null; tourGlyph = null; tour.value = null; tourClock = 0;
}

function buildTour(rec) {
  clearTour();
  if (!scene || !drone) return;
  const views = (rec?.plan?.views || []).filter((v) => Array.isArray(v.pose?.eye) && Array.isArray(v.pose?.target));
  if (!views.length) return;
  const frames = rec.frames || [];
  const urlFor = (vid) => (frames.find((f) => f.id === vid || f.id?.startsWith(`${vid}~`) || f.id?.includes(vid))?.url || null);
  tourGroup = new THREE.Group();
  const pts = views.map((v) => new THREE.Vector3(v.pose.eye[0] - center.x, v.pose.eye[1] - center.y, v.pose.eye[2] - center.z));
  // No trajectory polyline here on purpose (see the header note): only the glyph.
  tourGlyph = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.03, radius * 0.09, 12), new THREE.MeshBasicMaterial({ color: 0x7aa5c9 }));
  tourGroup.add(tourGlyph);
  scene.add(tourGroup);
  tour.value = {
    round: rec.round,
    stops: views.map((v, i) => ({
      id: v.id, mode: v.mode || 'photo', url: urlFor(v.id),
      eyeV: pts[i],
      targetV: new THREE.Vector3(v.pose.target[0] - center.x, v.pose.target[1] - center.y, v.pose.target[2] - center.z),
    })),
  };
  stepTourTo(0);
}

function stepTourTo(i) {
  const s = tour.value?.stops?.[i];
  if (!s || !tourGlyph) return;
  tourGlyph.position.copy(s.eyeV);
  tourGlyph.lookAt(s.targetV);
}

// One honest pass along the recorded camera path, then the path retires itself:
// the 3D view keeps only geometry (no screenshots), and it must not orbit forever.
function stepTour(dt) {
  if (!tour.value || !tourGlyph) return;
  tourClock += dt;
  const n = tour.value.stops.length;
  if (tourClock >= n * TOUR_SEC_PER_STOP) { clearTour(); return; }
  stepTourTo(Math.floor(tourClock / TOUR_SEC_PER_STOP) % n);
}

async function loadTour(round) {
  if (round == null) { clearTour(); return; }
  try {
    const d = await api.observation(round);
    if (d?.ok) buildTour(d); else clearTour();
  } catch { clearTour(); }
}

// ---- LIVE vision-campaign theater ------------------------------------------
// The chained campaign (geometry first, vision second) narrates itself over the
// events WS AS IT RUNS: the planned camera path, each frame the instant it is
// drawn, the model's proposals as dashed marks, and the battery's verdict that
// solidifies or fades them. Unlike the post-hoc tour above this is live — the
// point is to watch the AI look, not to review where it looked afterwards.
// Input is locked for the duration (state.discovering), so the theater cannot be
// steered, orbited or clicked mid-look; it unlocks the moment the campaign ends.
let liveGroup = null;
let liveGlyph = null;
let liveStops = new Map();     // viewId -> { eyeV, targetV }
let liveMarks = new Map();     // proposal id -> mesh (a claim, drawn dashed)
let liveCursor = 0;            // visionFeed beats already animated
let liveClearTimer = 0;

function clearLive() {
  clearTimeout(liveClearTimer);
  if (liveGroup && scene) {
    scene.remove(liveGroup);
    liveGroup.traverse?.((c) => { c.geometry?.dispose?.(); c.material?.dispose?.(); });
  }
  liveGroup = null; liveGlyph = null; liveStops = new Map(); liveMarks = new Map();
}

function ensureLive() {
  if (!liveGroup && scene) { liveGroup = new THREE.Group(); scene.add(liveGroup); }
  return liveGroup;
}

// Anchors arrive as {x,y,z} objects (manifest records) while plan poses arrive as
// [x,y,z] arrays (plan.views[].pose); accept both rather than trusting one shape.
const liveNum = (p) => (Array.isArray(p) ? p : [p?.x, p?.y, p?.z]);
const liveOk = (p) => liveNum(p).every((n) => Number.isFinite(n));
const liveV = (p) => {
  const a = liveNum(p);
  return new THREE.Vector3(a[0] - center.x, a[1] - center.y, a[2] - center.z);
};

function livePlan(views) {
  if (!scene || !drone) return;
  ensureLive();
  const pts = [];
  for (const v of views) {
    if (!liveOk(v.eye) || !liveOk(v.target)) continue;
    const eyeV = liveV(v.eye); const targetV = liveV(v.target);
    liveStops.set(v.id, { eyeV, targetV });
    pts.push(eyeV);
  }
  // Only the travelling glyph is drawn, never the connecting polyline: the camera
  // trajectory over the machine reads as clutter and the filmstrip already shows
  // where each stop looked.
  liveGlyph = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.03, radius * 0.09, 12), new THREE.MeshBasicMaterial({ color: 0x7aa5c9 }));
  liveGroup.add(liveGlyph);
  if (pts.length) liveGlyph.position.copy(pts[0]);
}

function liveFrame(msg) {
  // The frame itself rides the chat as the assistant's self-talk; here only the
  // camera glyph moves, so the 3D view stays geometry-only.
  const s = liveStops.get(msg.viewId);
  if (liveGlyph && s) { liveGlyph.position.copy(s.eyeV); liveGlyph.lookAt(s.targetV); }
}

// A proposal is a CLAIM, so it is drawn dashed (wireframe) until the battery or a
// human says otherwise — the same discipline as the revision halo: the 3D view
// must never make a guess look like a measurement.
function livePropose(entries) {
  if (!scene || !drone) return;
  ensureLive();
  for (const en of entries) {
    if (!liveOk(en.anchor) || liveMarks.has(en.id)) continue;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.05, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xb58900, wireframe: true }),
    );
    m.position.copy(liveV(en.anchor));
    liveGroup.add(m);
    liveMarks.set(en.id, m);
  }
}

function liveVerdict(msg) {
  const added = new Set(msg.proposals || []);
  for (const [id, m] of liveMarks) {
    if (added.has(id)) { m.material.color.setHex(0x3fb950); m.material.wireframe = false; }
    else m.material.color.setHex(0xe5484d);
  }
  // The real markers refresh from state.joints a moment later; retire the claim
  // marks so the two never overlap into a double image.
  liveClearTimer = setTimeout(() => {
    for (const [, m] of liveMarks) { liveGroup?.remove(m); m.geometry?.dispose?.(); m.material?.dispose?.(); }
    liveMarks = new Map();
  }, 2600);
}

function handleVision(msg) {
  switch (msg.kind) {
    case 'vision:start': clearLive(); break;
    case 'vision:plan': livePlan(msg.views || []); break;
    case 'vision:frame': liveFrame(msg); break;
    case 'vision:propose': livePropose(msg.entries || []); break;
    case 'vision:verdict': liveVerdict(msg); break;
    case 'vision:end':
      liveClearTimer = setTimeout(clearLive, 4000);
      break;
    case 'vision:skip':
      liveClearTimer = setTimeout(clearLive, 4000);
      break;
    default: break;
  }
}

// Drain the feed: animate only beats not yet seen, so a re-render never replays.
// A length SMALLER than the cursor means the store reset the feed for a new
// campaign, so the cursor rewinds instead of swallowing the new start beat.
watch(() => state.visionFeed.length, () => {
  if (state.visionFeed.length < liveCursor) liveCursor = 0;
  while (liveCursor < state.visionFeed.length) handleVision(state.visionFeed[liveCursor++]);
});

// ---- verdict flash: make amortization VISIBLE --------------------------------
// A verdict can travel to symmetry peers (the four rotors are one decision, not
// four). The list chips say "inherited", but in 3D the inheritance is drawn: for
// ~2.6s after a verdict, a line runs from the judged joint to every peer that
// took the decision, tipped with a cone pointing back at the source — so "a
// person looked at THIS rotor" and "at its mirror" never read as the same claim.
let flashGroup = null;
let flashTimer = 0;

function clearFlash() {
  clearTimeout(flashTimer);
  if (flashGroup && scene) {
    scene.remove(flashGroup);
    flashGroup.traverse?.((c) => { c.geometry?.dispose?.(); c.material?.dispose?.(); });
  }
  flashGroup = null;
}

function flashVerdict(f) {
  if (!scene || !drone || !f) return;
  clearFlash();
  const from = state.joints.find((j) => j.id === f.id);
  if (!from?.anchor || !(f.peers || []).length) return;
  const col = f.decision === 'reject' ? 0xe5484d : 0x3fb950;
  flashGroup = new THREE.Group();
  const a = liveV(from.anchor);
  for (const pid of f.peers) {
    const p = state.joints.find((j) => j.id === pid);
    if (!p?.anchor) continue;
    const b = liveV(p.anchor);
    flashGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: col }),
    ));
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(radius * 0.02, radius * 0.06, 10),
      new THREE.MeshBasicMaterial({ color: col }),
    );
    cone.position.copy(b);
    cone.lookAt(a);            // +Z faces the judged joint…
    cone.rotateX(Math.PI / 2); // …and the tip (+Y) follows it: "inherited FROM"
    flashGroup.add(cone);
  }
  scene.add(flashGroup);
  flashTimer = setTimeout(clearFlash, 2600);
}

watch(() => state.verdictFlash, (f) => { if (f) flashVerdict(f); });

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
watch(() => state.joints, rebuildMarkers, { deep: true });
watch(() => state.activeJointId, () => { rebuildMarkers(); updateHighlight(); });
watch(() => state.tourRound, loadTour);
watch(() => state.activeJointId, teardownPivot);
watch(() => themeState.mode, applySceneTheme);   // re-tint the 3D scene on theme switch
// While a discovery/vision op is in flight the 3D view is a theater, not a
// control surface: orbit off, picks ignored. Restored the instant it settles.
watch(() => state.discovering, (d) => {
  if (orbit) orbit.enabled = !d;
  if (d) { hover.value = null; if (renderer) renderer.domElement.style.cursor = ''; }
});

onMounted(() => {
  initScene();
  tick();
  sizeInk();
  addEventListener('resize', resize);
  registerViewerCapture(captureFrame);
  registerViewerCaptureAt(captureAt);
  registerViewerCaptureMotion(captureMotion);
  renderer.domElement.addEventListener('pointermove', onHover);
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('click', onClick);
  announceModel();
  if (state.viewer.glb) reload();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  removeEventListener('resize', resize);
  renderer?.domElement?.removeEventListener('pointermove', onHover);
  renderer?.domElement?.removeEventListener('pointerdown', onDown);
  renderer?.domElement?.removeEventListener('click', onClick);
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
    <!-- annotation layer: click-through unless a pen is armed -->
    <canvas
      ref="inkRef" class="ink" :class="{ on: !!tool }"
      @pointerdown="inkDown" @pointermove="inkMove" @pointerup="inkUp" @pointercancel="inkUp"
    ></canvas>
    <div class="pens">
      <button
        v-for="t in TOOLS" :key="t.id" type="button"
        :class="{ on: tool === t.id }" :title="t.title" @click="toggleTool(t.id)"
      >
        <svg
          class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path :d="t.path" /></svg>
      </button>
      <input type="color" v-model="inkColor" title="Ink colour" />
      <button v-if="marks.length" type="button" class="clear" title="Clear every mark" @click="clearMarks">✕</button>
    </div>
    <input
      v-if="textAt" ref="textInput" v-model="textDraft" class="inktext"
      :style="{ left: textAt.x + 'px', top: textAt.y + 'px', color: inkColor }"
      placeholder="type… Enter places · Esc cancels"
      @keydown.enter.prevent="commitText"
      @keydown.escape.prevent="textAt = null"
      @blur="commitText"
    />
    <div v-if="status" class="status">{{ status }}</div>
    <div v-if="hover" class="tip" :style="{ left: hover.x + 12 + 'px', top: hover.y + 12 + 'px' }">
      {{ hover.label }} · {{ hover.type }} · {{ hover.status }}
    </div>
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
.tip {
  position: fixed; z-index: 60; pointer-events: none; white-space: nowrap;
  background: var(--overlay-bg); color: var(--text-dim); border: 1px solid var(--border-2);
  border-radius: 6px; padding: 3px 7px; font-family: ui-monospace, monospace; font-size: 11px;
}

/* annotation layer + pens: the human's markup over the 3D view */
.ink { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
.ink.on { pointer-events: auto; cursor: crosshair; }
.pens {
  position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 20;
  display: flex; align-items: center; gap: 3px;
  background: var(--overlay-bg); border: 1px solid var(--border-2); border-radius: 8px;
  padding: 4px 6px;
}
.pens button {
  width: 26px; height: 24px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--text-dim); cursor: pointer; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
}
.pens button .pic { width: 18px; height: 18px; display: block; }
.pens button:hover { background: var(--surface-3); }
.pens button.on { border-color: var(--accent-2); color: var(--text); background: var(--item-active); }
.pens button.clear { color: var(--muted); font-size: 12px; }
.pens input[type='color'] {
  width: 26px; height: 24px; padding: 0; border: none; background: transparent; cursor: pointer;
}
.inktext {
  position: absolute; z-index: 30; min-width: 150px;
  background: var(--overlay-bg); border: 1px dashed currentColor; border-radius: 4px;
  padding: 2px 5px; font-family: ui-monospace, monospace; font-size: 14px; outline: none;
}
</style>

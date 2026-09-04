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
import { registerViewerCapture } from '../composables/useViewerCapture.js';

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
function rotorAssemblyNodes(j, base) {
  const a = { x: j.anchor.x - center.x, y: j.anchor.y - center.y, z: j.anchor.z - center.z };
  let R = 0.5;
  for (const o of base) {
    const p = restWorld.get(o.name);
    if (p) R = Math.max(R, Math.hypot(p.x - a.x, p.z - a.z));
  }
  const dyTol = R * 1.5;
  const inDisc = (p) => Math.hypot(p.x - a.x, p.z - a.z) <= R && Math.abs(p.y - a.y) <= dyTol;
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
  const base = jointNodeObjects(j);
  const nodes = j.type === 'rotor' ? rotorAssemblyNodes(j, base) : base;
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
    previewAngle = (previewAngle + speed * 36 * dir * dt) % 360;
    pivot.rotation.y = previewAngle * DEG2RAD;
    publishGimbal(0, 0, now);
  } else if (j.type === 'gimbal') {
    const p = Number(kv.pitch || 0);
    const y = Number(kv.yaw || 0);
    pivot.rotation.x = p * DEG2RAD;
    pivot.rotation.y = y * DEG2RAD;
    publishGimbal(p, y, now);
  } else {
    pivot.rotation.y = Number(kv.angle || 0) * DEG2RAD;
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
  if (state.viewer.glb) reload();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  removeEventListener('resize', resize);
  registerViewerCapture(null);
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

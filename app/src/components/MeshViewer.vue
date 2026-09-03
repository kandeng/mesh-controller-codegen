<script setup>
// MeshViewer — Vue port of viewer/viewer.html. Owns the three.js scene and the
// controller lifecycle, but instead of inline DOM sliders it drives the controller
// through the viewer bridge (which reacts to the data-driven knobs) and publishes
// readouts back to the store. Also renders the active joint's viewer-overlay slot
// (spin-axis marker at the joint anchor).
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useViewerBridge } from '../composables/useViewerBridge.js';
import { useTheme } from '../composables/useTheme.js';

const { state } = useProjectStore();
const bridge = useViewerBridge();
const { state: themeState } = useTheme();

const container = ref(null);
const status = ref('');

let renderer, scene, camera, orbit, clock, raf = 0;
let drone = null, center = new THREE.Vector3(), radius = 1;
let overlay = null, grid = null;
let loadedGlb = null, loadedCtl = null, ctl = null;

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
  try { ctl?.update(dt); } catch (e) { status.value = `update() threw: ${e.message}`; }
  orbit.update();
  renderer.render(scene, camera);
}

async function loadModel(url) {
  if (!url || url === loadedGlb) return;
  if (drone) { scene.remove(drone); drone = null; }
  loadedGlb = url;
  status.value = `loading mesh…`;
  const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
  drone = gltf.scene;
  scene.add(drone);
  const box = new THREE.Box3().setFromObject(drone);
  const size = box.getSize(new THREE.Vector3());
  center = box.getCenter(new THREE.Vector3());
  radius = Math.max(size.x, size.y, size.z) || 1;
  drone.position.sub(center);
  camera.position.set(radius * 1.8, radius * 1.2, radius * 1.8);
  camera.far = radius * 20; camera.updateProjectionMatrix();
  orbit.target.set(0, 0, 0);
  orbit.update();
  status.value = '';
}

async function loadController(url) {
  if (!url || url === loadedCtl) return;
  loadedCtl = url;
  bridge.setController(null);
  ctl = null;
  try {
    const mod = await import(/* @vite-ignore */ url);
    if (!drone) return;
    ctl = mod.createDroneController(drone, THREE);
    bridge.setController(ctl);
    status.value = `controller: ${url.split('/').pop()}`;
  } catch (e) {
    status.value = `controller import failed: ${e.message}`;
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
    await loadController(state.viewer.ctl);
    updateOverlay();
  } catch (e) {
    status.value = `load failed: ${e.message}`;
  }
}

watch(() => state.viewer.glb, reload);
watch(() => state.viewer.ctl, reload);
watch(() => [state.activeJointId, state.slotGraph], updateOverlay, { deep: true });
watch(() => themeState.mode, applySceneTheme);   // re-tint the 3D scene on theme switch

onMounted(() => {
  initScene();
  tick();
  addEventListener('resize', resize);
  if (state.viewer.glb) reload();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  removeEventListener('resize', resize);
  bridge.setController(null);
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

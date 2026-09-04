<script setup>
// ControlPanel — the mid pane, restructured as a guided top-to-bottom workflow:
//   1. Load the mesh (.glb)
//   2. Load an existing controller script, OR have the AI generate one to a path you choose
//   3. The controllable joints the AI discovered
//   4. Drive each joint's knobs and verify the live 3D behavior
//
// File picking calls the backend's NATIVE OS dialog (POST /api/fs/pick), which is
// the only way to obtain a real absolute path — a sandboxed browser can never
// expose one. Every path field also stays editable, so manual entry works even
// when no dialog tool is installed (the backend then returns ok:false).
import { ref } from 'vue';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useKernelApi } from '../composables/useKernelApi.js';
import { useSlotRouting } from '../composables/useSlotRouting.js';
import JointList from './JointList.vue';
import KnobPanel from './KnobPanel.vue';

const { state } = useProjectStore();
const api = useKernelApi();
const { selectJoint } = useSlotRouting();

// Step 1 — mesh
const glbPath = ref('samples/drone_dji_inspire3.glb');
const glbFull = ref('');
// Step 2 — controller (load existing / generate new)
const controllerPath = ref('samples/drone-controller.js');
const controllerFull = ref('');
const outPath = ref('');
const outFull = ref('');
const lang = ref('javascript');
const note = ref('');

// Open a native file dialog via the backend; resolve to the chosen absolute path.
async function pick(mode, opts) {
  state.busy = true; state.error = null;
  try {
    const r = await api.pickFile({ mode, ...opts });
    if (r.ok && !r.canceled && r.path) return r.path;
    if (!r.ok) state.error = r.error || 'file dialog unavailable';
    return null;
  } catch (e) {
    state.error = e.message;
    return null;
  } finally {
    state.busy = false;
  }
}

async function loadMesh() {
  const p = glbPath.value.trim();
  if (!p) { state.error = 'choose a .glb mesh first'; return; }
  state.busy = true; state.error = null; note.value = '';
  try {
    const r = await api.loadProject(p);
    if (!r.ok) throw new Error(r.error || 'load failed');
    state.loaded = true;
    state.glb = r.glb;
    glbFull.value = r.glb || p;              // full resolved path, displayed below
    state.stats = r.stats;
    state.joints = r.joints;
    state.viewer = r.viewer;
    state.validation = null;
    controllerFull.value = '';
    note.value = `discovered ${r.joints.length} joint units · ${r.stats.count} nodes`;
    if (r.joints.length) await selectJoint(r.joints[0].id);
  } catch (e) { state.error = e.message; }
  finally { state.busy = false; }
}

async function browseMesh() {
  const p = await pick('open', { title: 'Select a .glb mesh', filterName: 'Mesh', patterns: ['glb', 'gltf'] });
  if (p) { glbPath.value = p; await loadMesh(); }
}

async function loadController() {
  const p = controllerPath.value.trim();
  if (!p) { state.error = 'choose a controller script first'; return; }
  state.busy = true; state.error = null; note.value = '';
  try {
    const r = await api.validate(p);
    if (!r.ok) throw new Error(r.error || 'validate failed');
    state.validation = { pass: r.pass, failures: r.failures, warnings: r.warnings, metrics: r.metrics };
    state.viewer = r.viewer;
    controllerFull.value = r.controller || p;   // full resolved path, displayed below
    note.value = r.pass ? 'controller loaded · validation PASS' : `controller loaded · validation FAIL · ${r.failures?.[0] || ''}`;
  } catch (e) { state.error = e.message; }
  finally { state.busy = false; }
}

async function browseController() {
  const p = await pick('open', { title: 'Select a controller script', filterName: 'Controller', patterns: ['js', 'mjs', 'cjs'] });
  if (p) { controllerPath.value = p; await loadController(); }
}

// Save dialog: the user navigates to a folder (creating one if needed) and types
// a file name; the generated controller is written there.
async function browseOut() {
  const p = await pick('save', { title: 'Choose where to generate the controller', filterName: 'Controller', patterns: ['js', 'mjs'], defaultName: 'controller.mjs' });
  if (p) { outPath.value = p; outFull.value = p; }
}

async function generate() {
  state.busy = true; state.error = null; note.value = 'generating via DSH (this can take minutes)…';
  try {
    const r = await api.generate({ lang: lang.value, out: outPath.value.trim() || null });
    if (!r.ok) throw new Error(r.error || 'generate failed');
    state.validation = { pass: r.accepted, failures: r.failures, warnings: r.warnings, metrics: r.metrics };
    state.viewer = r.viewer;
    if (r.controller) { outPath.value = r.controller; outFull.value = r.controller; }
    note.value = r.accepted ? `generated + accepted in ${r.roundsUsed} round(s)` : `generation failed after ${r.roundsUsed} round(s)`;
  } catch (e) { state.error = e.message; note.value = ''; }
  finally { state.busy = false; }
}
</script>

<template>
  <div class="control-panel">
    <!-- slim connection / activity bar -->
    <div class="statusbar">
      <span class="dot" :class="{ on: state.connected }" :title="state.connected ? 'event stream connected' : 'disconnected'"></span>
      <span v-if="state.error" class="err">{{ state.error }}</span>
      <span v-else class="note">{{ note || (state.loaded ? `${state.stats?.count} nodes · radius ${state.stats?.radius?.toFixed?.(1)}` : 'idle') }}</span>
      <span v-if="state.busy" class="busy">working…</span>
    </div>

    <!-- STEP 1 — load the mesh -->
    <section class="step">
      <header class="step-head"><span class="num">1</span><span class="title">Load the mesh (<code>.glb</code>)</span></header>
      <div class="row">
        <input v-model="glbPath" type="text" placeholder="path to .glb mesh" :disabled="state.busy" @keyup.enter="loadMesh" />
        <button @click="browseMesh" :disabled="state.busy" title="Open a file dialog to pick a .glb">Browse…</button>
        <button class="primary" @click="loadMesh" :disabled="state.busy">Load</button>
      </div>
      <p v-if="glbFull" class="pathline"><span class="tick">✓</span><span class="path">{{ glbFull }}</span></p>
    </section>

    <hr class="rule" />

    <!-- STEP 2 — controller: load existing, or generate -->
    <section class="step">
      <header class="step-head"><span class="num">2</span><span class="title">Load or generate the controller script</span></header>
      <p class="hint">Already have a controller? Load it. Otherwise, let the AI generate one.</p>

      <div class="sub">
        <label class="sublabel">Load an existing script:</label>
        <div class="row">
          <input v-model="controllerPath" type="text" placeholder="path to controller .js" :disabled="state.busy || !state.loaded" @keyup.enter="loadController" />
          <button @click="browseController" :disabled="state.busy || !state.loaded" title="Open a file dialog to pick a controller">Browse…</button>
          <button class="primary" @click="loadController" :disabled="state.busy || !state.loaded">Load</button>
        </div>
        <p v-if="controllerFull" class="pathline"><span class="tick">✓</span><span class="path">{{ controllerFull }}</span></p>
      </div>

      <div class="sub">
        <label class="sublabel">Or choose where to generate a new one:</label>
        <div class="row">
          <input v-model="outPath" type="text" placeholder="destination path (optional)" :disabled="state.busy || !state.loaded" />
          <button @click="browseOut" :disabled="state.busy || !state.loaded" title="Choose a destination folder + file name (creates them)">Browse…</button>
        </div>
        <p v-if="outFull" class="pathline"><span class="tick">↳</span><span class="path">{{ outFull }}</span></p>
        <div class="row genrow">
          <select v-model="lang" :disabled="state.busy || !state.loaded">
            <option value="javascript">javascript</option>
            <option value="python" disabled>python (M2)</option>
            <option value="csharp" disabled>csharp (M2)</option>
          </select>
          <button class="gen" @click="generate" :disabled="state.busy || !state.loaded">Generate (DSH)</button>
        </div>
      </div>
    </section>

    <hr class="rule" />

    <!-- STEP 3 — discovered joints -->
    <section class="step">
      <header class="step-head"><span class="num">3</span><span class="title">Controllable joints the AI found</span></header>
      <p class="hint">Missing a joint? Tell the AI in the chatbot.</p>
      <JointList />
    </section>

    <hr class="rule" />

    <!-- STEP 4 — verify with the knobs -->
    <section class="step">
      <header class="step-head"><span class="num">4</span><span class="title">Verify each joint's controller</span></header>
      <p class="hint">Select each joint and watch the 3D mesh on the left. If something looks wrong, message or screenshot the chatbot to ask the AI for a fix.</p>
      <KnobPanel />
    </section>
  </div>
</template>

<style scoped>
.control-panel { display: flex; flex-direction: column; gap: 14px; font-size: 13px; }

/* status bar */
.statusbar { display: flex; align-items: center; gap: 8px; font-size: 11px; font-family: ui-monospace, monospace; color: var(--muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dot-off); flex: none; }
.dot.on { background: var(--dot-on); box-shadow: 0 0 6px var(--dot-on); }
.note { flex: 1; color: var(--good); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.err { flex: 1; color: var(--bad); }
.busy { color: var(--busy); }

/* steps */
.step { display: flex; flex-direction: column; gap: 8px; }
.step-head { display: flex; align-items: center; gap: 8px; }
.num {
  flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
  font-size: 11px; font-weight: 700; font-family: ui-monospace, monospace; background: var(--accent); color: #fff;
}
.title { color: var(--text); font-weight: 600; font-size: 13px; }
.title code { color: var(--value); background: var(--surface-3); padding: 0 4px; border-radius: 4px; font-size: 12px; }
.hint { color: var(--faint); font-size: 12px; margin: 0; line-height: 1.45; }

/* nested sub-options in step 2 */
.sub { display: flex; flex-direction: column; gap: 6px; padding-left: 10px; border-left: 2px solid var(--border-2); }
.sublabel { color: var(--text-dim); font-size: 12px; }

/* rows + form controls */
.row { display: flex; gap: 6px; align-items: center; }
.genrow { margin-top: 2px; }
.row input[type=text] { flex: 1; min-width: 0; }
input, select {
  background: var(--input-bg); border: 1px solid var(--border-2); border-radius: 7px; color: var(--text);
  padding: 7px 9px; font-size: 12px; font-family: ui-monospace, monospace;
}
select { padding: 6px 8px; }
input:focus, select:focus { outline: none; border-color: var(--border-accent); }
button {
  background: var(--panel-2); border: 1px solid var(--border-accent); border-radius: 7px; color: var(--text-btn);
  padding: 7px 11px; cursor: pointer; font-size: 12px; white-space: nowrap;
}
button:hover:not(:disabled) { background: var(--btn-hover); }
button:disabled { opacity: .45; cursor: default; }
button.primary { border-color: var(--accent); }
button.gen { border-color: var(--gen-border); color: var(--gen-text); }

/* resolved-path readout */
.pathline { display: flex; gap: 6px; align-items: baseline; margin: 2px 0 0; }
.tick { color: var(--good); flex: none; }
.path { font-family: ui-monospace, monospace; font-size: 11px; color: var(--value); word-break: break-all; }

/* static (non-draggable) horizontal divider between steps */
.rule { height: 0; border: none; border-top: 1px solid var(--border); margin: 2px 0; }
</style>

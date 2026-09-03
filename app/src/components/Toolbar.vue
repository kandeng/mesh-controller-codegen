<script setup>
// Toolbar — the M1 control surface (the assistant is stubbed, so the pipeline is
// driven directly here). Load a mesh -> discover joints; validate an existing
// controller; or generate one via DSH. Results flow into the store, which drives
// the viewer + knobs.
import { ref } from 'vue';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useKernelApi } from '../composables/useKernelApi.js';
import { useSlotRouting } from '../composables/useSlotRouting.js';

const { state } = useProjectStore();
const api = useKernelApi();
const { selectJoint } = useSlotRouting();

const glbPath = ref('samples/drone_dji_inspire3.glb');
const controllerPath = ref('drone-controller.js');
const lang = ref('javascript');
const note = ref('');

async function loadMesh() {
  state.busy = true; state.error = null; note.value = '';
  try {
    const r = await api.loadProject(glbPath.value.trim());
    if (!r.ok) throw new Error(r.error || 'load failed');
    state.loaded = true;
    state.glb = r.glb;
    state.stats = r.stats;
    state.joints = r.joints;
    state.viewer = r.viewer;
    state.validation = null;
    note.value = `discovered ${r.joints.length} joint units · ${r.stats.count} nodes`;
    if (r.joints.length) await selectJoint(r.joints[0].id);
  } catch (e) { state.error = e.message; }
  finally { state.busy = false; }
}

async function validate() {
  state.busy = true; state.error = null; note.value = '';
  try {
    const r = await api.validate(controllerPath.value.trim());
    if (!r.ok) throw new Error(r.error || 'validate failed');
    state.validation = { pass: r.pass, failures: r.failures, warnings: r.warnings, metrics: r.metrics };
    state.viewer = r.viewer;
    note.value = r.pass ? `validation PASS · rpmIdle=${r.metrics?.rpmIdle}` : `validation FAIL · ${r.failures?.[0] || ''}`;
  } catch (e) { state.error = e.message; }
  finally { state.busy = false; }
}

async function generate() {
  state.busy = true; state.error = null; note.value = 'generating via DSH (this can take minutes)…';
  try {
    const r = await api.generate({ lang: lang.value });
    if (!r.ok) throw new Error(r.error || 'generate failed');
    state.validation = { pass: r.accepted, failures: r.failures, warnings: r.warnings, metrics: r.metrics };
    state.viewer = r.viewer;
    note.value = r.accepted ? `generated + accepted in ${r.roundsUsed} round(s)` : `generation failed after ${r.roundsUsed} round(s)`;
  } catch (e) { state.error = e.message; note.value = ''; }
  finally { state.busy = false; }
}
</script>

<template>
  <div class="toolbar">
    <div class="group">
      <input v-model="glbPath" type="text" placeholder="GLB path" :disabled="state.busy" />
      <button @click="loadMesh" :disabled="state.busy">Load mesh</button>
    </div>
    <div class="group">
      <input v-model="controllerPath" type="text" placeholder="controller path" :disabled="state.busy" />
      <button @click="validate" :disabled="state.busy || !state.loaded">Validate</button>
    </div>
    <div class="group">
      <select v-model="lang" :disabled="state.busy">
        <option value="javascript">javascript</option>
        <option value="python" disabled>python (M2)</option>
        <option value="csharp" disabled>csharp (M2)</option>
      </select>
      <button class="gen" @click="generate" :disabled="state.busy || !state.loaded">Generate (DSH)</button>
    </div>

    <div class="statusbar">
      <span class="dot" :class="{ on: state.connected }" :title="state.connected ? 'event stream connected' : 'disconnected'"></span>
      <span v-if="state.error" class="err">{{ state.error }}</span>
      <span v-else class="note">{{ note || (state.loaded ? `${state.stats?.count} nodes · radius ${state.stats?.radius?.toFixed?.(1)}` : 'idle') }}</span>
      <span v-if="state.busy" class="busy">working…</span>
    </div>
  </div>
</template>

<style scoped>
.toolbar { display: flex; flex-direction: column; gap: 8px; }
.group { display: flex; gap: 6px; }
.group input[type=text] { flex: 1; min-width: 0; }
input, select {
  background: var(--input-bg); border: 1px solid var(--border-2); border-radius: 7px; color: var(--text);
  padding: 7px 9px; font-size: 12px; font-family: ui-monospace, monospace;
}
input:focus, select:focus { outline: none; border-color: var(--border-accent); }
button {
  background: var(--panel-2); border: 1px solid var(--border-accent); border-radius: 7px; color: var(--text-btn);
  padding: 7px 12px; cursor: pointer; font-size: 12px; white-space: nowrap;
}
button:hover:not(:disabled) { background: var(--btn-hover); }
button:disabled { opacity: .45; cursor: default; }
button.gen { border-color: var(--gen-border); color: var(--gen-text); }
.statusbar { display: flex; align-items: center; gap: 8px; font-size: 11px; font-family: ui-monospace, monospace; color: var(--muted); margin-top: 2px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dot-off); flex: none; }
.dot.on { background: var(--dot-on); box-shadow: 0 0 6px var(--dot-on); }
.note { flex: 1; color: var(--good); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.err { flex: 1; color: var(--bad); }
.busy { color: var(--busy); }
</style>

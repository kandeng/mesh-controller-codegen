<script setup>
// ControlPanel — the mid pane, a guided top-to-bottom workflow:
//   1. Load the mesh (.glb)
//   2. The controllable joints the AI discovered (the 3D view is the process surface)
//   3. Drive each joint's knobs and verify the live 3D motion (pre-generation)
//   4. Generate the controller script (last — its input is the judged joint map)
//
// There is deliberately no "load an existing controller" step: generation always
// self-validates every round, so a separate validate path added a second way to
// reach the same result and a place for a stale script to masquerade as current.
// File picking calls the backend's NATIVE OS dialog (POST /api/fs/pick), which is
// the only way to obtain a real absolute path — a sandboxed browser can never
// expose one. Every path field also stays editable, so manual entry works even
// when no dialog tool is installed (the backend then returns ok:false).
import { computed, ref } from 'vue';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useKernelApi } from '../composables/useKernelApi.js';
import { useSlotRouting } from '../composables/useSlotRouting.js';
import JointList from './JointList.vue';
import KnobPanel from './KnobPanel.vue';

const { state } = useProjectStore();
const api = useKernelApi();
const { selectJoint } = useSlotRouting();

// How many claims are still waiting on a person. Shown in the step-4 hint because
// a gate nobody knows is pending is a gate that gets waved through, and the count
// is the one number that says "there is reading to do here".
const pending = computed(() => state.joints.filter((j) => j.status === 'needs-verdict').length);

// Step 2 readout — the vision lane's category GUESS set against what was actually
// grounded. Both numbers are always shown side by side, because a prior on its own
// reads like a finding, and the whole point of the lane is that a guess is never a
// joint: it aims the camera and it falsifies a count, and nothing else. Amber
// while anything expected is still missing, green once every expectation is
// grounded. Not shown at all when the model declined to name a category or was not
// confident enough to aim with — which leaves the panel saying exactly what it said
// before this lane existed.
const expectReadout = computed(() => {
  const exp = state.expectation;
  if (!exp?.usable || !(exp.instances || []).length) return null;
  const gaps = new Map((Array.isArray(state.gaps) ? state.gaps : []).map((g) => [g.type, g]));
  const perType = new Map();
  for (const ins of exp.instances) {
    if (!ins?.type) continue;
    const g = gaps.get(ins.type);
    const cur = perType.get(ins.type) || { type: ins.type, expected: 0, found: 0 };
    cur.expected += Number(ins.count) || 0;
    cur.found = g ? (g.found || 0) : cur.found;
    perType.set(ins.type, cur);
  }
  const parts = [...perType.values()];
  if (!parts.length) return null;
  const missing = parts.reduce((n, p) => n + Math.max(0, p.expected - p.found), 0);
  // Grounded types the guess did NOT expect are the most interesting line here: it
  // is where an unknown machine contradicts its own category (a tank's tracks, an
  // arm's extra hinge), and it is counted from the served joint list because the
  // gap table only covers expected types.
  const wanted = new Set(parts.map((p) => p.type));
  const unplanned = {};
  for (const j of state.joints || []) {
    if (!j?.type || j.status === 'rejected' || wanted.has(j.type)) continue;
    unplanned[j.type] = (unplanned[j.type] || 0) + 1;
  }
  const extraKeys = Object.keys(unplanned);
  return {
    category: exp.category || 'an unnamed machine',
    text: parts.map((p) => `${p.type}: expected ${p.expected}, grounded ${p.found}`).join(' · '),
    extra: extraKeys.length
      ? `also grounded, which the guess did not expect: ${extraKeys.map((k) => `${unplanned[k]} ${k}`).join(', ')}`
      : '',
    missing,
    ok: missing === 0,
  };
});

// Step 1 — mesh
const glbPath = ref('samples/drone_dji_inspire3.glb');
const glbFull = ref('');
// Step 4 — generate (language + destination); discovery and verification come first
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
  // The 3D view and knobs lock and the phase reads 'decompose' while the kernel
  // parses + clusters. Staged discovery then keeps its OWN lock (`refine:start` sets
  // `discovering` for stage 1, and `discover:stage` drops it when stage 2 begins —
  // stage 2 captures no frames, so there is no camera to collide with).
  state.discovering = true; state.phase = 'decompose';
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
    note.value = `discovered ${r.joints.length} joint units · ${r.stats.count} nodes`;
    // Discovery is staged: at load every record is still a CANDIDATE (the battery is
    // deferred to stage 2), so there is nothing trustworthy to highlight yet. Select
    // the first joint that has actually been checked, and otherwise let the viewer
    // stay empty until stage 2 settles one — auto-selecting a candidate would drive
    // the preview pivot off a membership the checks may still revise.
    const ready = r.joints.find((j) => j.status !== 'candidate');
    if (ready) await selectJoint(ready.id);
  } catch (e) { state.error = e.message; }
  // Only clear the lock if discovery is not already running. The server fires
  // autoRefine on a setImmediate, so its `refine:start` beat can reach this tab
  // BEFORE this fetch resolves — and an unconditional clear here would unlock the
  // 3D view in the middle of stage 1, while the render farm is driving the camera.
  finally { state.busy = false; if (!state.refining) state.discovering = false; state.phase = null; }
}

async function browseMesh() {
  const p = await pick('open', { title: 'Select a .glb mesh', filterName: 'Mesh', patterns: ['glb', 'gltf'] });
  if (p) { glbPath.value = p; await loadMesh(); }
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
        <input v-model="glbPath" type="text" placeholder="path to .glb mesh" :disabled="state.busy || state.discovering" @keyup.enter="loadMesh" />
        <button @click="browseMesh" :disabled="state.busy || state.discovering" title="Open a file dialog to pick a .glb">Browse…</button>
        <button class="primary" @click="loadMesh" :disabled="state.busy || state.discovering">Load</button>
      </div>
      <p v-if="glbFull" class="pathline"><span class="tick">✓</span><span class="path">{{ glbFull }}</span></p>
    </section>

    <hr class="rule" />

    <!-- STEP 2 — discovered joints; the 3D view is the primary process surface -->
    <section class="step">
      <header class="step-head"><span class="num">2</span><span class="title">Find the joints</span></header>
      <p class="hint">
        Follow the AI assistant in the chatbot to verify each joint's scope: it must
        contain every part that belongs to it, and nothing that doesn't. Joints
        appear as dimmed candidates first and become clickable one by one as each
        one's checks pass.
      </p>
      <p v-if="expectReadout" class="expect" :class="expectReadout.ok ? 'good' : 'warn'"
         :title="'A category guess, checked against what was actually grounded. The guess aims the camera and checks a count; it can never itself become a joint.'">
        <span class="tick">{{ expectReadout.ok ? '✓' : '⚠' }}</span>
        <span class="exbody">read as <b>{{ expectReadout.category }}</b> — {{ expectReadout.text }}<template v-if="expectReadout.extra"> · {{ expectReadout.extra }}</template></span>
      </p>
      <JointList />
    </section>

    <hr class="rule" />

    <!-- STEP 3 — verify motion with the knobs (preview pivot; needs no controller) -->
    <section class="step">
      <header class="step-head"><span class="num">3</span><span class="title">Control the joints</span></header>
      <p class="hint">Follow the AI assistant in the chatbot to drive each joint's motion: confirm it moves as expected and that nothing is broken.</p>
      <KnobPanel />
    </section>

    <hr class="rule" />

    <!-- STEP 4 — generate the controller (last: its input is the judged joint map) -->
    <section class="step">
      <header class="step-head"><span class="num">4</span><span class="title">Generate the controller script</span></header>
      <p class="hint">Pick the target language and where to write the file, then generate. Generation re-runs the deterministic validator every round.</p>
      <div class="row">
        <select v-model="lang" :disabled="state.busy || state.discovering || !state.loaded">
          <option value="javascript">javascript</option>
          <option value="python" disabled>python (M2)</option>
          <option value="csharp" disabled>csharp (M2)</option>
        </select>
        <input v-model="outPath" type="text" placeholder="destination path (optional)" :disabled="state.busy || state.discovering || !state.loaded" />
        <button @click="browseOut" :disabled="state.busy || state.discovering || !state.loaded" title="Choose a destination folder + file name (creates them)">Browse…</button>
      </div>
      <p v-if="outFull" class="pathline"><span class="tick">↳</span><span class="path">{{ outFull }}</span></p>
      <p v-if="pending" class="gatewarn">{{ pending }} joint(s) still unjudged — generating now bakes unverified claims into the controller.</p>
      <div class="row genrow">
        <button class="gen" @click="generate" :disabled="state.busy || state.discovering || !state.loaded">Generate</button>
      </div>
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
.hint code { color: var(--value); background: var(--surface-3); padding: 0 4px; border-radius: 4px; font-size: 11px; }

/* Generation is the last step on purpose; this warns rather than blocks, because
   an operator who has read the evidence may still choose to generate early. */
.gatewarn {
  color: #b58900; border-left: 2px solid #b58900; padding: 4px 8px; margin: 2px 0 0;
  background: var(--surface-3); font-size: 11px; line-height: 1.4;
}

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

/* the category prior vs. what was grounded — a guess on trial, so it is coloured
   by whether the guess survived, not by whether it was confident */
.expect { display: flex; gap: 6px; align-items: baseline; margin: 4px 0 0; font-size: 11px; line-height: 1.45; }
.expect .tick { color: inherit; }
.expect .exbody { color: var(--muted); }
.expect .exbody b { color: var(--text); font-weight: 600; }
.expect.good { color: var(--good); }
.expect.warn { color: var(--warn); }

/* static (non-draggable) horizontal divider between steps */
.rule { height: 0; border: none; border-top: 1px solid var(--border); margin: 2px 0; }
</style>

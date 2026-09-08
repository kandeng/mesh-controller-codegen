<script setup>
// VerdictBar — the human gate, inline in step 3 (where the joint is being driven),
// not in a pop-up: the judgement controls sit next to the knobs that let you check
// the claim before judging it.
//
// Two things happen here and BOTH are drawn into the 3D view:
//   accept/reject  -> the record's status flips, so its marker turns solid
//                     green/red (a human decision is a measurement, not a claim);
//   "also apply to mirrors" -> the verdict AMORTIZES to symmetry peers, and the
//                     3D view flashes a link from this joint to each peer that
//                     inherited the decision, so an inherited ✓ is never mistaken
//                     for a directly-inspected one.
// "sweep in 3D" plays the joint's fan of motion in place — the same pivot the
// knobs drive, run through its range once, so "which parts spin" is answered by
// watching rather than by reading an axis triple.
import { computed, ref, watch } from 'vue';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useKernelApi } from '../composables/useKernelApi.js';

const { state, activeJoint, notify } = useProjectStore();
const api = useKernelApi();

const peers = ref(null);          // { canAmortize, peers:[ids], group:[ids] }
const chosen = ref([]);           // peer ids the verdict should travel to
const working = ref(false);

const STATUS_TEXT = {
  'needs-verdict': 'waiting on a human verdict',
  confirmed: 'confirmed',
  'auto-accepted': 'auto-accepted by the physics battery',
  rejected: 'rejected',
  candidate: 'candidate',
};
const statusText = computed(() => {
  const j = activeJoint.value;
  if (!j) return '';
  const base = STATUS_TEXT[j.status] || j.status;
  const v = j.verdict;
  if (v) return `${base} · ${v.decision} by ${v.actor}${v.amortizedFrom ? ` (inherited from ${v.amortizedFrom})` : ''}`;
  return base;
});
const statusClass = computed(() => {
  const s = activeJoint.value?.status;
  if (s === 'confirmed' || s === 'auto-accepted') return 'ok';
  if (s === 'rejected') return 'bad';
  if (s === 'needs-verdict') return 'warn';
  return '';
});

// Peer labels come from the served list; an id with no label is shown raw rather
// than dropped, because a checkbox that silently vanished would hide a mirror.
const peerRows = computed(() => (peers.value?.peers || []).map((id) => ({
  id,
  label: state.joints.find((j) => j.id === id)?.label || id,
})));

async function loadPeers(id) {
  peers.value = null; chosen.value = [];
  if (!id) return;
  try {
    const r = await api.jointPeers(id);
    if (r?.ok) peers.value = r;
  } catch { /* the bar simply offers no mirrors */ }
}
watch(() => state.activeJointId, loadPeers, { immediate: true });

async function decide(decision) {
  const j = activeJoint.value;
  if (!j || working.value) return;
  working.value = true;
  try {
    const { status, body } = await api.setVerdict(j.id, {
      decision,
      amortizeTo: chosen.value.length ? chosen.value : null,
      actor: 'human',
    });
    if (!body?.ok) {
      notify(`verdict refused: ${body?.error || `HTTP ${status}`}`);
      return;
    }
    const applied = body.amortized?.applied || [];
    const skipped = [...(body.amortized?.refused || []), ...(body.amortized?.skipped || [])];
    // The 3D view draws the inheritance links from this flash.
    state.verdictFlash = { id: j.id, decision, peers: applied, ts: Date.now() };
    let line = decision === 'accept' ? `you accepted "${j.label}"` : `you rejected "${j.label}"`;
    if (applied.length) line += ` — the verdict also applied to ${applied.length} mirror(s)`;
    if (skipped.length) line += ` — ${skipped.length} mirror(s) skipped (already judged directly)`;
    notify(line);
    const fresh = await api.joints();
    if (fresh?.ok) state.joints = fresh.joints;
    await loadPeers(j.id);
  } catch (e) {
    notify(`verdict failed: ${e.message}`);
  } finally {
    working.value = false;
  }
}

function sweep() {
  const j = activeJoint.value;
  if (!j) return;
  state.sweepReq = { id: j.id, ts: Date.now() };
}
</script>

<template>
  <div v-if="activeJoint" class="vbar">
    <div class="row1">
      <span class="st" :class="statusClass">{{ statusText }}</span>
      <button
        class="sweep" title="Play this joint's fan of motion in the 3D view"
        :disabled="state.busy || state.discovering" @click="sweep"
      >sweep in 3D</button>
    </div>

    <div v-if="activeJoint.status === 'needs-verdict'" class="gate">
      <label v-if="peerRows.length" class="mirrors">
        <span class="mlabel">also apply to mirror(s):</span>
        <span v-for="p in peerRows" :key="p.id" class="peer">
          <input type="checkbox" :value="p.id" v-model="chosen" />{{ p.label }}
        </span>
      </label>
      <div class="btns">
        <button class="accept" :disabled="working || state.busy || state.discovering" @click="decide('accept')">accept</button>
        <button class="reject" :disabled="working || state.busy || state.discovering" @click="decide('reject')">reject</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vbar { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.row1 { display: flex; align-items: center; gap: 8px; }
.st { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); flex: 1; }
.st.ok { color: var(--good); }
.st.bad { color: var(--bad); }
.st.warn { color: #b58900; }
button {
  background: var(--panel-2); border: 1px solid var(--border-accent); border-radius: 7px; color: var(--text-btn);
  padding: 5px 10px; cursor: pointer; font-size: 12px; white-space: nowrap;
}
button:hover:not(:disabled) { background: var(--btn-hover); }
button:disabled { opacity: .45; cursor: default; }
button.sweep { border-color: var(--border-2); color: var(--muted); }
button.accept { border-color: var(--good); color: var(--good); }
button.reject { border-color: var(--bad); color: var(--bad); }
.gate { display: flex; flex-direction: column; gap: 6px; }
.mirrors { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.mlabel { color: var(--faint); font-size: 11px; }
.peer { display: inline-flex; gap: 4px; align-items: center; color: var(--text-dim); font-size: 11px; }
.btns { display: flex; gap: 6px; }
</style>

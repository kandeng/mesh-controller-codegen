<script setup>
// JointList — the discovered maximal-scope joint units. Selecting one sets it
// active and pulls its slot graph (which knobs/overlays to render).
import { computed, onMounted, ref } from 'vue';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useSlotRouting } from '../composables/useSlotRouting.js';
import { useKernelApi } from '../composables/useKernelApi.js';

const { state } = useProjectStore();
const { selectJoint } = useSlotRouting();
const api = useKernelApi();

const TYPE_ICON = { rotor: '✈', gimbal: '🎥', hinge: '🔩' };

// Hypothesis verdict chip: green ✓ when the deterministic battery auto-accepted
// the joint or a HUMAN confirmed it, amber ! when a human verdict is needed, red
// ✗ when a human rejected it. A confirmed joint whose verdict was inherited from
// a symmetry peer is drawn in blue instead of green, because "a person looked at
// this joint" and "a person looked at its mirror" are different claims and only
// one of them is direct evidence.
const chipOf = (j) => {
  const d = j.verdict?.decision;
  if (j.status === 'rejected') return { g: '✗', c: 'bad' };
  if (j.status === 'confirmed') return j.verdict?.amortizedFrom ? { g: '✓', c: 'peer' } : { g: '✓', c: 'ok' };
  if (j.status === 'auto-accepted') return { g: '✓', c: 'ok' };
  if (d === 'edit') return { g: '✎', c: 'edit' };
  return { g: '!', c: 'warn' };
};

const chipTip = (j) => {
  const ev = (j.evidence || []).join(', ') || 'no evidence';
  const ts = (j.tests || []).map((t) => `${t.pass ? '✓' : '✗'} ${t.name}${t.detail ? ` — ${t.detail}` : ''}`).join('\n');
  // Phase 3: what the model SAID and where it told us it was UNSURE. A
  // confidence number cannot be argued with; "blade count unclear" can — which
  // is the entire point of putting it on the chip a human is about to judge.
  // Only vision-sourced records carry these, so they are appended conditionally.
  const from = j.origin ? `\norigin: ${j.origin}` : '';
  const said = j.reasoning ? `\nmodel: ${j.reasoning}` : '';
  const unsure = (j.uncertainties || []).length ? `\nunsure: ${j.uncertainties.join('; ')}` : '';
  // Phase 3 task 17: who decided, and whether they decided about THIS joint. An
  // inherited verdict that did not say so would be indistinguishable from a
  // direct one, and the whole point of the human gate is that the difference
  // matters.
  const v = j.verdict;
  const judged = v ? `\nverdict: ${v.decision} by ${v.actor}${v.amortizedFrom ? ` (inherited from ${v.amortizedFrom})` : ''}${v.note ? ` — ${v.note}` : ''}` : '';
  return `evidence: ${ev}\nconfidence: ${j.confidence ?? '—'}${from}${said}${unsure}${judged}${ts ? `\n${ts}` : ''}`;
};

// Phase-2: ask the AI for one batch of proposals over the needs-verdict
// frontier. The deterministic battery re-tests every proposal; verdicts stay
// human (phase 3). Without a live agent the backend refuses gracefully.
const refining = ref(false);
const refineMsg = ref('');
const needsVerdict = computed(() => state.joints.some((j) => j.status === 'needs-verdict'));
async function refine() {
  if (refining.value) return;
  refining.value = true;
  refineMsg.value = '';
  try {
    const r = await api.refine();
    if (!r.ok) { refineMsg.value = r.error || 'refine failed'; return; }
    if (r.added) {
      const j = await api.joints();
      if (j.ok) state.joints = j.joints;
    }
    refineMsg.value = r.added ? `+${r.added} proposal(s)` : (r.reason || 'no new proposals');
  } catch (e) {
    refineMsg.value = e.message;
  } finally {
    refining.value = false;
  }
}

// Phase 3: ask a multimodal model to LOOK at the mesh. One bounded round — the
// server plans poses, a browser tab draws them, the model reads the frames, and
// the same deterministic battery disposes whatever it proposes. Verdicts stay
// human (Task 17).
//
// Unlike AI refine this is NOT gated on needs-verdict: the question it answers is
// "what did we miss entirely", which is most valuable when discovery is already
// confident it has found everything.
const visionBusy = ref(false);
const visionMsg = ref('');
const farmReady = ref(false);
// Whether the last message is a REFUSAL. Kept separate from `farmReady` on
// purpose: keying the amber styling off the farm would paint a successful round's
// result as a warning on any machine that has since closed its viewer tab.
const visionBad = ref(false);

// Cheap liveness probe. The button is offered either way, but its tooltip says
// up front whether a viewer tab is attached — a round that refuses after the
// user waits for a plan is a worse experience than one that warns on hover.
async function refreshFarm() {
  try {
    const f = await api.observeFarm();
    farmReady.value = f?.available === true;
  } catch {
    farmReady.value = false;
  }
}
onMounted(refreshFarm);

const visionTitle = computed(() => (farmReady.value
  ? 'Look at the mesh: plan camera poses, render them in this tab, and let a vision model propose joints'
  : 'Needs a viewer tab with the mesh loaded (and a live multimodal model) — the round will explain what is missing'));

async function visionRefine() {
  if (visionBusy.value) return;
  visionBusy.value = true;
  visionMsg.value = '';
  visionBad.value = false;
  try {
    const { status, body } = await api.visionRefine();
    if (!body?.ok) {
      // `unmet` names EVERY missing precondition at once, so the user fixes the
      // whole list in one pass rather than discovering the next blocker on the
      // next press. That is the only reason the endpoint returns a list.
      const why = (body?.unmet || []).map((u) => u.error).filter(Boolean);
      visionMsg.value = why.length ? why.join(' · ') : (body?.error || `refused (${status})`);
      visionBad.value = true;
      return;
    }
    if (body.added) {
      const j = await api.joints();
      if (j.ok) state.joints = j.joints;
    }
    visionMsg.value = body.added
      ? `+${body.added} from ${body.frames} frame(s), round ${body.round}`
      : (body.reason || `${body.frames ?? 0} frame(s) read, nothing proposed`);
  } catch (e) {
    visionMsg.value = e.message;
    visionBad.value = true;
  } finally {
    visionBusy.value = false;
    await refreshFarm();
  }
}
</script>

<template>
  <div class="joints">
    <div class="title">
      Joints <span class="count">{{ state.joints.length }}</span>
      <button v-if="needsVerdict" class="refine" :disabled="refining" title="Ask the AI for one batch of joint proposals over the uncertain units" @click="refine">
        {{ refining ? '…' : '✦ AI refine' }}
      </button>
      <button v-if="state.joints.length" class="refine vision" :disabled="visionBusy" :title="visionTitle" @click="visionRefine">
        {{ visionBusy ? '…' : '◉ Vision refine' }}
      </button>
      <span v-if="refineMsg" class="refinemsg">{{ refineMsg }}</span>
      <span v-if="visionMsg" class="refinemsg" :class="{ bad: visionBad }">{{ visionMsg }}</span>
    </div>
    <ul>
      <li
        v-for="j in state.joints"
        :key="j.id"
        :class="{ active: j.id === state.activeJointId }"
        @click="selectJoint(j.id)"
      >
        <span class="icon">{{ TYPE_ICON[j.type] || '•' }}</span>
        <span class="label">{{ j.label }}</span>
        <span class="meta">{{ j.type }} · {{ j.nodeCount }}</span>
        <span class="chip" :class="chipOf(j).c" :title="chipTip(j)">{{ chipOf(j).g }}</span>
      </li>
    </ul>
    <div v-if="!state.joints.length" class="empty">No joints discovered yet.</div>
  </div>
</template>

<style scoped>
.joints { font-size: 13px; }
.title { color: var(--good); font-family: ui-monospace, monospace; margin-bottom: 6px; }
.count { color: var(--faint); }
ul { list-style: none; margin: 0; padding: 0; }
li {
  display: flex; align-items: center; gap: 7px; padding: 7px 8px; margin: 3px 0;
  border: 1px solid var(--border-2); border-radius: 7px; cursor: pointer; color: var(--text-dim);
}
li:hover { border-color: var(--border-accent); background: var(--surface-3); }
li.active { border-color: var(--accent-2); background: var(--item-active); }
.icon { width: 16px; text-align: center; }
.label { flex: 1; }
.meta { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
.chip { font-size: 10px; font-weight: 700; border-radius: 8px; padding: 0 5px; line-height: 15px; border: 1px solid; }
.chip.ok { color: var(--good); border-color: var(--good); }
.chip.warn { color: #b58900; border-color: #b58900; }
.chip.bad { color: var(--bad); border-color: var(--bad); }
/* A confirmed joint whose verdict travelled from a symmetry peer. Blue rather
   than green so the list can be scanned for the claims a person has NOT looked
   at directly — which is the honest reading of "confirmed" here. */
.chip.peer { color: #7aa5c9; border-color: #3d5a73; }
.chip.edit { color: #b58900; border-color: #b58900; border-style: dashed; }
.refine {
  margin-left: 8px; font-size: 10px; font-family: inherit; cursor: pointer;
  color: var(--accent-2, #6aa); background: none; border: 1px solid var(--border-accent, #456);
  border-radius: 8px; padding: 1px 7px;
}
.refine:disabled { opacity: 0.5; cursor: default; }
/* The vision button is a different KIND of ask — it spends a render round trip
   and a model turn, not just a prompt — so it reads differently at a glance. */
.refine.vision { color: #7aa5c9; border-color: #3d5a73; }
.refinemsg { margin-left: 6px; font-size: 10px; color: var(--faint); }
.refinemsg.bad { color: #b58900; }
.empty { color: var(--faint); font-style: italic; padding: 6px 2px; }
</style>

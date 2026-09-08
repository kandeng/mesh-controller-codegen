<script setup>
// JointList — the discovered maximal-scope joint units, as an EVOLVING list the AI
// controls while it works and the human takes over once it settles.
//
// While a discovery op is in flight the list is LOCKED (not selectable): selecting
// a half-formed joint would drive the preview pivot off a membership the AI is
// still revising, which reads as the mesh misbehaving rather than the AI thinking.
// Selecting a settled joint sets it active and pulls its slot graph (which
// knobs/overlays to render).
import { computed } from 'vue';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useSlotRouting } from '../composables/useSlotRouting.js';

const { state } = useProjectStore();
const { selectJoint } = useSlotRouting();

const TYPE_ICON = { rotor: '✈', gimbal: '🎥', hinge: '🔩' };

// The list is selectable only once the AI has settled. `discovering` is set by
// whichever op is running (load / refine / vision) and cleared in its finally.
const locked = computed(() => state.discovering);

// How each joint is driven — the "control the dynamic component" readout.
const fmt = (v) => {
  const n = Number(v) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
};
const axisGloss = (j) => {
  if (j.type === 'gimbal') return 'pitch+yaw';
  const a = j.axis;
  if (!a) return 'axis —';
  return `axis ${fmt(a.x)},${fmt(a.y)},${fmt(a.z)}`;
};

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
}
</script>

<template>
  <div class="joints">
    <ul :class="{ locked }">
      <li
        v-for="j in state.joints"
        :key="j.id"
        :class="{ active: j.id === state.activeJointId }"
        @click="!locked && selectJoint(j.id)"
      >
        <span class="icon">{{ TYPE_ICON[j.type] || '•' }}</span>
        <span class="label">{{ j.label }}</span>
        <span class="meta">{{ j.type }} · {{ j.nodeCount }} · {{ axisGloss(j) }}</span>
        <span class="chip" :class="chipOf(j).c" :title="chipTip(j)">{{ chipOf(j).g }}</span>
      </li>
    </ul>
    <div v-if="!state.joints.length" class="empty">{{ locked ? 'The AI is decomposing the mesh…' : 'No joints discovered yet.' }}</div>
  </div>
</template>

<style scoped>
.joints { font-size: 13px; }
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

/* while the AI works the list is inert: no hover affordance, no pointer */
ul.locked { pointer-events: none; opacity: .6; }

.empty { color: var(--faint); font-style: italic; padding: 6px 2px; }
</style>

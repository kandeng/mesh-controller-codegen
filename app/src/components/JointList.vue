<script setup>
// JointList — the discovered maximal-scope joint units, as an EVOLVING list the AI
// controls while it works and the human takes over once it settles.
//
// Discovery is staged: stage 1 admits rough CANDIDATES (status 'candidate'), stage 2
// refines them one at a time. So the lock is per-row, not per-list — a candidate is
// inert because its membership is still a guess and selecting it would drive the
// preview pivot off a scope the checks may still revise; a refined row is live even
// while the rest of the list is still being worked on. That is the point of staging:
// the human can start judging joint 1 while the AI is still checking joint 5.
// Selecting a settled joint sets it active and pulls its slot graph (which knobs/
// overlays to render).
import { computed, watch } from 'vue';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useSlotRouting } from '../composables/useSlotRouting.js';

const { state, sayJointGuidance } = useProjectStore();
const { selectJoint } = useSlotRouting();

// A row is inert until its own checks have passed. `status` travels on the wire in
// jointSummary (routes/project.mjs), so this needs no extra state: candidates are
// minted with status 'candidate' and only leave it when deriveStatus runs over them.
const pending = (j) => j.status === 'candidate';

// Stage-2 progress, for the footer line and the candidate tooltips.
const pendingCount = computed(() => state.joints.filter(pending).length);

// The first row to settle becomes the active joint — but only when nothing is
// active. At load everything is a candidate, so the viewer has nothing trustworthy
// to highlight; the moment stage 2 checks one, there is. Guarded on "nothing active"
// so it never yanks the view away from a joint the human already chose.
const firstReady = computed(() => state.joints.find((j) => !pending(j))?.id || null);
watch(firstReady, (id) => { if (id && !state.activeJointId) selectJoint(id); }, { immediate: true });

// Picking a joint asks the assistant for the inspection guidance and then selects
// it. The guidance is said ONCE (the store collapses an unchanged repeat), so
// walking down the list does not stack the same paragraph into the chat.
function pick(j) {
  sayJointGuidance();
  selectJoint(j.id);
}

// The row carries the joint's full provenance as a tooltip (evidence, confidence,
// what the model said, who judged it, the battery results). The LIST itself stays
// deliberately bare — name and type only — because every glyph we ever put on a
// row (type icon, part count, axis triple, verdict mark) either needed an icon we
// could not always source or restated something the 3D view answers better by
// showing it. Nothing is lost: it all lives one hover away.
const chipTip = (j) => {
  const ev = (j.evidence || []).join(', ') || 'no evidence';
  const ts = (j.tests || []).map((t) => `${t.pass ? '✓' : '✗'} ${t.name}${t.detail ? ` — ${t.detail}` : ''}`).join('\n');
  // Phase 3: what the model SAID and where it told us it was UNSURE. A
  // confidence number cannot be argued with; "blade count unclear" can — which
  // is the entire point of putting it on the row a human is about to judge.
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

// A candidate has no provenance yet — that is exactly what stage 2 produces — so its
// tooltip says how far along the queue it is instead of showing empty fields.
const rowTip = (j) => {
  if (!pending(j)) return chipTip(j);
  const ready = state.joints.length - pendingCount.value;
  const place = state.joints.filter(pending).findIndex((x) => x.id === j.id) + 1;
  return `candidate — not checked yet\nstage 2 will run its isolation checks and vision grounding\nqueue: ${place} of ${pendingCount.value} remaining (${ready} of ${state.joints.length} ready)`;
};
</script>

<template>
  <div class="joints">
    <ul>
      <li
        v-for="j in state.joints"
        :key="j.id"
        :class="{ active: j.id === state.activeJointId, pending: pending(j) }"
        :title="rowTip(j)"
        @click="!pending(j) && pick(j)"
      >
        <span class="label">{{ j.label }}</span>
        <span class="meta">{{ j.type }}</span>
      </li>
    </ul>
    <div v-if="!state.joints.length" class="empty">{{ state.discovering ? 'The AI is decomposing the mesh…' : 'No joints discovered yet.' }}</div>
    <div v-else-if="pendingCount" class="empty">{{ pendingCount }} candidate{{ pendingCount === 1 ? '' : 's' }} still being checked — those rows are not clickable yet.</div>
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
.label { flex: 1; }
.meta { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }

/* A candidate row is inert until its own checks pass: dimmed, no pointer, no hover.
   Per-row rather than per-list so refined joints stay usable while the rest of the
   list is still being worked on. */
li.pending { opacity: .55; cursor: default; }
li.pending:hover { border-color: var(--border-2); background: none; }

.empty { color: var(--faint); font-style: italic; padding: 6px 2px; }
</style>

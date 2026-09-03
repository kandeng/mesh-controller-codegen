<script setup>
// JointList — the discovered maximal-scope joint units. Selecting one sets it
// active and pulls its slot graph (which knobs/overlays to render).
import { useProjectStore } from '../composables/useProjectStore.js';
import { useSlotRouting } from '../composables/useSlotRouting.js';

const { state } = useProjectStore();
const { selectJoint } = useSlotRouting();

const TYPE_ICON = { rotor: '✈', gimbal: '🎥', hinge: '🔩' };
</script>

<template>
  <div class="joints">
    <div class="title">Joints <span class="count">{{ state.joints.length }}</span></div>
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
.empty { color: var(--faint); font-style: italic; padding: 6px 2px; }
</style>

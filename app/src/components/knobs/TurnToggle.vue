<script setup>
// Two-position spin-DIRECTION toggle bound to the 'turn' command axis.
// -1 = Counter ClockWise, +1 = ClockWise (no neutral / straight state).
// The viewer preview reads store.knobValues.turn to pick the spin direction
// of the single active joint.
import { computed } from 'vue';
import { useProjectStore } from '../../composables/useProjectStore.js';

const props = defineProps({ knob: { type: Object, required: true } });
const { state, setKnob } = useProjectStore();

const axis = computed(() => props.knob.axis || 'turn');
const current = computed(() => Number(state.knobValues[axis.value] ?? 1));
</script>

<template>
  <div class="knob">
    <label><span>{{ knob.label || 'Turn' }}</span></label>
    <div class="seg">
      <button :class="{ active: current < 0 }" @click="setKnob(axis, -1)">&#8634; Counter ClockWise</button>
      <button :class="{ active: current > 0 }" @click="setKnob(axis, 1)">ClockWise &#8635;</button>
    </div>
  </div>
</template>

<style scoped>
.knob { margin: 10px 0; font-size: 13px; }
.knob label { display: block; margin-bottom: 4px; color: var(--text-dim); }
.seg { display: flex; gap: 6px; }
.seg button {
  flex: 1; padding: 7px 0; border: 1px solid var(--border-accent); border-radius: 6px;
  background: var(--panel-2); color: var(--text-btn); cursor: pointer; font-size: 12px;
}
.seg button.active { background: var(--accent); border-color: var(--accent-2); color: #fff; }
</style>

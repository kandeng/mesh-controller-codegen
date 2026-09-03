<script setup>
// Three-position turn control bound to the 'turn' command axis (-1 / 0 / +1).
// Maps onto the controller's turnLeft / goStraight / turnRight methods via the
// viewer bridge (which reads store.knobValues.turn).
import { computed } from 'vue';
import { useProjectStore } from '../../composables/useProjectStore.js';

const props = defineProps({ knob: { type: Object, required: true } });
const { state, setKnob } = useProjectStore();

const axis = computed(() => props.knob.axis || 'turn');
const current = computed(() => Number(state.knobValues[axis.value] ?? 0));
const pick = (v) => setKnob(axis.value, v);
</script>

<template>
  <div class="knob">
    <label><span>{{ knob.label || 'Turn' }}</span></label>
    <div class="seg">
      <button :class="{ active: current < 0 }" @click="pick(-1)">&#10226; Left</button>
      <button :class="{ active: current === 0 }" @click="pick(0)">Straight</button>
      <button :class="{ active: current > 0 }" @click="pick(1)">Right &#10227;</button>
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

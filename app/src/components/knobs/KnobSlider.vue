<script setup>
// Generic data-driven slider. One component serves every *-slider render id
// (speed/pitch/yaw/angle/value); the slot descriptor supplies label/min/max/step/
// unit/default, so adding a new command axis needs no new component.
import { computed } from 'vue';
import { useProjectStore } from '../../composables/useProjectStore.js';

const props = defineProps({ knob: { type: Object, required: true } });
const { state, setKnob } = useProjectStore();

const axis = computed(() => props.knob.axis);
const value = computed({
  get: () => Number(state.knobValues[axis.value] ?? props.knob.default ?? 0),
  set: (v) => setKnob(axis.value, Number(v)),
});
const label = computed(() => props.knob.label || `${axis.value}`);
const unit = computed(() => props.knob.unit || '');
const decimals = computed(() => (String(props.knob.step ?? 1).split('.')[1] || '').length);
</script>

<template>
  <div class="knob">
    <label>
      <span>{{ label }}</span>
      <span class="val">{{ value.toFixed(decimals) }}{{ unit ? ' ' + unit : '' }}</span>
    </label>
    <input type="range" :min="knob.min" :max="knob.max" :step="knob.step" v-model="value" />
  </div>
</template>

<style scoped>
.knob { margin: 10px 0; font-size: 13px; }
.knob label { display: flex; justify-content: space-between; margin-bottom: 4px; color: var(--text-dim); }
.knob .val { font-family: ui-monospace, monospace; color: var(--value); }
.knob input[type=range] { width: 100%; accent-color: var(--accent); }
</style>

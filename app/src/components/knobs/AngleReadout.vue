<script setup>
// Angle readout — derived (bind:'readout'). Shows the live gimbal pitch/yaw the
// viewer bridge publishes from controller.getState().gimbal.
import { computed } from 'vue';
import { useProjectStore } from '../../composables/useProjectStore.js';

const { state } = useProjectStore();
const pitch = computed(() => Number(state.gimbal?.pitch ?? 0).toFixed(1));
const yaw = computed(() => Number(state.gimbal?.yaw ?? 0).toFixed(1));
</script>

<template>
  <div class="readout">
    <div class="head">Gimbal angle</div>
    <div class="grid">
      <div><span class="k">pitch</span><span class="v">{{ pitch }}&deg;</span></div>
      <div><span class="k">yaw</span><span class="v">{{ yaw }}&deg;</span></div>
    </div>
  </div>
</template>

<style scoped>
.readout { margin: 10px 0; font-size: 12px; }
.head { color: var(--good); font-family: ui-monospace, monospace; margin-bottom: 4px; }
.grid { display: flex; gap: 14px; }
.k { color: var(--text-dim); margin-right: 6px; }
.v { color: var(--value); font-family: ui-monospace, monospace; }
</style>

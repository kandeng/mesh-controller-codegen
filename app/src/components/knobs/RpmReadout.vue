<script setup>
// RPM readout — a derived (bind:'readout') knob. Reads the live per-propeller rpm
// the viewer bridge publishes from controller.getState().
import { computed } from 'vue';
import { useProjectStore } from '../../composables/useProjectStore.js';

const { state } = useProjectStore();
const props = computed(() => state.props || []);
const max = computed(() => Math.max(1, ...props.value.map((p) => Math.round(p.rpm || 0))));
</script>

<template>
  <div class="readout">
    <div class="head">RPM</div>
    <div v-if="!props.length" class="empty">no telemetry yet</div>
    <div v-for="p in props" :key="p.name" class="row">
      <span class="name">{{ p.name }}</span>
      <span class="bar"><i :style="{ width: (Math.round(p.rpm || 0) / max * 100) + '%' }"></i></span>
      <span class="num">{{ Math.round(p.rpm || 0) }}</span>
    </div>
  </div>
</template>

<style scoped>
.readout { margin: 10px 0; font-size: 12px; }
.head { color: var(--good); font-family: ui-monospace, monospace; margin-bottom: 4px; }
.empty { color: var(--faint); font-style: italic; }
.row { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
.name { width: 34px; color: var(--text-dim); font-family: ui-monospace, monospace; }
.bar { flex: 1; height: 8px; background: var(--surface-3); border-radius: 4px; overflow: hidden; }
.bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
.num { width: 46px; text-align: right; color: var(--value); font-family: ui-monospace, monospace; }
</style>

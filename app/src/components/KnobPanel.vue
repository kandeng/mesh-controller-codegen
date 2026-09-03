<script setup>
// KnobPanel — renders the active joint's knobs straight from the Slot Routing
// Graph. Each entry's render id is already bound to a component by useSlotRouting,
// so this is a pure <component :is> loop: fully data-driven, no hardcoded sliders.
import { computed } from 'vue';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useSlotRouting } from '../composables/useSlotRouting.js';

const { state, activeJoint } = useProjectStore();
const { knobEntries } = useSlotRouting();

const hasKnobs = computed(() => knobEntries.value.length > 0);
</script>

<template>
  <div class="panel">
    <div class="title">
      Controls
      <span v-if="activeJoint" class="joint">{{ activeJoint.label }}</span>
    </div>

    <div v-if="!activeJoint" class="empty">Select a joint to see its controls.</div>

    <template v-else>
      <component
        v-for="(k, i) in knobEntries"
        :key="`${k.render}-${k.axis || k.source || i}`"
        :is="k.component"
        :knob="k"
      />
      <div v-if="!hasKnobs" class="empty">This joint exposes no controls yet.</div>
    </template>

    <div v-if="state.validation" class="verdict" :class="state.validation.pass ? 'pass' : 'fail'">
      validation: {{ state.validation.pass ? 'PASS' : 'FAIL' }}
      <span v-if="state.validation.failures?.length"> — {{ state.validation.failures[0] }}</span>
    </div>
  </div>
</template>

<style scoped>
.panel { font-size: 13px; }
.title { color: var(--good); font-family: ui-monospace, monospace; margin-bottom: 8px; display: flex; gap: 8px; align-items: baseline; }
.joint { color: var(--value); font-size: 12px; }
.empty { color: var(--faint); font-style: italic; padding: 6px 2px; }
.verdict { margin-top: 12px; font-family: ui-monospace, monospace; font-size: 12px; padding: 6px 8px; border-radius: 6px; }
.verdict.pass { color: var(--good); background: var(--pass-bg); border: 1px solid var(--pass-border); }
.verdict.fail { color: var(--bad); background: var(--fail-bg); border: 1px solid var(--fail-border); }
</style>

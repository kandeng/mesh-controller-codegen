// Slot Routing (frontend half) — fetches the backend-resolved slot graph for the
// active joint and binds each entry's render id to a Vue component. KnobPanel
// renders straight off this, so the UI is fully driven by the plugin declarations.
import { computed } from 'vue';
import { useProjectStore } from './useProjectStore.js';
import { useKernelApi } from './useKernelApi.js';
import { componentForRender } from '../components/knobs/index.js';

export function useSlotRouting() {
  const { state, setActiveJoint } = useProjectStore();
  const api = useKernelApi();

  // Pull the slot graph whenever the active joint changes.
  async function loadSlots(jointId) {
    if (!jointId) { state.slotGraph = null; return; }
    const r = await api.slots(jointId);
    state.slotGraph = r.ok ? r.graph : null;
  }

  async function selectJoint(jointId) {
    setActiveJoint(jointId);
    await loadSlots(jointId);
  }

  // Resolved knob entries with their component attached (skip viewer overlays).
  const knobEntries = computed(() => {
    const g = state.slotGraph;
    if (!g) return [];
    return (g.knobs || [])
      .map((k) => ({ ...k, component: componentForRender(k.render) }))
      .filter((k) => k.component);
  });

  const overlays = computed(() => state.slotGraph?.overlays || []);

  return { selectJoint, loadSlots, knobEntries, overlays };
}

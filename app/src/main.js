// App bootstrap — mount Vue, connect the kernel event stream, and hydrate any
// in-progress project from the backend so a page reload resumes where you were.
// The agent transcript is restored separately by ChatPanel (session store).
import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { useProjectStore } from './composables/useProjectStore.js';
import { useKernelApi } from './composables/useKernelApi.js';
import { useTheme } from './composables/useTheme.js';

// Apply the persisted theme (localStorage) before mount so the first paint is
// already correct — no dark->light flash.
useTheme().load();

createApp(App).mount('#app');

const { state, connectEvents } = useProjectStore();
const api = useKernelApi();

// Live kernel bus events (auto-reconnects if the backend isn't up yet).
connectEvents();

// Resumability: if a mesh was already discovered this server boot, restore the
// joints + viewer so the UI reflects server truth on load.
(async () => {
  try {
    const s = await api.state();
    if (s?.ok && s.loaded) {
      state.loaded = true;
      state.glb = s.glb;
      state.stats = s.stats || null;
      state.joints = s.joints || [];
      state.viewer = s.viewer || { glb: null, ctl: null };
      state.validation = s.validation || null;
    }
  } catch {
    /* backend not reachable yet; the events socket keeps retrying */
  }
})();

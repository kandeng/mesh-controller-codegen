// Theme store — a module-level reactive singleton (matching the other use*.js
// composables). The active mode is applied to <html data-theme="..."> so the CSS
// design-token sets in style.css cascade through every pane (and MeshViewer reads
// the scene tokens for the 3D backdrop). The choice persists in browser
// localStorage, so it resumes across reloads on this device.
import { reactive } from 'vue';

const STORAGE_KEY = 'mcc.theme';
const state = reactive({ mode: 'dark', loaded: false });

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch { return null; }   // localStorage blocked (private mode, etc.)
}

function apply(mode) {
  state.mode = mode === 'light' ? 'light' : 'dark';
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = state.mode;
}

export function useTheme() {
  // Load the persisted theme from localStorage and apply it (default dark).
  // Synchronous, so main.js can call it before mount to avoid a flash.
  function load() {
    apply(readStored() || state.mode || 'dark');
    state.loaded = true;
    return state.mode;
  }

  // Set a specific mode ('dark'|'light') or 'toggle'; applied immediately and
  // persisted to localStorage.
  function set(mode) {
    const next = mode === 'toggle' ? (state.mode === 'dark' ? 'light' : 'dark') : mode;
    apply(next);
    try { localStorage.setItem(STORAGE_KEY, state.mode); } catch { /* ignore */ }
    return state.mode;
  }

  const toggle = () => set('toggle');

  return { state, apply, load, set, toggle };
}

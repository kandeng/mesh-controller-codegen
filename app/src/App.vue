<script setup>
// App shell — a 3-pane layout: MeshViewer | ControlPanel | ChatPanel,
// separated by two DRAGGABLE dividers. The viewer (left) flexes to fill; the mid
// and right panes have resizable widths. Dragging a divider left grows the pane
// to its right; double-click resets it; arrow keys nudge it when focused (a11y).
// Cross-pane state still flows through the reactive store.
import { ref, onMounted, onBeforeUnmount } from 'vue';
import MeshViewer from './components/MeshViewer.vue';
import ControlPanel from './components/ControlPanel.vue';
import ChatPanel from './components/ChatPanel.vue';
import { useTheme } from './composables/useTheme.js';

// Dark/light theme (persisted in browser localStorage); the toggle lives in the topbar.
const { state: themeState, toggle: toggleTheme } = useTheme();

const DEFAULT_MID = 340, DEFAULT_RIGHT = 360;
const MIN_MID = 240, MIN_RIGHT = 260, MIN_VIEWER = 240, DIVIDER_W = 6;

const panes = ref(null);            // .panes container, for width clamping
const midWidth = ref(DEFAULT_MID);
const rightWidth = ref(DEFAULT_RIGHT);
const dragging = ref(null);         // 'mid' | 'right' | null

let startX = 0, startW = 0;

// Keep mid/right within bounds so the flexible viewer never collapses.
function clampWidths() {
  const total = panes.value?.clientWidth || window.innerWidth;
  const maxMid = Math.max(MIN_MID, total - rightWidth.value - MIN_VIEWER - DIVIDER_W * 2);
  const maxRight = Math.max(MIN_RIGHT, total - midWidth.value - MIN_VIEWER - DIVIDER_W * 2);
  midWidth.value = Math.min(Math.max(midWidth.value, MIN_MID), maxMid);
  rightWidth.value = Math.min(Math.max(rightWidth.value, MIN_RIGHT), maxRight);
}

function onPointerDown(which, e) {
  dragging.value = which;
  startX = e.clientX;
  startW = which === 'mid' ? midWidth.value : rightWidth.value;
  e.currentTarget.setPointerCapture?.(e.pointerId);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
  e.preventDefault();
}
function onPointerMove(e) {
  if (!dragging.value) return;
  const next = startW + (startX - e.clientX);   // drag left (+) grows right-hand pane
  if (dragging.value === 'mid') midWidth.value = next; else rightWidth.value = next;
  clampWidths();
}
function onPointerUp() {
  dragging.value = null;
  window.removeEventListener('pointermove', onPointerMove);
}
function adjust(which, amount) {
  if (which === 'mid') midWidth.value += amount; else rightWidth.value += amount;
  clampWidths();
}
function onKey(which, e) {
  const step = e.shiftKey ? 40 : 12;
  if (e.key === 'ArrowLeft') { e.preventDefault(); adjust(which, step); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); adjust(which, -step); }
}
function reset(which) {
  if (which === 'mid') midWidth.value = DEFAULT_MID; else rightWidth.value = DEFAULT_RIGHT;
  clampWidths();
}

onMounted(() => { clampWidths(); window.addEventListener('resize', clampWidths); });
onBeforeUnmount(() => {
  window.removeEventListener('resize', clampWidths);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
});
</script>

<template>
  <div class="app" :class="{ dragging: !!dragging }">
    <header class="topbar">
      <div class="brand"><span class="logo">◈</span> Mesh Controller Codegen</div>
      <div class="tag">DSH-powered · per-joint controller generator</div>
      <button
        class="theme-toggle" @click="toggleTheme"
        :title="`Switch to ${themeState.mode === 'dark' ? 'light' : 'dark'} theme`"
      >{{ themeState.mode === 'dark' ? '☀ Light' : '🌙 Dark' }}</button>
    </header>

    <main class="panes" ref="panes">
      <section class="pane viewer-pane">
        <MeshViewer />
      </section>

      <div
        class="divider" :class="{ active: dragging === 'mid' }"
        role="separator" aria-orientation="vertical" tabindex="0"
        aria-label="Resize controls panel" title="Drag to resize · double-click to reset"
        @pointerdown="onPointerDown('mid', $event)"
        @dblclick="reset('mid')"
        @keydown="onKey('mid', $event)"
      ><span class="grip"></span></div>

      <section class="pane side-pane" :style="{ width: midWidth + 'px' }">
        <div class="side-scroll">
          <ControlPanel />
        </div>
      </section>

      <div
        class="divider" :class="{ active: dragging === 'right' }"
        role="separator" aria-orientation="vertical" tabindex="0"
        aria-label="Resize assistant panel" title="Drag to resize · double-click to reset"
        @pointerdown="onPointerDown('right', $event)"
        @dblclick="reset('right')"
        @keydown="onKey('right', $event)"
      ><span class="grip"></span></div>

      <section class="pane chat-pane" :style="{ width: rightWidth + 'px' }">
        <ChatPanel />
      </section>
    </main>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; width: 100vw; overflow: hidden; }

.topbar {
  flex: none; display: flex; align-items: baseline; gap: 12px;
  padding: 9px 16px; background: var(--panel); border-bottom: 1px solid var(--border);
}
.brand { color: var(--text); font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.logo { color: var(--accent-2); font-size: 16px; }
.tag { color: var(--faint); font-size: 12px; font-family: ui-monospace, monospace; }
.theme-toggle {
  margin-left: auto; align-self: center; cursor: pointer;
  background: var(--panel-2); border: 1px solid var(--border-2); border-radius: 7px;
  color: var(--text-dim); padding: 5px 11px; font-size: 12px; white-space: nowrap;
}
.theme-toggle:hover { border-color: var(--accent-2); color: var(--text); }

.panes { flex: 1; min-height: 0; display: flex; }
.pane { min-width: 0; min-height: 0; overflow: hidden; }

.viewer-pane { flex: 1 1 auto; background: var(--bg); }
.side-pane { flex: 0 0 auto; display: flex; flex-direction: column; background: var(--panel); }
.chat-pane { flex: 0 0 auto; padding: 12px; background: var(--panel); }

.side-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 14px; }

/* Draggable vertical divider between panes (6px hit area, accent on hover). */
.divider {
  flex: 0 0 6px; position: relative; cursor: col-resize; touch-action: none;
  background: var(--border); transition: background .15s ease;
}
.divider:hover, .divider.active { background: var(--accent); }
.divider:focus-visible { outline: none; background: var(--accent-2); }
.divider .grip {
  position: absolute; top: 50%; left: 50%; width: 2px; height: 30px;
  transform: translate(-50%, -50%); border-radius: 2px; background: var(--grip);
  opacity: 0; transition: opacity .15s ease; pointer-events: none;
}
.divider:hover .grip, .divider.active .grip, .divider:focus-visible .grip { opacity: 1; background: var(--grip-active); }

/* While dragging: suppress selection + pane interaction, force resize cursor. */
.app.dragging { user-select: none; cursor: col-resize; }
.app.dragging .pane { pointer-events: none; }

/* Narrow screens: stack panes vertically; dividers become inert separators. */
@media (max-width: 1000px) {
  .panes { flex-direction: column; overflow-y: auto; }
  .pane { overflow: visible; }
  .viewer-pane { flex: 0 0 46vh; border-bottom: 1px solid var(--border); }
  .side-pane { border-bottom: 1px solid var(--border); }
  .side-pane, .chat-pane { width: auto !important; flex: 0 0 auto; }
  .divider { cursor: default; }
  .divider .grip { display: none; }
  .side-scroll { overflow: visible; }
}
</style>

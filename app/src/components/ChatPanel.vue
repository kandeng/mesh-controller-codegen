<script setup>
// ChatPanel — the only surface the user sees: an "AI assistant". The live DSH
// agent is invisible underneath. Screenshots are human-initiated: paste from the
// clipboard (Ctrl+V in the composer) or upload a local image file; thumbnails
// queue above the composer and ride along with the next message. The transcript
// (text, images, tool activity lines) is restored from the session store on load.
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useAgentSocket } from '../composables/useAgentSocket.js';
import { useKernelApi } from '../composables/useKernelApi.js';
import { useViewerCapture } from '../composables/useViewerCapture.js';

const { state } = useProjectStore();
const { connect, send, resume, stop } = useAgentSocket();
const api = useKernelApi();
const { capture: captureViewerFrame } = useViewerCapture();

const draft = ref('');
const scroller = ref(null);
const fileInput = ref(null);
const pending = ref([]);   // [{ id, url, name, mediaType }] uploaded, not yet sent
const uploading = ref(0);
const lightbox = ref(null);   // { url, name } of the image shown full-size
const taRef = ref(null);      // composer textarea
const userH = ref(null);      // manual composer height in px; null = auto-grow

// ---- folding: screenshot stacks + over-long messages -------------------------
// A vision campaign posts one assistant message PER rendered frame, so a round
// lands as a vertical run of near-identical thumbnails. Those runs are grouped
// into a STACK that shows only its first frame until opened; and any message
// longer than LONG_LINES lines is clipped to a readable block. Both are pure
// presentation — the transcript itself is untouched, so nothing is lost.
const LONG_LINES = 10;
const openStacks = ref(new Set());   // stack keys currently expanded
const openLong = ref(new Set());     // message keys currently expanded

// Group the transcript into render rows: a maximal run of consecutive assistant
// messages carrying screenshots becomes one `stack` row; everything else stays a
// plain `msg` row. Keys are the transcript index of the row's first message, so
// they are stable as the transcript grows.
const rows = computed(() => {
  const out = [];
  let stack = null;
  state.transcript.forEach((m, i) => {
    const isShot = m.role === 'assistant' && (m.attachments || []).length > 0;
    if (isShot) {
      if (!stack) { stack = { type: 'stack', key: `s${i}`, items: [] }; out.push(stack); }
      stack.items.push({ m, i });
    } else {
      stack = null;
      out.push({ type: 'msg', m, i, key: `m${i}` });
    }
  });
  return out;
});

const lineCount = (m) => (m.text ? String(m.text).split('\n').length : 0);
const isLong = (m) => lineCount(m) > LONG_LINES;

function toggleIn(set, key) {
  if (set.has(key)) set.delete(key); else set.add(key);
}
function toggleStack(key) { toggleIn(openStacks.value, key); }
function toggleLong(key) { toggleIn(openLong.value, key); }
function maybeToggleLong(m, key) { if (isLong(m)) toggleLong(key); }

const visibleShots = (row) => (openStacks.value.has(row.key) ? row.items : row.items.slice(0, 1));

// Click semantics for a stacked frame: EVERY thumbnail (first, middle, last alike)
// zooms to the lightbox — a picture is for looking at. Folding / expanding the
// stack is owned by the panel's empty region (the bubble outside the thumbnails)
// and by the explicit toggle button, never by a thumbnail, so zooming can never
// accidentally collapse the sequence.

const readAsBase64 = (file) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1] || '');
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(file);
});

async function attachFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    uploading.value++;
    try {
      const dataBase64 = await readAsBase64(f);
      const r = await api.attach(f.type, dataBase64, f.name || 'pasted.png');
      if (r.ok) pending.value.push({ id: r.attachmentId, url: r.url, name: f.name || 'screenshot', mediaType: f.type });
      else state.transcript.push({ role: 'system', text: `attach failed: ${r.error}`, ts: Date.now() });
    } catch (e) {
      state.transcript.push({ role: 'system', text: `attach failed: ${e.message}`, ts: Date.now() });
    } finally { uploading.value--; }
  }
}

function onPaste(e) {
  const files = [...(e.clipboardData?.items || [])]
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (files.length) { e.preventDefault(); attachFiles(files); }
}

function removePending(id) { pending.value = pending.value.filter((p) => p.id !== id); }

// Click-to-zoom: show any thumbnail / sent attachment full-size in a lightbox.
function openLightbox(url, name) { lightbox.value = { url, name: name || 'screenshot' }; }
function closeLightbox() { lightbox.value = null; }
function onKeydown(e) { if (e.key === 'Escape') lightbox.value = null; }

// Snapshot the live 3D viewer (left panel) and queue it like an uploaded image,
// so it rides along with the next message to the assistant.
async function captureViewer() {
  const dataUrl = captureViewerFrame();
  if (!dataUrl) { state.transcript.push({ role: 'system', text: 'viewer not ready to capture', ts: Date.now() }); return; }
  const [meta, b64] = dataUrl.split(',');
  const mediaType = (meta.match(/data:([^;]+);/) || [])[1] || 'image/png';
  uploading.value++;
  try {
    const r = await api.attach(mediaType, b64, 'viewer-screenshot.png');
    if (r.ok) pending.value.push({ id: r.attachmentId, url: r.url, name: 'viewer-screenshot.png', mediaType });
    else state.transcript.push({ role: 'system', text: `attach failed: ${r.error}`, ts: Date.now() });
  } catch (e) {
    state.transcript.push({ role: 'system', text: `attach failed: ${e.message}`, ts: Date.now() });
  } finally { uploading.value--; }
}

async function submit() {
  const t = draft.value.trim();
  if (!t && !pending.value.length) return;
  if (uploading.value) return; // wait for in-flight attachments
  const atts = pending.value.slice();
  draft.value = '';
  pending.value = [];
  send(t, atts);
  nextTick(autoGrow);
}

// Composer height: the textarea auto-grows with its content (wrapped or pasted
// lines) up to a cap, then scrolls inside. Dragging the grip above the box
// switches to a manual height; double-clicking the grip returns to auto-grow.
const MIN_H = 34;
const autoMax = () => Math.max(140, Math.round(innerHeight * 0.35));
const manMax = () => Math.round(innerHeight * 0.7);
function autoGrow() {
  const el = taRef.value;
  if (!el || userH.value) return;
  const border = el.offsetHeight - el.clientHeight;
  el.style.height = 'auto';
  el.style.height = Math.min(Math.max(el.scrollHeight + border, MIN_H), autoMax()) + 'px';
}
watch(draft, () => nextTick(autoGrow));

// Enter sends, Shift+Enter inserts a newline (textarea default).
function onEnterKey(e) {
  if (e.isComposing) return;
  if (!e.shiftKey) { e.preventDefault(); submit(); }
}

function startResize(e) {
  e.preventDefault();
  const el = taRef.value;
  if (!el) return;
  const y0 = e.clientY;
  const h0 = el.offsetHeight;
  const move = (ev) => {
    const h = Math.min(Math.max(h0 + (y0 - ev.clientY), MIN_H), manMax());
    userH.value = h;
    el.style.height = h + 'px';
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}
function resetHeight() { userH.value = null; nextTick(autoGrow); }

async function scrollDown() {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}
watch(() => state.transcript.length, scrollDown);
watch(() => state.transcript[state.transcript.length - 1]?.text, scrollDown); // streaming deltas
watch(() => state.statusLine, scrollDown); // the live "please wait" line appears/updates at the end

onMounted(async () => { connect(); await resume(); scrollDown(); nextTick(autoGrow); addEventListener('keydown', onKeydown); });
onBeforeUnmount(() => { removeEventListener('keydown', onKeydown); });
</script>

<template>
  <div class="chat">
    <div class="head">
      <span>AI assistant</span>
    </div>
    <div ref="scroller" class="log" @paste="onPaste">
      <div v-if="!state.transcript.length" class="empty">
        Ask the assistant to recommend joints, or load a mesh and pick one to begin.
        Tip: paste (Ctrl+V) or upload a viewer screenshot to report a visual bug.
      </div>
      <template v-for="row in rows" :key="row.key">
        <div v-if="row.type === 'msg' && row.m.role === 'tool'" class="tool-line" :title="row.m.text">⚙ {{ row.m.text }}</div>
        <div v-else-if="row.type === 'msg'" class="msg" :class="[row.m.role, { streaming: row.m.streaming, cmd: row.m.command }]">
          <div class="bubble">
            <div v-if="row.m.attachments?.length" class="shots">
              <img v-for="a in row.m.attachments" :key="a.id || a.url" class="zoomable" :src="a.url" :alt="a.name || 'screenshot'" loading="lazy" @click="openLightbox(a.url, a.name)" />
            </div>
            <div v-if="row.m.text" class="txt" :class="{ foldable: isLong(row.m) }" @click="maybeToggleLong(row.m, row.key)"><span class="txtbody" :class="{ clamped: isLong(row.m) && !openLong.has(row.key) }">{{ row.m.text }}</span><span v-if="isLong(row.m)" class="foldhint">{{ openLong.has(row.key) ? '⌃ collapse' : `⌄ show all ${lineCount(row.m)} lines` }}</span></div>
            <div v-if="row.m.tools?.length && !row.m.streaming" class="tools">
              <div v-for="(t, k) in row.m.tools" :key="k" class="tool-line">⚙ {{ t }}</div>
            </div>
          </div>
        </div>
        <!-- a run of consecutive assistant screenshots, stacked to one frame -->
        <div v-else class="msg assistant">
          <div class="bubble stackb" :class="{ open: openStacks.has(row.key) }" @click="toggleStack(row.key)">
            <div v-for="it in visibleShots(row)" :key="it.i" class="shot">
              <div class="shotimg">
                <img v-for="a in it.m.attachments" :key="a.id || a.url" class="zoomable" :src="a.url" :alt="a.name || 'screenshot'" loading="lazy" @click.stop="openLightbox(a.url, a.name)" />
                <span v-if="!openStacks.has(row.key) && row.items.length > 1" class="stackbadge" :title="`${row.items.length} screenshots stacked — click a frame to zoom, the panel to expand`">{{ row.items.length }}</span>
              </div>
              <div v-if="it.m.text" class="txt shotnote">{{ it.m.text }}</div>
            </div>
            <button v-if="row.items.length > 1" type="button" class="stacktoggle" @click.stop="toggleStack(row.key)">
              {{ openStacks.has(row.key) ? 'fold the stack' : `show all ${row.items.length} screenshots` }}
            </button>
          </div>
        </div>
      </template>
      <div v-if="state.busy && !state.transcript.some((m) => m.streaming)" class="msg assistant"><div class="bubble typing">thinking…</div></div>
      <div v-if="state.statusLine" class="msg assistant"><div class="bubble status"><span class="pulse" aria-hidden="true" />{{ state.statusLine }}</div></div>
    </div>
    <div v-if="pending.length" class="thumbs">
      <div v-for="p in pending" :key="p.id" class="thumb">
        <img :src="p.url" :alt="p.name" class="zoomable" @click="openLightbox(p.url, p.name)" />
        <button type="button" class="x" title="Remove" @click="removePending(p.id)">×</button>
      </div>
      <span v-if="uploading" class="uploading">uploading…</span>
    </div>
    <div v-if="state.notice" class="queue-notice">{{ state.notice }}</div>
    <form class="composer" @submit.prevent="submit">
      <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="attachFiles([...fileInput.files]); fileInput.value = ''" />
      <button type="button" class="attach" title="Capture the 3D viewer as a screenshot" :disabled="!state.viewer.glb" @click="captureViewer"><span class="ic ic-shot" aria-hidden="true"></span></button>
      <button type="button" class="attach" title="Upload an image (or paste with Ctrl+V)" @click="fileInput.click()"><span class="ic ic-folder" aria-hidden="true"></span></button>
      <div class="ta-wrap">
        <div class="grip" title="Drag to resize · double-click for auto height" @pointerdown="startResize" @dblclick="resetHeight"><span /></div>
        <textarea ref="taRef" v-model="draft" rows="1" :placeholder="state.refining ? 'Message the assistant… discovery pauses at every boundary to answer you — and a served request can change what is left of the plan (try /discovery status, stop, drop <joint>, postpone <joint>)' : 'Message the assistant… Enter sends · Shift+Enter new line · Ctrl+V pastes screenshots · while busy, sends queue up'" @paste="onPaste" @keydown.enter="onEnterKey"></textarea>
      </div>
      <button type="submit" class="sendbtn" :title="state.refining ? 'Send — it queues behind the running step and is answered at the next boundary' : 'Send (Enter sends · while busy, sends queue up)'" :disabled="uploading > 0 || (!draft.trim() && !pending.length)"><span class="ic ic-send" aria-hidden="true"></span></button>
      <button type="button" class="stopbtn" :title="state.refining ? 'Stop everything now — cancels the look in flight, halts discovery and removes queued messages; the joints already checked stay' : 'Stop everything now — cancels the task in flight, kills a running generation and removes queued messages'" :disabled="!state.busy && !state.refining" @click="stop"><span class="ic ic-stop" aria-hidden="true"></span></button>
    </form>

    <!-- Click-to-zoom lightbox (teleported to <body> so it escapes the pane). -->
    <Teleport to="body">
      <div v-if="lightbox" class="lightbox" role="dialog" aria-modal="true" @click.self="closeLightbox">
        <button type="button" class="lb-close" title="Close (Esc)" @click="closeLightbox">×</button>
        <img :src="lightbox.url" :alt="lightbox.name" />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.chat { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.head { display: flex; justify-content: space-between; align-items: center; color: var(--good); font-family: ui-monospace, monospace; font-size: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
.log { flex: 1; overflow-y: auto; min-height: 0; padding-right: 4px; }
.empty { color: var(--faint); font-style: italic; font-size: 12px; padding: 8px 2px; }
.msg { display: flex; margin: 6px 0; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 86%; padding: 7px 10px; border-radius: 10px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; }
.msg.user .bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 3px; }
.msg.assistant .bubble { background: var(--panel-2); color: var(--text); border: 1px solid var(--border-2); border-bottom-left-radius: 3px; }
/* Deterministic slash-command replies (e.g. /help) read as output, not prose. */
.msg.assistant.cmd .bubble { font-family: ui-monospace, monospace; font-size: 12px; }
.msg.system .bubble { background: transparent; color: var(--warn); font-size: 12px; font-family: ui-monospace, monospace; }
.msg.streaming .bubble { opacity: .85; }
.typing { color: var(--muted); font-style: italic; }
/* Live status line: the single "DSH is asking <model> … please wait" bubble that
   sits at the very end of the transcript while a remote call is in flight. A
   soft pulsing dot marks it as LIVE (working), not as a settled answer. */
.msg.assistant .bubble.status { color: var(--warn); border-color: var(--border-accent, var(--accent-2)); font-size: 12px; display: flex; align-items: baseline; gap: 7px; }
.bubble.status .pulse { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--warn); align-self: center; animation: statusPulse 1.1s ease-in-out infinite; }
@keyframes statusPulse { 0%, 100% { opacity: .35; transform: scale(.82); } 50% { opacity: 1; transform: scale(1.15); } }
.shots { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.shots img { max-width: 100%; max-height: 180px; border-radius: 6px; border: 1px solid var(--border-2); display: block; }
/* Foldable text: an over-long message clips to LONG_LINES lines and the block is
   clickable to expand / collapse, with a hint naming the real length. */
.txt { white-space: pre-wrap; }
.txt.foldable { cursor: pointer; }
/* The folded preview is clamped by HEIGHT (ten line-boxes), not by slicing source
   lines: narrowing the panel re-wraps the text INSIDE the same ten-line window
   instead of stretching the block. 1.45em is the bubble line-height, so ten lines
   = 14.5em at whatever font-size the bubble uses. */
.txtbody { display: block; white-space: pre-wrap; }
.txtbody.clamped { max-height: 14.5em; overflow: hidden; }
.foldhint { display: block; color: var(--muted); font-size: 11px; font-style: italic; }
/* Screenshot stack: a run of assistant frames collapses to its first image with a
   count badge; expanding reveals every frame with its own annotation. */
.shot { margin-bottom: 6px; }
.shot:last-of-type { margin-bottom: 0; }
/* The panel's empty region (outside the thumbnails) is the fold/expand handle, so
   it reads as clickable; thumbnails keep their own zoom-in cursor. */
.bubble.stackb { cursor: pointer; }
.shotimg { position: relative; display: inline-block; }
.shotimg img { max-width: 100%; max-height: 180px; border-radius: 6px; border: 1px solid var(--border-2); display: block; }
.stackbadge { position: absolute; top: 4px; right: 4px; background: rgba(0, 0, 0, .62); color: #fff; font-family: ui-monospace, monospace; font-size: 11px; line-height: 1; padding: 3px 6px; border-radius: 9px; pointer-events: none; }
.shotnote { font-size: 12px; color: var(--muted); margin-top: 3px; }
.stacktoggle { display: block; width: 100%; margin-top: 6px; background: transparent; border: 1px dashed var(--border-2); color: var(--muted); border-radius: 6px; font-size: 11px; padding: 3px 6px; cursor: pointer; }
.stacktoggle:hover { color: var(--text); border-color: var(--border-accent); }
.tool-line { color: var(--muted); font-family: ui-monospace, monospace; font-size: 11px; padding: 1px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tools { margin-top: 6px; border-top: 1px dashed var(--border-2); padding-top: 4px; }
.thumbs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 6px 0 0; }
.thumb { position: relative; }
.thumb img { width: 52px; height: 52px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border-2); display: block; }
.thumb .x { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; line-height: 14px; padding: 0; border-radius: 50%; background: var(--panel-2); color: var(--text); border: 1px solid var(--border-2); cursor: pointer; font-size: 12px; }
.uploading { color: var(--muted); font-size: 11px; font-style: italic; }
.composer { display: flex; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); margin-top: 8px; align-items: flex-end; }
.ta-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; }
/* Height grip: drag vertically to set a manual composer height, dblclick = auto. */
.grip { height: 9px; display: flex; align-items: center; justify-content: center; cursor: ns-resize; touch-action: none; }
.grip span { width: 34px; height: 3px; border-radius: 2px; background: var(--border-2); }
.grip:hover span { background: var(--border-accent); }
.composer textarea { resize: none; overflow-y: auto; width: 100%; min-height: 34px; background: var(--input-bg); border: 1px solid var(--border-2); border-radius: 7px; color: var(--text); padding: 8px 10px; font-size: 13px; line-height: 1.45; font-family: inherit; display: block; }
.composer textarea:focus { outline: none; border-color: var(--border-accent); }
.composer button { background: var(--accent); border: 1px solid var(--accent-2); color: #fff; border-radius: 7px; padding: 0 14px; height: 35px; cursor: pointer; font-size: 13px; }
.composer button.attach { background: var(--panel-2); border-color: var(--border-2); color: var(--text); padding: 0 10px; display: inline-flex; align-items: center; justify-content: center; }
/* Icon glyphs: the SVG artwork is applied as a CSS mask so the tint follows the
   button's currentColor (theme-aware) instead of the file's baked-in gray. */
.ic { width: 16px; height: 16px; display: inline-block; background-color: currentColor; mask-size: contain; mask-repeat: no-repeat; mask-position: center; -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat; -webkit-mask-position: center; }
.ic-shot { mask-image: url('../assets/screen_shot.svg'); -webkit-mask-image: url('../assets/screen_shot.svg'); }
/* The folder artwork is wide-but-short, so give it an aspect-matched box that is
   a touch larger than the square icons; it then fills the button and centers. */
.ic-folder { width: 18px; height: 16px; mask-image: url('../assets/file_folder.svg'); -webkit-mask-image: url('../assets/file_folder.svg'); }
.composer button:disabled { opacity: .45; cursor: default; }
/* Send/Stop are icon buttons right of the textarea: same mask technique as the
   attach buttons so the glyph tint follows currentColor (white on their fills).
   Stop sits right of Send and is only live while a turn is in flight. */
.composer button.sendbtn, .composer button.stopbtn { padding: 0 10px; display: inline-flex; align-items: center; justify-content: center; }
.composer button.stopbtn { background: #b3261e; border-color: #8c1d18; margin-left: 6px; }
.ic-send { mask-image: url('../assets/send.svg'); -webkit-mask-image: url('../assets/send.svg'); }
.ic-stop { mask-image: url('../assets/stop.svg'); -webkit-mask-image: url('../assets/stop.svg'); }
.queue-notice { font-size: 11px; color: var(--text-dim, #8a6d1b); padding: 2px 10px 0; }

/* click-to-zoom lightbox */
.zoomable { cursor: zoom-in; }
.lightbox {
  position: fixed; inset: 0; z-index: 1000; cursor: zoom-out;
  background: rgba(0, 0, 0, .78); display: flex; align-items: center; justify-content: center;
  padding: 4vh 4vw;
}
.lightbox img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; box-shadow: 0 8px 40px rgba(0, 0, 0, .5); cursor: default; }
.lightbox .lb-close {
  position: absolute; top: 14px; right: 16px; width: 34px; height: 34px; line-height: 1;
  border-radius: 50%; background: var(--panel-2); color: var(--text); border: 1px solid var(--border-2);
  cursor: pointer; font-size: 18px;
}
.lightbox .lb-close:hover { border-color: var(--accent-2); }
</style>

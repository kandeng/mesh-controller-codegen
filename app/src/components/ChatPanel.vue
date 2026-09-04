<script setup>
// ChatPanel — the only surface the user sees: an "AI assistant". The live DSH
// agent is invisible underneath. Screenshots are human-initiated: paste from the
// clipboard (Ctrl+V in the composer) or upload a local image file; thumbnails
// queue above the composer and ride along with the next message. The transcript
// (text, images, tool activity lines) is restored from the session store on load.
import { ref, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useAgentSocket } from '../composables/useAgentSocket.js';
import { useKernelApi } from '../composables/useKernelApi.js';
import { useViewerCapture } from '../composables/useViewerCapture.js';

const { state } = useProjectStore();
const { connect, send, resume } = useAgentSocket();
const api = useKernelApi();
const { capture: captureViewerFrame } = useViewerCapture();

const draft = ref('');
const scroller = ref(null);
const fileInput = ref(null);
const pending = ref([]);   // [{ id, url, name, mediaType }] uploaded, not yet sent
const uploading = ref(0);
const lightbox = ref(null);   // { url, name } of the image shown full-size

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
}

async function scrollDown() {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}
watch(() => state.transcript.length, scrollDown);
watch(() => state.transcript[state.transcript.length - 1]?.text, scrollDown); // streaming deltas

onMounted(async () => { connect(); await resume(); scrollDown(); addEventListener('keydown', onKeydown); });
onBeforeUnmount(() => { removeEventListener('keydown', onKeydown); });
</script>

<template>
  <div class="chat">
    <div class="head">
      <span>AI assistant</span>
      <span class="mode" :title="`agent mode: ${state.agent.mode}`">{{ state.agent.mode }}</span>
    </div>
    <div ref="scroller" class="log" @paste="onPaste">
      <div v-if="!state.transcript.length" class="empty">
        Ask the assistant to recommend joints, or load a mesh and pick one to begin.
        Tip: paste (Ctrl+V) or upload a viewer screenshot to report a visual bug.
      </div>
      <template v-for="(m, i) in state.transcript" :key="i">
        <div v-if="m.role === 'tool'" class="tool-line" :title="m.text">⚙ {{ m.text }}</div>
        <div v-else class="msg" :class="[m.role, { streaming: m.streaming }]">
          <div class="bubble">
            <div v-if="m.attachments?.length" class="shots">
              <img v-for="a in m.attachments" :key="a.id || a.url" class="zoomable" :src="a.url" :alt="a.name || 'screenshot'" loading="lazy" @click="openLightbox(a.url, a.name)" />
            </div>
            <template v-if="m.text">{{ m.text }}</template>
            <div v-if="m.tools?.length && !m.streaming" class="tools">
              <div v-for="(t, k) in m.tools" :key="k" class="tool-line">⚙ {{ t }}</div>
            </div>
          </div>
        </div>
      </template>
      <div v-if="state.busy && !state.transcript.some((m) => m.streaming)" class="msg assistant"><div class="bubble typing">thinking…</div></div>
    </div>
    <div v-if="pending.length" class="thumbs">
      <div v-for="p in pending" :key="p.id" class="thumb">
        <img :src="p.url" :alt="p.name" class="zoomable" @click="openLightbox(p.url, p.name)" />
        <button type="button" class="x" title="Remove" @click="removePending(p.id)">×</button>
      </div>
      <span v-if="uploading" class="uploading">uploading…</span>
    </div>
    <form class="composer" @submit.prevent="submit">
      <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="attachFiles([...fileInput.files]); fileInput.value = ''" />
      <button type="button" class="attach" title="Capture the 3D viewer as a screenshot" :disabled="state.busy || !state.viewer.glb" @click="captureViewer"><span class="ic ic-shot" aria-hidden="true"></span></button>
      <button type="button" class="attach" title="Upload an image (or paste with Ctrl+V)" :disabled="state.busy" @click="fileInput.click()"><span class="ic ic-folder" aria-hidden="true"></span></button>
      <input v-model="draft" type="text" placeholder="Message the assistant… (paste screenshots with Ctrl+V)" :disabled="state.busy" @paste="onPaste" />
      <button type="submit" :disabled="state.busy || uploading > 0 || (!draft.trim() && !pending.length)">Send</button>
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
.mode { color: var(--faint); border: 1px solid var(--border-2); border-radius: 5px; padding: 1px 6px; }
.log { flex: 1; overflow-y: auto; min-height: 0; padding-right: 4px; }
.empty { color: var(--faint); font-style: italic; font-size: 12px; padding: 8px 2px; }
.msg { display: flex; margin: 6px 0; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 86%; padding: 7px 10px; border-radius: 10px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; }
.msg.user .bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 3px; }
.msg.assistant .bubble { background: var(--panel-2); color: var(--text); border: 1px solid var(--border-2); border-bottom-left-radius: 3px; }
.msg.system .bubble { background: transparent; color: var(--warn); font-size: 12px; font-family: ui-monospace, monospace; }
.msg.streaming .bubble { opacity: .85; }
.typing { color: var(--muted); font-style: italic; }
.shots { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.shots img { max-width: 100%; max-height: 180px; border-radius: 6px; border: 1px solid var(--border-2); display: block; }
.tool-line { color: var(--muted); font-family: ui-monospace, monospace; font-size: 11px; padding: 1px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tools { margin-top: 6px; border-top: 1px dashed var(--border-2); padding-top: 4px; }
.thumbs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 6px 0 0; }
.thumb { position: relative; }
.thumb img { width: 52px; height: 52px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border-2); display: block; }
.thumb .x { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; line-height: 14px; padding: 0; border-radius: 50%; background: var(--panel-2); color: var(--text); border: 1px solid var(--border-2); cursor: pointer; font-size: 12px; }
.uploading { color: var(--muted); font-size: 11px; font-style: italic; }
.composer { display: flex; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); margin-top: 8px; }
.composer input[type="text"] { flex: 1; background: var(--input-bg); border: 1px solid var(--border-2); border-radius: 7px; color: var(--text); padding: 8px 10px; font-size: 13px; }
.composer input:focus { outline: none; border-color: var(--border-accent); }
.composer button { background: var(--accent); border: 1px solid var(--accent-2); color: #fff; border-radius: 7px; padding: 0 14px; cursor: pointer; font-size: 13px; }
.composer button.attach { background: var(--panel-2); border-color: var(--border-2); color: var(--text); padding: 0 10px; display: inline-flex; align-items: center; justify-content: center; }
/* Icon glyphs: the SVG artwork is applied as a CSS mask so the tint follows the
   button's currentColor (theme-aware) instead of the file's baked-in gray. */
.ic { width: 16px; height: 16px; display: inline-block; background-color: currentColor; mask-size: contain; mask-repeat: no-repeat; mask-position: center; -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat; -webkit-mask-position: center; }
.ic-shot { mask-image: url('../assets/screen_shot.svg'); -webkit-mask-image: url('../assets/screen_shot.svg'); }
/* The folder artwork is wide-but-short, so give it an aspect-matched box that is
   a touch larger than the square icons; it then fills the button and centers. */
.ic-folder { width: 18px; height: 16px; mask-image: url('../assets/file_folder.svg'); -webkit-mask-image: url('../assets/file_folder.svg'); }
.composer button:disabled { opacity: .45; cursor: default; }

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

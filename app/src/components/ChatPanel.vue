<script setup>
// ChatPanel — the only surface the user sees: an "AI assistant". DSH is invisible
// underneath (stub in M1). The transcript is restored from the session store on
// load, so reopening the localhost resumes the conversation.
import { ref, nextTick, watch, onMounted } from 'vue';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useAgentSocket } from '../composables/useAgentSocket.js';

const { state } = useProjectStore();
const { connect, send, resume } = useAgentSocket();

const draft = ref('');
const scroller = ref(null);

async function submit() {
  const t = draft.value.trim();
  if (!t) return;
  draft.value = '';
  send(t);
}

async function scrollDown() {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}
watch(() => state.transcript.length, scrollDown);

onMounted(async () => { connect(); await resume(); scrollDown(); });
</script>

<template>
  <div class="chat">
    <div class="head">
      <span>AI assistant</span>
      <span class="mode" :title="`agent mode: ${state.agent.mode}`">{{ state.agent.mode }}</span>
    </div>
    <div ref="scroller" class="log">
      <div v-if="!state.transcript.length" class="empty">
        Ask the assistant to recommend joints, or load a mesh and pick one to begin.
      </div>
      <div v-for="(m, i) in state.transcript" :key="i" class="msg" :class="m.role">
        <div class="bubble">{{ m.text }}</div>
      </div>
      <div v-if="state.busy" class="msg assistant"><div class="bubble typing">thinking…</div></div>
    </div>
    <form class="composer" @submit.prevent="submit">
      <input v-model="draft" type="text" placeholder="Message the assistant…" :disabled="state.busy" />
      <button type="submit" :disabled="state.busy || !draft.trim()">Send</button>
    </form>
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
.typing { color: var(--muted); font-style: italic; }
.composer { display: flex; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); margin-top: 8px; }
.composer input { flex: 1; background: var(--input-bg); border: 1px solid var(--border-2); border-radius: 7px; color: var(--text); padding: 8px 10px; font-size: 13px; }
.composer input:focus { outline: none; border-color: var(--border-accent); }
.composer button { background: var(--accent); border: 1px solid var(--accent-2); color: #fff; border-radius: 7px; padding: 0 14px; cursor: pointer; font-size: 13px; }
.composer button:disabled { opacity: .45; cursor: default; }
</style>

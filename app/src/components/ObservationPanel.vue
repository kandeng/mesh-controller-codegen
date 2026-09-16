<script setup>
// ObservationPanel — the evidence browser and the human verdict gate.
//
// This is the panel the whole human-in-the-loop arrangement exists for. A
// confidence number cannot be argued with; a thumbnail of the exact frame the
// model was looking at, next to the sentence it wrote and the list of things it
// admitted it was unsure of, can. So the panel's job is to put those three things
// on one screen before it offers a single button.
//
// Three deliberate choices:
//
//   - The peer checkboxes are part of the SAME submission as the verdict, not a
//     second call. Amortizing is a property of the decision ("I accept this, and
//     its mirror is the same part"), and splitting it would let a human accept
//     here, lose the connection there, and leave a family half-judged with no
//     record of why.
//   - An `edit` disables the peer list rather than hiding it. The reason is on
//     screen: an edit is written in THIS joint's node names and a mirror's nodes
//     are different nodes, so offering it would be offering to copy a correction
//     onto parts it was never about.
//   - A refusal is shown with the server's own sentence, and the verdict is
//     reported separately from its amortization. An accept that applied while one
//     mirror was skipped is a SUCCESS, and painting the whole thing red would
//     tell the human their accept did not happen — so they would press it again.
import { computed, ref, watch } from 'vue';
import { useProjectStore } from '../composables/useProjectStore.js';
import { useKernelApi } from '../composables/useKernelApi.js';

const { state, applyJoints } = useProjectStore();
const api = useKernelApi();

const tab = ref('claim');            // 'claim' | 'rounds'
const ev = ref(null);                // GET /api/joints/:id/evidence
const loading = ref(false);
const loadErr = ref('');

// Verdict form. `decision` stays null until a button is pressed: the panel must
// not look like it has already made up its mind about an unjudged joint.
const decision = ref(null);
const note = ref('');
const chosen = ref([]);              // peer ids the verdict should travel to
const busy = ref(false);
const msg = ref('');
const msgBad = ref(false);

// Edit form, opened only for an `edit` verdict.
const editing = ref(false);
const form = ref({ label: '', type: 'rotor', nodes: '', anchor: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 } });

// Round browser ('rounds' tab).
const openRound = ref(null);
const roundFrames = ref([]);
const roundBusy = ref(false);

// Lightbox: a thumbnail is 96px and a blade count is not readable at 96px.
const zoom = ref(null);

const joint = computed(() => ev.value?.joint || null);
const frames = computed(() => ev.value?.frames || []);
const peers = computed(() => ev.value?.peers?.peers || []);
const rounds = computed(() => ev.value?.rounds || []);
// Amortizing is only offered for a whole judgement. The server enforces this too;
// mirroring the rule here is what stops the panel offering a button that the
// write path then refuses.
const canAmortize = computed(() => decision.value === 'accept' || decision.value === 'reject');

const STATUS_GLYPH = {
  'auto-accepted': { g: '✓', c: 'ok' },
  confirmed: { g: '✓', c: 'ok' },
  'needs-verdict': { g: '!', c: 'warn' },
  rejected: { g: '✗', c: 'bad' },
  candidate: { g: '·', c: 'dim' },
};
const chip = (s) => STATUS_GLYPH[s] || STATUS_GLYPH.candidate;

// Which frames are the claim's own evidence and which are only the mask drawn
// around its parts. Separated because "the model looked at this" and "this is a
// mask of the same parts" are different strengths of evidence, and a human about
// to reject a joint is entitled to know which one they are looking at. The
// distinction is drawn per thumbnail (`matchedBy`), so only the count of the
// strong tier is summarised here.
const namedFrames = computed(() => frames.value.filter((f) => f.matchedBy === 'frameId'));

async function load(id) {
  if (!id) { ev.value = null; return; }
  loading.value = true;
  loadErr.value = '';
  try {
    const r = await api.jointEvidence(id);
    if (!r.ok) { ev.value = null; loadErr.value = r.error || 'could not load the evidence'; return; }
    ev.value = r;
    resetForm();
  } catch (e) {
    ev.value = null;
    loadErr.value = e.message;
  } finally {
    loading.value = false;
  }
}

watch(() => state.activeJointId, (id) => {
  tab.value = 'claim';
  openRound.value = null;
  roundFrames.value = [];
  msg.value = '';
  load(id);
}, { immediate: true });

function resetForm() {
  const j = joint.value;
  decision.value = null;
  note.value = '';
  chosen.value = [];
  editing.value = false;
  msg.value = '';
  msgBad.value = false;
  const v3 = (o) => ({ x: Number(o?.x) || 0, y: Number(o?.y) || 0, z: Number(o?.z) || 0 });
  form.value = {
    label: j?.label || '',
    type: j?.type || 'rotor',
    nodes: (j?.nodes || []).join('\n'),
    anchor: v3(j?.anchor),
    axis: v3(j?.axis),
  };
}

function pick(d) {
  decision.value = decision.value === d ? null : d;
  editing.value = decision.value === 'edit';
  // Peers cannot inherit an edit, so a switch to 'edit' clears a selection that
  // would otherwise sit there looking chosen and then be silently refused.
  if (!canAmortize.value) chosen.value = [];
  msg.value = '';
}

function togglePeer(id) {
  const i = chosen.value.indexOf(id);
  if (i < 0) chosen.value.push(id); else chosen.value.splice(i, 1);
}

// A peer that already carries a DIRECT human verdict will be skipped by the
// server, so the checkbox is disabled and the reason is on the label. An
// inherited one may be replaced — it is not direct evidence, and the newer
// family decision is at least as good.
const peerLocked = (p) => !!(p.verdict && !p.verdict.amortizedFrom);
const peerWhy = (p) => (peerLocked(p) ? `already judged directly ("${p.verdict.decision}")` : (p.gloss || ''));

// Only the fields the human actually changed are sent. An edit marks the whole
// battery stale, so sending an untouched anchor would re-open a joint for a
// change nobody made.
const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 1e-6;
function editedFields() {
  const j = joint.value || {};
  const out = {};
  const label = form.value.label.trim();
  if (label && label !== j.label) out.label = label;
  if (form.value.type && form.value.type !== j.type) out.type = form.value.type;
  const nodes = form.value.nodes.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const before = [...(j.nodes || [])].sort().join('\u0000');
  if (nodes.length && nodes.slice().sort().join('\u0000') !== before) out.nodes = nodes;
  for (const f of ['anchor', 'axis']) {
    const a = form.value[f];
    const b = j[f] || {};
    if (!near(a.x, b.x) || !near(a.y, b.y) || !near(a.z, b.z)) out[f] = { x: a.x, y: a.y, z: a.z };
  }
  return out;
}

async function submit() {
  if (!decision.value || busy.value) return;
  const edits = decision.value === 'edit' ? editedFields() : null;
  if (decision.value === 'edit' && !Object.keys(edits).length) {
    msg.value = 'nothing to change — an edit verdict needs at least one field that differs';
    msgBad.value = true;
    return;
  }
  busy.value = true;
  msg.value = '';
  msgBad.value = false;
  try {
    const { status, body } = await api.setVerdict(state.activeJointId, {
      decision: decision.value,
      edits,
      note: note.value.trim() || null,
      actor: 'human',
      amortizeTo: canAmortize.value && chosen.value.length ? [...chosen.value] : null,
    });
    // The verdict and its amortization are reported separately by the server, and
    // they are reported separately here: `ok:true` with a refused amortization is
    // a success with a footnote, not a failure.
    if (!body?.ok) {
      msg.value = `${body?.error || `refused (${status})`}`;
      msgBad.value = true;
      return;
    }
    const am = body.amortized;
    const parts = [];
    parts.push(`${body.decision} → ${body.status}`);
    if (body.applied?.length) parts.push(`edited ${body.applied.join(', ')}`);
    if (body.refused?.length) parts.push(`refused ${body.refused.map((r) => `${r.field}: ${r.why}`).join('; ')}`);
    if (am) {
      if (am.applied?.length) parts.push(`passed on to ${am.applied.map((a) => a.id).join(', ')}`);
      for (const s of [...(am.skipped || []), ...(am.refused || [])]) parts.push(`skipped ${s.id} — ${s.why}`);
      if (!am.ok && !am.applied?.length) parts.push(am.error || 'no peer took the verdict');
    }
    msg.value = parts.join(' · ');
    msgBad.value = !!(body.refused?.length) || !!(am && !am.ok && !am.applied?.length);

    // Refresh the served joint list so the chips in step 3 and the viewer's
    // colours agree with the record that was just written.
    const j = await api.joints();
    if (j.ok) applyJoints(j.joints);
    await load(state.activeJointId);
  } catch (e) {
    msg.value = e.message;
    msgBad.value = true;
  } finally {
    busy.value = false;
  }
}

async function toggleRound(r) {
  if (openRound.value === r.round) { openRound.value = null; roundFrames.value = []; return; }
  openRound.value = r.round;
  roundFrames.value = [];
  roundBusy.value = true;
  try {
    const d = await api.observation(r.round);
    roundFrames.value = d.ok ? (d.frames || []) : [];
  } catch {
    roundFrames.value = [];
  } finally {
    roundBusy.value = false;
  }
}

// Replay this round's camera path in the 3D view (the vision-round tour). The
// trigger lives here, beside the round's frames, because "show me how the AI
// looked" is a question about THIS round's evidence.
function toggleTour(n) {
  state.tourRound = state.tourRound === n ? null : n;
}

const kb = (n) => (n == null ? '' : `${Math.round(n / 1024)} KB`);
const modeTip = (f) => `${f.id} · ${f.mode}${f.width ? ` · ${f.width}×${f.height}` : ''}${f.bytes ? ` · ${kb(f.bytes)}` : ''}`;
</script>

<template>
  <div class="obs">
    <div class="tabs">
      <button :class="{ on: tab === 'claim' }" @click="tab = 'claim'">This claim</button>
      <button :class="{ on: tab === 'rounds' }" @click="tab = 'rounds'">
        All rounds <span v-if="rounds.length" class="n">{{ rounds.length }}</span>
      </button>
      <span v-if="loading" class="busy">loading…</span>
    </div>

    <div v-if="!state.activeJointId" class="empty">Select a joint above to read the evidence behind it.</div>
    <div v-else-if="loadErr" class="empty bad">{{ loadErr }}</div>

    <!-- ===================== the claim ================================== -->
    <section v-else-if="tab === 'claim' && joint" class="claim">
      <header class="head">
        <span class="chip" :class="chip(joint.status).c">{{ chip(joint.status).g }}</span>
        <span class="name">{{ joint.label }}</span>
        <span class="meta">{{ joint.type }} · {{ joint.nodes.length }} part(s) · conf {{ joint.confidence?.toFixed?.(2) ?? '—' }}</span>
        <span v-if="joint.origin" class="tag">{{ joint.origin }}</span>
        <span v-if="joint.verdict" class="tag verdict" :class="{ inherited: joint.verdict.amortizedFrom }">
          {{ joint.verdict.decision }}{{ joint.verdict.amortizedFrom ? ` ← ${joint.verdict.amortizedFrom}` : '' }}
        </span>
      </header>

      <p v-if="ev.ambiguous" class="warn">
        This frame id exists in more than one observation campaign and the record does not say which one
        produced it, so every match is shown. Check the round number before judging.
      </p>

      <!-- what the model said -->
      <div v-if="joint.reasoning" class="block">
        <div class="blk">What the model said</div>
        <p class="said">{{ joint.reasoning }}</p>
      </div>
      <div v-if="joint.uncertainties?.length" class="block">
        <div class="blk unsure">Where it was unsure</div>
        <ul class="list">
          <li v-for="(u, i) in joint.uncertainties" :key="i">{{ u }}</li>
        </ul>
      </div>
      <div v-if="joint.suggestView" class="block">
        <div class="blk">Where it asked us to look next</div>
        <p class="said">
          <code>{{ joint.suggestView.target }}</code>
          <span class="tag tiny">{{ joint.suggestView.origin }}</span><br />{{ joint.suggestView.reason }}
        </p>
      </div>
      <div v-if="joint.grounding" class="block">
        <div class="blk">How the claim was grounded</div>
        <p class="said mono">
          {{ joint.grounding.source }}<template v-if="joint.grounding.agreement"> · agreement {{ joint.grounding.agreement }}</template>
          <template v-if="joint.grounding.score != null"> · score {{ joint.grounding.score }}</template>
          <template v-if="joint.grounding.frameId"> · frame {{ joint.grounding.frameId }}</template>
        </p>
      </div>

      <!-- the frames -->
      <div class="block">
        <div class="blk">Frames behind this claim <span class="n">{{ namedFrames.length }}</span></div>
        <div v-if="!frames.length" class="empty">
          No frame is on disk for this joint — it came from {{ joint.origin || 'geometry' }}, not from a look at the mesh.
        </div>
        <div v-else class="strip">
          <figure v-for="f in frames" :key="`${f.round}:${f.id}`" class="thumb" :class="{ weak: f.matchedBy !== 'frameId' }">
            <img v-if="f.url" :src="f.url" :alt="f.id" :title="modeTip(f)" loading="lazy" @click="zoom = f" />
            <div v-else class="noimg" :title="modeTip(f)">missing</div>
            <figcaption>
              <span class="rid">r{{ f.round }}</span> {{ f.mode }}
              <span v-if="f.hasColors" class="tag tiny" title="a colour-id mask: pixel → part name is exact">mask</span>
              <span v-if="f.matchedBy !== 'frameId'" class="tag tiny" title="this frame was drawn with this joint's parts in focus, but the record does not name it">related</span>
            </figcaption>
            <p v-if="f.grounded?.agreement" class="gnd">grounded: {{ f.grounded.source }} / {{ f.grounded.agreement }}</p>
          </figure>
        </div>
      </div>

      <!-- tests -->
      <div v-if="joint.tests?.length" class="block">
        <div class="blk">Deterministic tests</div>
        <ul class="list tests">
          <li v-for="(t, i) in joint.tests" :key="i" :class="t.pass ? 'good' : (t.level === 'warn' ? 'warn' : 'bad')">
            <span class="m">{{ t.pass ? '✓' : (t.level === 'warn' ? '!' : '✗') }}</span>
            <code>{{ t.name }}</code><span v-if="t.detail"> — {{ t.detail }}</span>
          </li>
        </ul>
      </div>

      <!-- the verdict -->
      <div class="block verdictbox">
        <div class="blk">Your verdict</div>
        <div class="row">
          <button class="accept" :class="{ on: decision === 'accept' }" :disabled="busy" @click="pick('accept')">Accept</button>
          <button class="reject" :class="{ on: decision === 'reject' }" :disabled="busy" @click="pick('reject')">Reject</button>
          <button class="edit" :class="{ on: decision === 'edit' }" :disabled="busy" @click="pick('edit')">Edit…</button>
          <span v-if="joint.verdict" class="was">
            currently <b>{{ joint.verdict.decision }}</b> by {{ joint.verdict.actor }} at {{ joint.verdict.at?.slice(0, 19).replace('T', ' ') }}
          </span>
        </div>

        <!-- edit form -->
        <div v-if="editing" class="editform">
          <label class="f"><span>label</span><input v-model="form.label" type="text" :disabled="busy" /></label>
          <label class="f"><span>type</span>
            <select v-model="form.type" :disabled="busy">
              <option value="rotor">rotor</option><option value="gimbal">gimbal</option><option value="hinge">hinge</option>
            </select>
          </label>
          <label class="f wide"><span>parts (one per line)</span>
            <textarea v-model="form.nodes" rows="5" :disabled="busy" spellcheck="false"></textarea>
          </label>
          <label class="f"><span>anchor</span>
            <span class="vec">
              <input v-model.number="form.anchor.x" type="number" step="0.01" :disabled="busy" title="x" />
              <input v-model.number="form.anchor.y" type="number" step="0.01" :disabled="busy" title="y" />
              <input v-model.number="form.anchor.z" type="number" step="0.01" :disabled="busy" title="z" />
            </span>
          </label>
          <label class="f"><span>axis</span>
            <span class="vec">
              <input v-model.number="form.axis.x" type="number" step="0.01" :disabled="busy" title="x" />
              <input v-model.number="form.axis.y" type="number" step="0.01" :disabled="busy" title="y" />
              <input v-model.number="form.axis.z" type="number" step="0.01" :disabled="busy" title="z" />
            </span>
          </label>
          <p class="hint">An edit invalidates every test above — the battery is re-run against the corrected membership, and the joint goes back to <code>needs-verdict</code> until it passes.</p>
        </div>

        <!-- symmetry offer -->
        <div v-if="peers.length" class="peers" :class="{ off: decision === 'edit' }">
          <div class="blk">
            Offer the same verdict to symmetry peers
            <span class="n">{{ peers.length }}</span>
            <span v-if="decision === 'edit'" class="why">— not available for an edit: it is written in this joint's own part names, and a mirror's parts are different parts</span>
          </div>
          <label v-for="p in peers" :key="p.id" class="peer" :class="{ locked: peerLocked(p) }">
            <input type="checkbox" :checked="chosen.includes(p.id)" :disabled="busy || !canAmortize || peerLocked(p)" @change="togglePeer(p.id)" />
            <span class="basis" :class="p.basis">{{ p.basis }}</span>
            <span class="pid">{{ p.label || p.id }}</span>
            <span class="gloss" :title="peerWhy(p)">{{ peerWhy(p) }}</span>
            <span v-if="p.verdict" class="tag tiny" :class="{ inherited: p.verdict.amortizedFrom }">{{ p.verdict.decision }}</span>
          </label>
        </div>

        <div class="row noterow">
          <input v-model="note" type="text" placeholder="note (optional) — kept in the record's history" :disabled="busy" @keyup.enter="submit" />
          <button class="primary" :disabled="busy || !decision" @click="submit">{{ busy ? '…' : 'Record verdict' }}</button>
        </div>
        <p v-if="msg" class="result" :class="{ bad: msgBad }">{{ msg }}</p>
      </div>

      <!-- audit trail -->
      <div v-if="joint.history?.length" class="block">
        <div class="blk">History</div>
        <ul class="list hist">
          <li v-for="(h, i) in joint.history" :key="i">
            <span class="ts">{{ h.at?.slice(0, 19).replace('T', ' ') }}</span>
            <b>{{ h.event }}</b>
            <span v-if="h.decision"> {{ h.decision }}</span>
            <span v-if="h.actor"> by {{ h.actor }}</span>
            <span v-if="h.test"> test {{ h.test }}</span>
            <span v-if="h.amortizedFrom"> ← {{ h.amortizedFrom }}</span>
            <span v-if="h.note" class="note"> — {{ h.note }}</span>
          </li>
        </ul>
      </div>
    </section>

    <!-- ===================== every round ================================ -->
    <section v-else-if="tab === 'rounds'" class="rounds">
      <div v-if="!rounds.length" class="empty">No observation round has been run yet.</div>
      <div v-for="r in rounds" :key="r.round" class="round">
        <div class="rrow">
          <button class="rhead" @click="toggleRound(r)">
            <span class="rid">r{{ r.round }}</span>
            {{ r.frames }} frame(s) · {{ kb(r.bytes) }}
            <span v-for="m in r.modes" :key="m" class="tag tiny">{{ m }}</span>
            <span v-if="r.hasReply" class="tag tiny">reply</span>
            <span v-if="r.hasProposals" class="tag tiny">proposals</span>
          </button>
          <button
            class="tourbtn" :class="{ on: state.tourRound === r.round }"
            title="Replay this round's camera path in the 3D view"
            @click="toggleTour(r.round)"
          >{{ state.tourRound === r.round ? '■ stop' : '▶ tour' }}</button>
        </div>
        <div v-if="openRound === r.round" class="strip">
          <div v-if="roundBusy" class="empty">loading…</div>
          <figure v-for="f in roundFrames" :key="f.id" class="thumb">
            <img v-if="f.url" :src="f.url" :alt="f.id" :title="modeTip(f)" loading="lazy" @click="zoom = f" />
            <figcaption><span class="rid">r{{ r.round }}</span> {{ f.mode }}</figcaption>
          </figure>
        </div>
      </div>
    </section>

    <!-- lightbox -->
    <div v-if="zoom" class="lightbox" @click="zoom = null">
      <img :src="zoom.url" :alt="zoom.id" />
      <div class="cap">
        r{{ zoom.round }} · {{ zoom.id }} · {{ zoom.mode }}
        <span v-if="zoom.spec?.kind"> · {{ zoom.spec.kind }}</span>
        <span v-if="zoom.focus?.length"> · {{ zoom.focus.length }} part(s) in focus</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.obs { font-size: 12px; display: flex; flex-direction: column; gap: 10px; }
.tabs { display: flex; gap: 6px; align-items: center; }
.tabs button {
  font-size: 11px; padding: 3px 9px; border-radius: 8px; cursor: pointer;
  background: none; border: 1px solid var(--border-accent, #456); color: var(--text-dim);
}
.tabs button.on { color: var(--accent-2, #6aa); border-color: var(--accent-2, #6aa); }
.tabs .busy, .busy { color: var(--busy); font-size: 11px; margin-left: 6px; }
.n { color: var(--faint); font-family: ui-monospace, monospace; font-size: 10px; }

.empty { color: var(--faint); font-style: italic; padding: 4px 2px; }
.empty.bad, .bad { color: var(--bad); }
.warn {
  color: #b58900; border-left: 2px solid #b58900; padding: 4px 8px; margin: 0;
  background: var(--surface-3); font-size: 11px; line-height: 1.4;
}

.head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.name { color: var(--text); font-weight: 600; }
.meta { color: var(--muted); font-family: ui-monospace, monospace; font-size: 11px; }
.chip { font-size: 10px; font-weight: 700; border-radius: 8px; padding: 0 5px; line-height: 15px; border: 1px solid; }
.chip.ok { color: var(--good); border-color: var(--good); }
.chip.warn { color: #b58900; border-color: #b58900; }
.chip.bad { color: var(--bad); border-color: var(--bad); }
.chip.dim { color: var(--faint); border-color: var(--border-2); }
.tag {
  font-size: 10px; font-family: ui-monospace, monospace; color: var(--muted);
  border: 1px solid var(--border-2); border-radius: 6px; padding: 0 5px;
}
.tag.tiny { font-size: 9px; padding: 0 4px; }
.tag.verdict { color: var(--good); border-color: var(--good); }
.tag.verdict.inherited, .tag.inherited { color: #7aa5c9; border-color: #3d5a73; }

.block { display: flex; flex-direction: column; gap: 4px; }
.blk {
  color: var(--good); font-family: ui-monospace, monospace; font-size: 11px;
  display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap;
}
.blk.unsure { color: #b58900; }
.blk .why { color: var(--faint); font-style: italic; font-family: inherit; }
.said { margin: 0; color: var(--text-dim); line-height: 1.45; }
.mono { font-family: ui-monospace, monospace; font-size: 11px; color: var(--value); }
.list { margin: 0; padding-left: 16px; color: var(--text-dim); line-height: 1.5; }
.list.tests { padding-left: 4px; list-style: none; }
.list.tests li { display: flex; gap: 5px; align-items: baseline; }
.list.tests .m { flex: none; width: 10px; }
.list.tests li.good .m { color: var(--good); }
.list.tests li.warn { color: #b58900; }
.list.tests li.bad { color: var(--bad); }
.list.tests code { font-size: 11px; }
.list.hist { font-size: 11px; }
.list.hist .ts { color: var(--faint); font-family: ui-monospace, monospace; }
.list.hist .note { color: var(--muted); }

/* thumbnails */
.strip { display: flex; gap: 8px; flex-wrap: wrap; }
.thumb { margin: 0; width: 116px; }
.thumb img, .thumb .noimg {
  width: 116px; height: 87px; object-fit: contain; display: block; cursor: zoom-in;
  background: #0b0f14; border: 1px solid var(--border-2); border-radius: 6px;
}
.thumb.weak img { border-style: dashed; opacity: .82; }
.thumb .noimg { display: grid; place-items: center; color: var(--faint); font-size: 10px; cursor: default; }
.thumb figcaption {
  font-family: ui-monospace, monospace; font-size: 9.5px; color: var(--muted);
  display: flex; gap: 4px; align-items: center; margin-top: 3px; flex-wrap: wrap;
}
.thumb .gnd { margin: 2px 0 0; font-size: 9.5px; color: var(--faint); font-family: ui-monospace, monospace; }
.rid { color: var(--accent-2, #6aa); }

/* verdict */
.verdictbox { border-top: 1px solid var(--border); padding-top: 8px; }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.row button { font-size: 11px; padding: 4px 11px; border-radius: 7px; cursor: pointer; background: var(--panel-2); border: 1px solid var(--border-accent); color: var(--text-btn); }
.row button:disabled { opacity: .45; cursor: default; }
button.accept.on { color: #062; background: var(--good); border-color: var(--good); }
button.reject.on { color: #fff; background: var(--bad); border-color: var(--bad); }
button.edit.on { color: #062; background: #b58900; border-color: #b58900; }
button.primary { border-color: var(--accent); }
.was { color: var(--faint); font-size: 11px; }
.noterow input[type=text] { flex: 1; min-width: 0; }

.editform { display: flex; flex-direction: column; gap: 6px; padding-left: 10px; border-left: 2px solid var(--border-2); }
.f { display: flex; gap: 6px; align-items: center; }
.f > span:first-child { width: 108px; flex: none; color: var(--text-dim); font-size: 11px; }
.f.wide { align-items: flex-start; }
.f input[type=text], .f select, .f textarea, .noterow input[type=text] {
  background: var(--input-bg); border: 1px solid var(--border-2); border-radius: 7px; color: var(--text);
  padding: 5px 8px; font-size: 11px; font-family: ui-monospace, monospace;
}
.f input[type=text], .f select, .f textarea { flex: 1; min-width: 0; }
.f textarea { resize: vertical; }
.vec { display: flex; gap: 4px; flex: 1; }
.vec input { width: 0; flex: 1; background: var(--input-bg); border: 1px solid var(--border-2); border-radius: 6px; color: var(--text); padding: 5px 6px; font-size: 11px; font-family: ui-monospace, monospace; }
.hint { color: var(--faint); font-size: 11px; margin: 0; line-height: 1.4; }
.hint code { color: var(--value); }

.peers { display: flex; flex-direction: column; gap: 4px; padding-left: 10px; border-left: 2px solid var(--border-2); }
.peers.off { opacity: .55; }
.peer { display: flex; gap: 6px; align-items: center; }
.peer.locked { opacity: .6; }
.basis {
  font-size: 9px; font-family: ui-monospace, monospace; border-radius: 6px; padding: 0 5px;
  border: 1px solid; flex: none;
}
.basis.mirror { color: var(--good); border-color: var(--good); }
.basis.family { color: #7aa5c9; border-color: #3d5a73; }
.pid { color: var(--text-dim); flex: none; }
.gloss { color: var(--faint); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

.result { margin: 0; font-size: 11px; color: var(--good); line-height: 1.45; }
.result.bad { color: #b58900; }

/* rounds browser */
.rounds { display: flex; flex-direction: column; gap: 6px; }
.round { display: flex; flex-direction: column; gap: 6px; }
.rrow { display: flex; gap: 6px; align-items: stretch; }
.rrow .rhead { flex: 1; }
.tourbtn {
  flex: none; cursor: pointer; font-family: ui-monospace, monospace; font-size: 10px;
  background: none; border: 1px solid #3d5a73; border-radius: 7px; color: #7aa5c9; padding: 0 9px;
}
.tourbtn.on { color: #062; background: var(--good); border-color: var(--good); }
.rhead {
  display: flex; gap: 6px; align-items: center; flex-wrap: wrap; cursor: pointer;
  background: none; border: 1px solid var(--border-2); border-radius: 7px;
  color: var(--text-dim); font-size: 11px; padding: 5px 9px; font-family: ui-monospace, monospace;
}
.rhead:hover { border-color: var(--border-accent); background: var(--surface-3); }

/* lightbox */
.lightbox {
  position: fixed; inset: 0; z-index: 50; background: rgba(4, 7, 10, .93);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  cursor: zoom-out; padding: 20px;
}
.lightbox img { max-width: 96vw; max-height: 88vh; object-fit: contain; border: 1px solid var(--border-2); border-radius: 6px; }
.lightbox .cap { color: var(--muted); font-family: ui-monospace, monospace; font-size: 11px; }
</style>

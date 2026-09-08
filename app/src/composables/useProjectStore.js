// Central reactive store — a module-level singleton (matching the existing
// client/composables/use*.js convention; no Pinia). Holds project state, the
// active joint, its resolved slot graph, knob values, controller readouts, the
// live event log, and the chat transcript. Also owns the events WebSocket that
// streams kernel bus events into the UI.
import { reactive, computed } from 'vue';
import { useKernelApi } from './useKernelApi.js';

const state = reactive({
  connected: false,       // events WS connected
  loaded: false,          // a project (GLB) is discovered
  busy: false,            // a generate/validate is in flight
  discovering: false,     // an AI discovery op (load/refine/vision) is in flight
  phase: null,            // active discovery sub-job: 'views' | 'decompose' | 'axis'
  tourRound: null,        // observation round whose camera path the 3D view replays
  visionActive: false,    // a chained vision campaign is narrating itself live
  visionFeed: [],         // the campaign's live beats, in order, for the 3D theater
  refining: false,        // a parallel two-producer refinement is in flight
  expectation: null,      // the vision lane's category prior (a guess, never a joint)
  gaps: null,             // expected-vs-grounded per type, from the latest refinement
  verdictFlash: null,     // { id, decision, peers:[ids], ts } — draw the amortization links
  sweepReq: null,         // { id, ts } — ask the 3D view to fan-sweep this joint
  error: null,
  glb: null,
  stats: null,
  joints: [],
  activeJointId: null,
  slotGraph: null,        // resolved { knobs, overlays } for the active joint
  knobValues: {},         // command axis -> value (speed, turn, pitch, yaw, angle)
  readouts: {},           // derived source -> value (speed, angle, lastValidate)
  gimbal: { pitch: 0, yaw: 0 },
  validation: null,
  viewer: { glb: null, ctl: null },
  events: [],             // recent kernel events (activity log)
  transcript: [],         // chat (resumable)
  agent: { mode: 'stub' },
});

const activeJoint = computed(() => state.joints.find((j) => j.id === state.activeJointId) || null);

function setActiveJoint(id) {
  state.activeJointId = id;
  const j = state.joints.find((x) => x.id === id);
  // Reset knob values to this joint's command-axis defaults (data-driven).
  const kv = {};
  if (j) for (const c of (j.commands || [])) kv[c.name] = c.default ?? 0;
  state.knobValues = kv;
}

function setKnob(axis, value) { state.knobValues[axis] = value; }

function pushEvent(e) {
  state.events.unshift(e);
  if (state.events.length > 200) state.events.pop();
}

// Plain-language notices ride the CHAT transcript as `system` lines. There is no
// status chip anywhere in the shell: if something is worth telling the human, it
// is worth saying in words, in the place they already read answers.
// Consecutive repeats are collapsed so a reconnect storm cannot spam the log.
function notify(text) {
  const t = String(text || '').trim();
  if (!t) return;
  const last = state.transcript[state.transcript.length - 1];
  if (last?.role === 'system' && last.text === t) return;
  state.transcript.push({ role: 'system', text: t, ts: Date.now() });
}

// The chained vision campaign narrates itself over the same socket. The 3D view
// consumes `visionFeed` to animate the look-around as it happens; `discovering`
// re-locks the whole UI for the campaign's duration so a human cannot steer (or
// click, or orbit) mid-look — and unlocks the instant it ends or is skipped.
function pushVision(msg) {
  state.visionFeed.push(msg);
  if (state.visionFeed.length > 400) state.visionFeed.splice(0, state.visionFeed.length - 400);
}

// The producers merge records SERVER-side; the list the human reads is the
// server's, so re-read it instead of trusting what this tab had when the load
// happened. A merge the list never shows is indistinguishable from a merge that
// never happened — which is exactly the bug this call exists to prevent.
function refreshJoints() {
  useKernelApi().joints()
    .then((d) => { if (d?.ok) state.joints = d.joints || []; })
    .catch(() => { /* the next load will refresh it */ });
}

// Offer the POST-HOC replay of where the vision lane looked: the live theater is
// gone by now, but the round's camera path and exact frames are on disk.
function offerTour() {
  const lastRound = [...state.visionFeed].reverse().find((m) => m.kind === 'vision:round')?.round;
  if (lastRound != null) state.tourRound = lastRound;
}

let eventsSocket = null;
function connectEvents() {
  if (eventsSocket) return eventsSocket;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/events`);
  eventsSocket = ws;
  ws.onopen = () => { state.connected = true; };
  ws.onclose = () => { state.connected = false; eventsSocket = null; setTimeout(connectEvents, 1500); };
  ws.onerror = () => { state.connected = false; };
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.kind === 'event') {
      pushEvent({ type: msg.type, ts: msg.ts, data: msg.data });
      // Surface validation results into the store as they stream by.
      if (msg.type === 'validate:done') state.readouts.lastValidate = msg.data.pass ? 'PASS' : 'FAIL';
    } else if (msg.kind === 'round') {
      pushEvent({ type: 'generate:round', ts: Date.now(), data: { round: msg.round, pass: msg.pass } });
    } else if (typeof msg.kind === 'string' && msg.kind.startsWith('vision:')) {
      if (msg.kind === 'vision:start') {
        // Inside a parallel refinement the orchestrator has already reset the feed
        // and locked the UI; this beat only says the vision lane itself began.
        if (!state.refining) { state.visionFeed = []; state.discovering = true; }
        state.visionActive = true;
        pushEvent({ type: 'vision:start', ts: Date.now(), data: { auto: !!msg.auto, independent: !!msg.independent } });
        if (!state.refining) notify('vision refinement started — the 3D view narrates it live and the controls stay locked until it settles');
      } else if (msg.kind === 'vision:end' || msg.kind === 'vision:skip') {
        // A skip inside a parallel refinement is ONE lane explaining why it could
        // not look; the other lane is still running, so the UI stays locked until
        // the orchestrator says both have settled.
        if (!state.refining) { state.visionActive = false; state.discovering = false; }
        pushEvent({ type: msg.kind, ts: Date.now(), data: { ok: !!msg.ok, code: msg.code || null, reason: msg.reason || msg.error || null } });
        if (msg.kind === 'vision:skip') {
          notify(`the vision lane was skipped: ${msg.error || msg.code || 'unavailable'}`);
        } else if (msg.ok) {
          notify(`vision refinement finished — the physics battery accepted ${msg.added ?? 0} new joint(s)`);
          refreshJoints();
          offerTour();
        } else {
          notify(`vision refinement failed: ${msg.reason || msg.code || 'unknown error'}`);
        }
      } else if (msg.kind === 'vision:expect') {
        // The category prior, narrated as the assistant's own hypothesis — with
        // the boundary stated in the same breath, because a guess that reads like
        // a finding is worse than no guess at all.
        state.expectation = {
          category: msg.category || null, confidence: msg.confidence ?? null,
          summary: msg.summary || null, usable: !!msg.usable,
          instances: msg.instances || [], doubts: msg.doubts || [],
          alternatives: msg.alternatives || [], ts: Date.now(),
        };
        state.gaps = msg.gaps || [];
        const want = (msg.instances || [])
          .map((i) => `${i.count} ${i.type}${Number(i.count) === 1 ? '' : 's'}`).join(', ');
        const miss = (msg.gaps || []).filter((gp) => (gp.missing || 0) > 0);
        const para = [];
        para.push(msg.usable
          ? `Before going part by part, one look at the whole machine: this appears to be ${msg.category || 'something I cannot name yet'}${msg.summary ? ` — ${msg.summary}` : ''}.`
          : `I could not settle what kind of machine this is${msg.category ? ` (my best guess was ${msg.category})` : ''}, so I will look at it part by part and expect nothing.`);
        if (want) {
          para.push(`A machine of that category would have ${want}. That is a GUESS about a category, not a joint: I will verify each one against the frames, and anything I cannot ground I report rather than assume.`);
        }
        if (miss.length) {
          para.push(`Against that expectation I am still missing ${miss.map((gp) => `${gp.missing} of ${gp.expected} ${gp.type}`).join(', ')} — that is where I will aim the close-ups.`);
        }
        if ((msg.alternatives || []).length) para.push(`Other categories it could be: ${msg.alternatives.join('; ')}.`);
        if ((msg.doubts || []).length) para.push(`What I am unsure about: ${msg.doubts.join(' ')}`);
        let etext = para.join('\n\n');
        if (msg.prompt) etext += `\n\nI asked:\n\n${msg.prompt}`;
        if (msg.reply) etext += `\n\nThe model answered:\n\n${msg.reply}`;
        state.transcript.push({ role: 'assistant', text: etext, ts: Date.now() });
      } else if (msg.kind === 'vision:frame' && msg.url) {
        // The campaign's artifacts ride the CHAT as the assistant's self-talk:
        // each rendered frame as an attachment, then the exact prompt and the
        // exact reply. The 3D view keeps only geometry (path, glyph, marks).
        state.transcript.push({
          role: 'assistant',
          text: `I rendered view ${msg.viewId || msg.id} (${msg.mode}) and looked at it.`,
          attachments: [{ id: msg.id, url: msg.url }],
          ts: Date.now(),
        });
      } else if (msg.kind === 'vision:ask' && msg.prompt) {
        state.transcript.push({
          role: 'assistant',
          text: `I asked the vision model with ${msg.frames} frame(s):\n\n${msg.prompt}`,
          ts: Date.now(),
        });
      } else if (msg.kind === 'vision:reply' && msg.reply) {
        state.transcript.push({
          role: 'assistant',
          text: `The vision model answered:\n\n${msg.reply}`,
          ts: Date.now(),
        });
      }
      pushVision(msg);
    } else if (typeof msg.kind === 'string' && msg.kind.startsWith('text:')) {
      // The SEMANTIC lane narrates itself exactly the way the vision lane does:
      // the prompt it sent and the answer it got, verbatim, as self-talk. Two
      // producers that both work but only one of which can be read is one
      // producer too many to trust.
      if (msg.kind === 'text:start') {
        pushEvent({ type: 'text:start', ts: Date.now(), data: {} });
      } else if (msg.kind === 'text:ask' && msg.prompt) {
        state.transcript.push({
          role: 'assistant',
          text: `I asked the semantic model about the node hierarchy (${msg.frontier ?? 0} doubtful record(s)):\n\n${msg.prompt}`,
          ts: Date.now(),
        });
      } else if (msg.kind === 'text:reply' && msg.reply) {
        state.transcript.push({
          role: 'assistant',
          text: `The semantic model answered:\n\n${msg.reply}`,
          ts: Date.now(),
        });
      } else if (msg.kind === 'text:end') {
        pushEvent({ type: 'text:end', ts: Date.now(), data: { ok: !!msg.ok, added: msg.added ?? 0, reason: msg.reason || null } });
      } else if (msg.kind === 'text:skip') {
        pushEvent({ type: 'text:skip', ts: Date.now(), data: { code: msg.code || null } });
        notify(`the semantic lane was skipped: ${msg.error || msg.code || 'unavailable'}`);
      }
    } else if (typeof msg.kind === 'string' && (msg.kind.startsWith('refine:') || msg.kind === 'lane:merged')) {
      // The ORCHESTRATOR beats. One refinement = two lanes = one lock, one
      // notification and one revision, so the UI reads it as one event with two
      // contributions rather than as two competing jobs.
      if (msg.kind === 'refine:start') {
        state.refining = true; state.discovering = true; state.visionFeed = [];
        state.expectation = null; state.gaps = null;
        state.visionActive = msg.lanes?.vision !== false;
        pushEvent({ type: 'refine:start', ts: Date.now(), data: { lanes: msg.lanes || null } });
        notify(msg.lanes?.text !== false && msg.lanes?.vision !== false
          ? 'two independent producers are looking at the mesh now — one reads the node hierarchy, one renders frames and looks at them; neither is shown the other\'s conclusions, and the controls stay locked until both settle'
          : `refinement started with ${msg.lanes?.vision === false ? 'the semantic lane only' : 'the vision lane only'}`);
      } else if (msg.kind === 'lane:merged') {
        pushEvent({
          type: 'lane:merged', ts: Date.now(),
          data: { lane: msg.lane, added: msg.added ?? 0, merged: msg.merged ?? 0, corroborated: msg.corroborated ?? 0 },
        });
      } else if (msg.kind === 'refine:skip') {
        state.refining = false; state.discovering = false; state.visionActive = false;
        // A skipped refinement leaves no prior at all; keeping the previous mesh's
        // guess on screen would attribute one machine's category to another.
        state.expectation = null; state.gaps = null;
        pushEvent({ type: 'refine:skip', ts: Date.now(), data: { code: msg.code || null } });
        notify(`refinement skipped: ${msg.error || msg.code || 'unavailable'}`);
      } else if (msg.kind === 'refine:end') {
        state.refining = false; state.discovering = false; state.visionActive = false;
        const t = msg.text || {}; const v = msg.vision || {};
        if (msg.gaps) state.gaps = msg.gaps;
        pushEvent({
          type: 'refine:end', ts: Date.now(),
          data: { ok: !!msg.ok, added: msg.added ?? 0, agreed: msg.agreed ?? 0, text: t, vision: v },
        });
        if (msg.ok) {
          const parts = [`the semantic lane added ${t.added ?? 0}`, `the vision lane added ${v.added ?? 0}`];
          if (msg.agreed) {
            parts.push(`and both producers independently found the same ${msg.agreed} part(s) — recorded as corroboration of one joint, never as a duplicate`);
          }
          if (msg.category) parts.unshift(`I read the machine as ${msg.category}`);
          notify(`refinement finished — ${parts.join(', ')}`);
          refreshJoints();
          offerTour();
        } else {
          const why = [msg.code, t.code, v.code].filter(Boolean).join(', ');
          notify(`refinement added nothing${why ? ` (${why})` : ''}${msg.reason ? `: ${msg.reason}` : ''}`);
          refreshJoints();
        }
      }
    } else if (msg.kind === 'hello') {
      pushEvent({ type: 'server:hello', ts: Date.now(), data: { runDir: msg.runDir } });
    }
  };
  return ws;
}

export function useProjectStore() {
  return { state, activeJoint, setActiveJoint, setKnob, pushEvent, notify, connectEvents };
}

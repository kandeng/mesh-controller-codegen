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
  statusLine: null,       // live "DSH is asking <model> … please wait" line, null when idle
  model: 'qwen3.8-max',   // configured text model (named on refine:start)
  visionModel: 'qwen3.8-max', // model image turns route to (may equal `model`)
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

// The live status line is NOT a transcript entry: it is a single reactive string
// the chat renders at the very end while a remote model call is in flight, and
// clears the moment the work settles. It says WHICH model DSH is waiting on and
// WHAT it asked for, so a long pause reads as progress rather than as a hang.
function setStatus(text) { state.statusLine = text ? String(text) : null; }

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
        setStatus(`DSH is rendering views of the mesh so ${state.visionModel} can look at them. Please wait …`);
        if (!state.refining) notify('vision refinement started — the 3D view narrates it live and the controls stay locked until it settles');
      } else if (msg.kind === 'vision:end' || msg.kind === 'vision:skip') {
        // A skip inside a parallel refinement is ONE lane explaining why it could
        // not look; the other lane is still running, so the UI stays locked until
        // the orchestrator says both have settled.
        if (!state.refining) { state.visionActive = false; state.discovering = false; setStatus(null); }
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
        // The category answer is in; the discovery turn goes out right after this.
        setStatus(`DSH is asking ${state.visionModel} to detect the joints in the rendered frames. Please wait …`);
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
        setStatus(`DSH rendered view ${msg.viewId || msg.id} and is looking at the frames. Please wait …`);
        // The campaign's artifacts ride the CHAT as the assistant's self-talk:
        // each rendered frame as an attachment, then the exact prompt and the
        // exact reply. The 3D view keeps only geometry (path, glyph, marks).
        // The annotation states WHERE the virtual camera was — position, view
        // angle, range and FOV — because "I looked at it" carries no information
        // a human can check against the picture.
        const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '?');
        const eye = Array.isArray(msg.eye) ? msg.eye : null;
        const tgt = Array.isArray(msg.target) ? msg.target : null;
        const dist = Number.isFinite(msg.distance) ? msg.distance
          : (eye && tgt ? Math.hypot(eye[0] - tgt[0], eye[1] - tgt[1], eye[2] - tgt[2]) : null);
        // View angle in the SAME spherical convention the planner poses with
        // (views.mjs poseFromSpec): the camera's azimuth/elevation about the
        // target, so az 0/el 0 is an eye-level look and el 90 is straight down.
        let az = Number.isFinite(msg.azimuth) ? msg.azimuth : null;
        let el = Number.isFinite(msg.elevation) ? msg.elevation : null;
        if ((az == null || el == null) && eye && tgt) {
          const px = eye[0] - tgt[0]; const py = eye[1] - tgt[1]; const pz = eye[2] - tgt[2];
          if (az == null) az = Math.atan2(py, px) * 180 / Math.PI;
          if (el == null) el = Math.atan2(pz, Math.hypot(px, py)) * 180 / Math.PI;
        }
        const rig = [];
        rig.push(eye ? `camera at (${eye.map(f2).join(', ')})` : 'camera pose unknown');
        if (az != null && el != null) rig.push(`view angle az ${az.toFixed(0)}° / el ${el.toFixed(0)}°`);
        if (dist != null) rig.push(`${f2(dist)} u from the target`);
        if (Number.isFinite(msg.fov)) rig.push(`FOV ${msg.fov}°`);
        state.transcript.push({
          role: 'assistant',
          text: `I rendered view ${msg.viewId || msg.id} (${msg.mode}): ${rig.join(' · ')}.`,
          attachments: [{ id: msg.id, url: msg.url }],
          ts: Date.now(),
        });
      } else if (msg.kind === 'vision:ask' && msg.prompt) {
        setStatus(`DSH is asking ${state.visionModel} to detect the joints from ${msg.frames} rendered frame(s). Please wait …`);
        state.transcript.push({
          role: 'assistant',
          text: `I asked the vision model with ${msg.frames} frame(s):\n\n${msg.prompt}`,
          ts: Date.now(),
        });
      } else if (msg.kind === 'vision:reply' && msg.reply) {
        setStatus(`DSH got ${state.visionModel}'s answer and is grounding each named part on the mesh. Please wait …`);
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
        setStatus(`DSH is reading the node hierarchy to find the joints it can name without looking. Please wait …`);
        pushEvent({ type: 'text:start', ts: Date.now(), data: {} });
      } else if (msg.kind === 'text:ask' && msg.prompt) {
        setStatus(`DSH is asking ${state.model} to name the joints from the node hierarchy. Please wait …`);
        state.transcript.push({
          role: 'assistant',
          text: `I asked the semantic model about the node hierarchy (${msg.frontier ?? 0} doubtful record(s)):\n\n${msg.prompt}`,
          ts: Date.now(),
        });
      } else if (msg.kind === 'text:reply' && msg.reply) {
        setStatus(`DSH got ${state.model}'s answer and is checking each named joint against the mesh. Please wait …`);
        state.transcript.push({
          role: 'assistant',
          text: `The semantic model answered:\n\n${msg.reply}`,
          ts: Date.now(),
        });
      } else if (msg.kind === 'text:end') {
        if (!state.refining) setStatus(null);
        pushEvent({ type: 'text:end', ts: Date.now(), data: { ok: !!msg.ok, added: msg.added ?? 0, reason: msg.reason || null } });
      } else if (msg.kind === 'text:skip') {
        if (!state.refining) setStatus(null);
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
        if (msg.model) state.model = msg.model;
        if (msg.visionModel) state.visionModel = msg.visionModel;
        pushEvent({ type: 'refine:start', ts: Date.now(), data: { lanes: msg.lanes || null } });
        setStatus(msg.lanes?.text !== false && msg.lanes?.vision !== false
          ? `DSH is asking the remote ${state.model} AI model to detect the joints — one producer reads the node hierarchy while another looks at rendered frames. Please wait …`
          : `DSH is asking the remote ${msg.lanes?.vision === false ? state.model : state.visionModel} AI model to detect the joints. Please wait …`);
        notify(msg.lanes?.text !== false && msg.lanes?.vision !== false
          ? 'two independent producers are looking at the mesh now — one reads the node hierarchy, one renders frames and looks at them; neither is shown the other\'s conclusions, and the controls stay locked until both settle'
          : `refinement started with ${msg.lanes?.vision === false ? 'the semantic lane only' : 'the vision lane only'}`);
      } else if (msg.kind === 'lane:merged') {
        pushEvent({
          type: 'lane:merged', ts: Date.now(),
          data: { lane: msg.lane, added: msg.added ?? 0, merged: msg.merged ?? 0, corroborated: msg.corroborated ?? 0 },
        });
      } else if (msg.kind === 'refine:note') {
        // A human note reached the loop's queue. The sending tab already showed the
        // user's bubble; this acknowledges it landed and keeps the status line honest
        // about what the next ask will carry.
        pushEvent({ type: 'refine:note', ts: Date.now(), data: { text: msg.text, queued: msg.queued ?? 0 } });
        setStatus('DSH queued your note and will fold it into the next model ask. Please wait …');
      } else if (msg.kind === 'refine:abort') {
        pushEvent({ type: 'refine:abort', ts: Date.now(), data: { queued: msg.queued ?? 0 } });
        setStatus('DSH is stopping the refinement at the next safe boundary — nothing half-written will be merged. Please wait …');
      } else if (msg.kind === 'refine:skip') {
        state.refining = false; state.discovering = false; state.visionActive = false;
        // A skipped refinement leaves no prior at all; keeping the previous mesh's
        // guess on screen would attribute one machine's category to another.
        state.expectation = null; state.gaps = null;
        setStatus(null);
        pushEvent({ type: 'refine:skip', ts: Date.now(), data: { code: msg.code || null } });
        notify(`refinement skipped: ${msg.error || msg.code || 'unavailable'}`);
      } else if (msg.kind === 'refine:end') {
        state.refining = false; state.discovering = false; state.visionActive = false;
        setStatus(null);
        const t = msg.text || {}; const v = msg.vision || {};
        if (msg.gaps) state.gaps = msg.gaps;
        pushEvent({
          type: 'refine:end', ts: Date.now(),
          data: { ok: !!msg.ok, added: msg.added ?? 0, agreed: msg.agreed ?? 0, text: t, vision: v },
        });
        if (msg.stopped) {
          notify('you stopped the refinement — nothing it had found was merged; load or refine again to restart it');
        } else if (msg.ok) {
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

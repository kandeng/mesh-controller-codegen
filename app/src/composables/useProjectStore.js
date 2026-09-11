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
  discovering: false,     // the 3D view/knobs are locked: a CAMERA is being driven
                          // (stage 1 of discovery, or a manual vision round). Stage 2
                          // measures joints and captures nothing, so it drops there.
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

// The inspection guidance the assistant says when the human picks a joint from the
// list. It is said ONCE per conversation: the whole transcript is scanned, not just
// its last entry, so clicking joint after joint — with questions and screenshots in
// between — never stacks the same paragraph into the chat a second time.
const JOINT_GUIDANCE = 'Verify this joint\'s scope: it must contain every part that belongs to it, and none that doesn\'t. Then drive its motion with the step 3 controls to confirm it moves as expected and nothing is broken. If something needs pointing out, mark the 3D view with the pens (arrow, rectangle, curve, text, any colour) and send a screenshot — the marks make your request clearer.';
function sayJointGuidance() {
  if (state.transcript.some((e) => e.text === JOINT_GUIDANCE)) return;
  state.transcript.push({ role: 'assistant', text: JOINT_GUIDANCE, ts: Date.now() });
}

// The live status line is NOT a transcript entry: it is a single reactive string
// the chat renders at the very end while a remote model call is in flight, and
// clears the moment the work settles. It says WHICH model DSH is waiting on and
// WHAT it asked for, so a long pause reads as progress rather than as a hang.
function setStatus(text) { state.statusLine = text ? String(text) : null; }

// The chained vision campaign narrates itself over the same socket. The 3D view
// consumes `visionFeed` to animate the look-around as it happens; `discovering`
// locks orbit/picks/knobs for as long as a CAMERA is being driven, so a human cannot
// fight the render farm mid-look — and unlocks the instant that ends or is skipped.
// It is deliberately NOT the whole-discovery lock: staged discovery keeps running
// (per-joint checks) after the camera is done, and that part is safe to look at.
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
        pushEvent({ type: msg.kind, ts: Date.now(), data: { ok: !!msg.ok, code: msg.code || null, reason: msg.reason || msg.error || null, look: msg.look ?? 1 } });
        if (msg.kind === 'vision:skip') {
          // A skip of the STEERED second look is a different sentence: the run is
          // not degraded, the instruction simply could not be folded in, and the
          // list from the first look still stands.
          notify(msg.look === 2
            ? `your instruction could not be folded in — the second look was skipped (${msg.error || msg.code || 'unavailable'}). The candidate list from the first look stands, and DSH will keep checking those joints.`
            : `the vision lane was skipped: ${msg.error || msg.code || 'unavailable'}`);
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
      } else if (msg.kind === 'vision:note' && (msg.notes || []).length) {
        // The human's own words, folded into the prompt at the ask boundary. Shown
        // verbatim and BEFORE the ask that carries them, so the chat reads in the
        // order the model received it: what you said, then what was sent. A note
        // the model never saw would be the worst kind of lie to tell here.
        setStatus(`DSH folded your note into the vision prompt. Please wait …`);
        state.transcript.push({
          role: 'assistant',
          text: `I folded what you said into the look I am about to make:\n\n${msg.notes.map((n) => `- ${n}`).join('\n')}`
            + (msg.references
              ? `\n\nand attached the ${msg.references} image(s) you sent with it as REFERENCE pictures. The model is told they are not frames we rendered, so it cannot cite them as evidence — only read them as guidance. A proposal still has to point at a frame we drew, because that is the only kind we can project back into the geometry.`
              : ''),
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
    } else if (typeof msg.kind === 'string' && (msg.kind.startsWith('refine:') || msg.kind.startsWith('discover:') || msg.kind === 'lane:merged' || msg.kind === 'joint:refined')) {
      // The ORCHESTRATOR beats. Discovery is STAGED now, so these read as one job
      // with two acts: `discover:candidates` is stage 1 landing the rough list,
      // `discover:stage` is the hand-over to stage 2 (and the moment the 3D view
      // unlocks, because stage 2 captures nothing), and `joint:refined` is one row
      // becoming clickable. Between every one of those beats the orchestrator
      // yields to the assistant queue, so a message sent mid-job is answered before
      // the next one arrives.
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
          ? 'Two independent producers are looking at the mesh now — one extracts the embedded glTF JSON to read the internal node hierarchy, the other renders frames and looks at them. They will agree on a CANDIDATE list first, which appears in step (2) dimmed; each candidate is then checked one at a time, and the chat is served between them.\n\nThe whole process takes a few minutes — please wait patiently; I will report here as each step lands.'
          : `refinement started with ${msg.lanes?.vision === false ? 'the semantic lane only' : 'the vision lane only'}`);
      } else if (msg.kind === 'discover:look') {
        // The steered second look starting. `discovering` is still true, so the
        // camera lock is still held — this look renders frames, and a human
        // orbiting the model mid-capture would corrupt them.
        setStatus(`DSH is taking a SECOND look with your instruction folded in (${msg.notes ?? 0} message(s)${msg.images ? `, ${msg.images} image(s)` : ''}). Please wait …`);
        pushEvent({ type: 'discover:look', ts: Date.now(), data: { look: msg.look ?? 2, notes: msg.notes ?? 0, images: msg.images ?? 0 } });
        notify(`you spoke while the first look was running — so DSH is looking again with your instruction${msg.images ? ' and your screenshot' : ''} folded into the prompt, BEFORE any joint is measured. Whatever it finds is added to the candidate list; nothing already listed is thrown away.`);
      } else if (msg.kind === 'discover:candidates') {
        // Stage 1 landed (or the plan was reshaped by a served request: a drop or a
        // postpone arrives on the same beat, because both change the candidate list).
        pushEvent({
          type: 'discover:candidates', ts: Date.now(),
          data: {
            count: msg.count ?? 0, added: msg.added ?? 0, agreed: msg.agreed ?? 0,
            dropped: msg.dropped || null, postponed: msg.postponed || null,
            remaining: msg.remaining ?? null,
            look: msg.look ?? 1, steered: !!msg.steered,
          },
        });
        refreshJoints();
        if (msg.look === 2 && msg.steered) {
          // The SECOND look landing. Same beat as stage 1 (it is the same thing —
          // a candidate list settling), but the wording has to say whose idea it
          // was, or a human who typed an instruction cannot tell whether it did
          // anything at all.
          if (msg.gaps) state.gaps = msg.gaps;
          const parts = [`${msg.count} candidate joint(s) in step (2)`];
          parts.push(msg.added ? `the second look added ${msg.added}` : 'the second look added nothing new');
          if (msg.agreed) parts.push(`and independently re-found ${msg.agreed} part(s) already listed — corroboration of one joint, never a duplicate`);
          notify(`your instruction was folded in — ${parts.join(', ')}.`);
        } else if (msg.dropped) {
          notify(`dropped ${msg.dropped} from the plan — ${msg.remaining ?? 0} candidate(s) left to check`);
        } else if (msg.postponed) {
          notify(`postponed ${msg.postponed} to the end of the plan`);
        } else if (msg.count) {
          if (msg.gaps) state.gaps = msg.gaps;
          const parts = [`${msg.count} candidate joint(s) listed in step (2)`];
          if (msg.added) parts.push(`the vision lane added ${msg.added}`);
          if (msg.agreed) parts.push(`and both producers independently found the same ${msg.agreed} part(s) — recorded as corroboration of one joint, never as a duplicate`);
          if (msg.category) parts.unshift(`I read the machine as ${msg.category}`);
          notify(`stage 1 settled — ${parts.join(', ')}. Candidates are not clickable yet: each one is checked in turn, and I will answer your messages between them.`);
        }
      } else if (msg.kind === 'discover:stage') {
        // Hand-over to stage 2. `discovering` drops HERE rather than at refine:end:
        // stage 2 measures joints one at a time and captures no frames, so there is
        // no camera to collide with — the human can orbit, pick a settled joint and
        // drive its knobs while the rest of the list is still being checked.
        // `refining` stays true, which is what keeps the composer queueing and the
        // Stop button pointed at the orchestrator.
        if (msg.stage === 2) {
          state.discovering = false;
          state.visionActive = false;
          const left = state.joints.filter((j) => j.status === 'candidate').length;
          setStatus(left ? `DSH is checking the candidate joints one at a time — ${left} left. Your messages are answered between them. Please wait …` : null);
        }
        pushEvent({ type: 'discover:stage', ts: Date.now(), data: { stage: msg.stage ?? null } });
      } else if (msg.kind === 'joint:refined') {
        // ONE row just became clickable. Re-read the list rather than patch it
        // locally: the server is the only writer, and a patch would drift from the
        // evidence and test results the row's tooltip is about to be asked for.
        pushEvent({
          type: 'joint:refined', ts: Date.now(),
          data: { id: msg.id, status: msg.status || null, confidence: msg.confidence ?? null, remaining: msg.remaining ?? 0 },
        });
        refreshJoints();
        setStatus(msg.remaining
          ? `DSH checked ${msg.id} (${msg.status || 'settled'}) — ${msg.remaining} candidate(s) left. Please wait …`
          : null);
      } else if (msg.kind === 'lane:merged') {
        pushEvent({
          type: 'lane:merged', ts: Date.now(),
          data: { lane: msg.lane, added: msg.added ?? 0, merged: msg.merged ?? 0, corroborated: msg.corroborated ?? 0 },
        });
      } else if (msg.kind === 'refine:abort') {
        pushEvent({ type: 'refine:abort', ts: Date.now(), data: { queued: msg.queued ?? 0 } });
        // A stop now cancels the look in flight as well, so the wait is the
        // unwinding (the cancelled turn rejects, the orchestrator lands on its
        // boundary and reports), not the rest of a model call nobody wants.
        setStatus('DSH is stopping discovery — the model call in flight is being cancelled; the joints already checked stay, the rest remain candidates. Please wait …');
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
          data: {
            ok: !!msg.ok, added: msg.added ?? 0, agreed: msg.agreed ?? 0, text: t, vision: v,
            staged: !!msg.staged, candidates: msg.candidates ?? null, remaining: msg.remaining ?? 0,
          },
        });
        if (msg.stopped) {
          // Incremental honesty: stopping is NOT a rollback any more. Every joint
          // refined before the boundary stays committed, so the list says exactly
          // what was checked and what is still a candidate.
          notify(msg.remaining
            ? `you stopped discovery at a boundary — ${msg.added ?? 0} joint(s) were checked and stay, ${msg.remaining} remain candidates; refine again to finish them`
            : 'you stopped discovery before stage 1 settled — nothing was merged; load or refine again to restart it');
        } else if (msg.ok) {
          const parts = msg.staged
            ? [`${msg.candidates ?? 0} candidate(s) found`, `${msg.added ?? 0} checked`]
            : [`the semantic lane added ${t.added ?? 0}`, `the vision lane added ${v.added ?? 0}`];
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
  return { state, activeJoint, setActiveJoint, setKnob, pushEvent, notify, sayJointGuidance, connectEvents };
}

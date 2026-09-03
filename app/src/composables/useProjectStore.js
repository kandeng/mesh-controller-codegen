// Central reactive store — a module-level singleton (matching the existing
// client/composables/use*.js convention; no Pinia). Holds project state, the
// active joint, its resolved slot graph, knob values, controller readouts, the
// live event log, and the chat transcript. Also owns the events WebSocket that
// streams kernel bus events into the UI.
import { reactive, computed } from 'vue';

const state = reactive({
  connected: false,       // events WS connected
  loaded: false,          // a project (GLB) is discovered
  busy: false,            // a generate/validate is in flight
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
    } else if (msg.kind === 'hello') {
      pushEvent({ type: 'server:hello', ts: Date.now(), data: { runDir: msg.runDir } });
    }
  };
  return ws;
}

export function useProjectStore() {
  return { state, activeJoint, setActiveJoint, setKnob, pushEvent, connectEvents };
}

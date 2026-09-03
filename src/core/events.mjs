// Event Bus — the backbone that decouples the async actors (DSH bridge,
// kinematic bridges streaming transform frames, validators, persistence,
// diagnostics). Thin wrapper over node:events with a typed name table and an
// onAny() tap so diagnostics can trace every event without wildcard support.
import { EventEmitter } from 'node:events';

export const EVT = Object.freeze({
  BOOT: 'core:boot',
  SHUTDOWN: 'core:shutdown',
  ASSET_REGISTERED: 'asset:registered',
  JOINT_DISCOVERED: 'joint:discovered',
  JOINT_PROPOSED: 'joint:proposed',
  JOINT_ACCEPTED: 'joint:accepted',
  GENERATE_START: 'generate:start',
  GENERATE_DONE: 'generate:done',
  VALIDATE_START: 'validate:start',
  VALIDATE_DONE: 'validate:done',
  TRANSFORM_FRAME: 'bridge:transformFrame',
  KNOB_CHANGED: 'ui:knobChanged',
  PICK_SELECTED: 'ui:pickSelected',
  DIAG: 'diag',
  ERROR: 'error',
});

export function createEventBus() {
  const ee = new EventEmitter();
  ee.setMaxListeners(0);
  const any = [];

  const dispatch = (type, payload) => {
    // type/ts are set LAST so a payload field can never clobber the canonical
    // event name (e.g. a joint's {type:'rotor'} must not become the event type).
    const evt = { ...payload, type, ts: Date.now() };
    for (const fn of any) {
      try { fn(evt); } catch { /* a tracer must never break the pipeline */ }
    }
    ee.emit(type, evt);
    return evt;
  };

  return {
    emit: (type, payload = {}) => dispatch(type, payload),
    on: (type, fn) => { ee.on(type, fn); return () => ee.off(type, fn); },
    once: (type, fn) => { ee.once(type, fn); return () => ee.off(type, fn); },
    off: (type, fn) => ee.off(type, fn),
    // Tap every event (used by diagnostics). Returns an unsubscribe fn.
    onAny: (fn) => { any.push(fn); return () => { const i = any.indexOf(fn); if (i >= 0) any.splice(i, 1); }; },
    listenerCount: (type) => ee.listenerCount(type),
  };
}

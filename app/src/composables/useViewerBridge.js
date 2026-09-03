// Viewer bridge — the boundary between the reactive store and the imperative
// three.js controller. MeshViewer registers the controller here; the bridge
// watches store.knobValues and applies them via the controller's command methods,
// and polls getState() to publish readouts (per-prop rpm, gimbal angle) back.
//
// Control mapping mirrors the proven viewer.html contract:
//   speed -> setSpeed(v) | turn -> turnLeft/goStraight/turnRight
//   pitch+yaw -> setGimbal(pitch, yaw) | angle -> setAngle(v) (optional)
import { watch } from 'vue';
import { useProjectStore } from './useProjectStore.js';

let ctl = null;
let stopWatch = null;
let readoutTimer = null;
let lastTurn = null;

export function useViewerBridge() {
  const { state } = useProjectStore();

  function apply() {
    if (!ctl) return;
    const v = state.knobValues;
    try {
      if ('speed' in v) ctl.setSpeed?.(Number(v.speed));
      if ('turn' in v) {
        const t = Math.sign(Number(v.turn));
        if (t !== lastTurn) {           // only fire on change (methods are discrete)
          if (t < 0) ctl.turnLeft?.(); else if (t > 0) ctl.turnRight?.(); else ctl.goStraight?.();
          lastTurn = t;
        }
      }
      if ('pitch' in v || 'yaw' in v) ctl.setGimbal?.(Number(v.pitch ?? 0), Number(v.yaw ?? 0));
      if ('angle' in v) ctl.setAngle?.(Number(v.angle));
    } catch (e) {
      state.error = `controller apply failed: ${e.message}`;
    }
  }

  function publishReadouts() {
    if (!ctl?.getState) return;
    try {
      const s = ctl.getState();
      state.props = s.props || [];
      if (s.gimbal) state.gimbal = { pitch: s.gimbal.pitch ?? 0, yaw: s.gimbal.yaw ?? 0 };
      state.readouts.speed = s.speed;
      state.readouts.headingDeg = s.headingDeg;
    } catch (e) {
      state.error = `controller getState failed: ${e.message}`;
    }
  }

  function setController(c) {
    ctl = c;
    lastTurn = null;
    if (stopWatch) { stopWatch(); stopWatch = null; }
    if (readoutTimer) { clearInterval(readoutTimer); readoutTimer = null; }
    if (c) {
      stopWatch = watch(() => state.knobValues, apply, { deep: true });
      apply();
      readoutTimer = setInterval(publishReadouts, 200);
    } else {
      state.props = [];
    }
  }

  return { setController, apply, publishReadouts, get controller() { return ctl; } };
}

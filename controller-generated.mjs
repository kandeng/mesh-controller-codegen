// controller.mjs — DJI Inspire 3 drone animation controller
// ES module, pure definitions only (no side effects at import time)

// ── Propeller groups ─────────────────────────────────────────────────────────
// Each group lists every visual node that must rotate for that rotor.
// In this Sketchfab export, hub parts and blade are siblings under the arm.
// Diagonal pairs: FL+BR spin CW (+1), FR+BL spin CCW (−1) for yaw control.

const PROP_GROUPS = [
  {
    key: 'FL',
    spin: +1,
    // Front-left prop under ARM_MAIN_L → node 5 → node 6
    // Hub parts + blade (57_5_2, xy=197.58×33.36)
    names: ['55_2_0', '56_2_1', '57_5_2', '60_2_3']
  },
  {
    key: 'BL',
    spin: -1,
    // Back-left prop under ARM_MAIN_L → node 15
    // Hub/spinner parts under node 17 + motor/blade under node 33
    // Blade: 57_6_18 (xy=204.06×64.06)
    names: [
      '2_2_7', '39_2_8', '3_2_9', '5_1_10', '5_2_11', '7_3_12', '7_4_13',
      '38_2_16', '52_1_2_17', '57_6_18', '61_2_19'
    ]
  },
  {
    key: 'FR',
    spin: -1,
    // Front-right prop under ARM_MAIN_R → node 270 → node 271
    // Hub parts + blade (57_142, xy=197.58×33.36)
    names: ['55_140', '56_141', '57_142', '60_143']
  },
  {
    key: 'BR',
    spin: +1,
    // Back-right prop under ARM_MAIN_R → node 280
    // Hub/spinner parts under node 282 + motor/blade under node 298
    // Blade: 57_2_158 (xy=204.06×64.06)
    names: [
      '2_147', '3_148', '39_149', '5_150', '6_151', '7_152', '7_2_153',
      '38_156', '52_1_157', '57_2_158', '61_159'
    ]
  }
];

// ── Gimbal & Camera ─────────────────────────────────────────────────────────
// gimbal_319 (node 559): gimbal mechanism, 25 children
// DL_mount_293 (node 537): camera payload with lenses — SIBLING of gimbal
// Both are direct children of in3_A_0227_obj_386 (node 3)

const GIMBAL_NAMES = ['gimbal_319'];
const CAMERA_NAMES = ['DL_mount_293'];

// ── Body root ────────────────────────────────────────────────────────────────
const BODY_ROOT_NAME = 'in3_A_0227_obj_386';

// ── Constants ────────────────────────────────────────────────────────────────
const HOVER_RPM = 2400;
const RPM_PER_MPS = 200;
const BASE_RAD_PER_SEC = (HOVER_RPM * 2 * Math.PI) / 60;
const RAD_PER_SEC_PER_MPS = (RPM_PER_MPS * 2 * Math.PI) / 60;
const TURN_RATE_RAD = 1.2;          // rad/s yaw rate when turning
const YAW_DIFF_RAD_PER_SEC = 80;    // prop speed differential at full yaw rate
const SMOOTH_TAU = 0.18;            // exp smoothing time constant (seconds)
const GIMBAL_PITCH_LIMIT = 45;      // degrees
const GIMBAL_YAW_LIMIT = 90;        // degrees
const DEG = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

// ── Helpers ──────────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function expSmooth(current, target, dt, tau) {
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}

// ── Main export ──────────────────────────────────────────────────────────────
export function createDroneController(root, THREE) {
  // Resolve named nodes from the scene graph
  const warned = new Set();
  function find(name) {
    let found = null;
    root.traverse(function (node) {
      if (!found && node.name === name) {
        found = node;
      }
    });
    if (!found && !warned.has(name)) {
      warned.add(name);
      console.warn('[drone-controller] missing node: ' + name);
    }
    return found;
  }

  // Resolve all prop nodes
  const propGroups = PROP_GROUPS.map(g => ({
    key: g.key,
    spin: g.spin,
    nodes: g.names.map(n => find(n)).filter(Boolean),
    names: g.names,
    rpm: 0
  }));

  // Resolve gimbal + camera nodes
  const gimbalNodes = GIMBAL_NAMES.map(n => find(n)).filter(Boolean);
  const cameraNodes = CAMERA_NAMES.map(n => find(n)).filter(Boolean);
  const bodyRoot = find(BODY_ROOT_NAME);

  // State
  let targetSpeed = 0;
  let currentSpeed = 0;
  let targetYawRate = 0;  // rad/s, positive = right turn
  let currentYawRate = 0;
  let headingRad = 0;
  let targetGimbalPitch = 0; // radians
  let targetGimbalYaw = 0;   // radians
  let currentGimbalPitch = 0;
  let currentGimbalYaw = 0;

  // ── Public API ───────────────────────────────────────────────────────────

  function update(dtSeconds) {
    if (dtSeconds <= 0) return;

    // Smooth speed and yaw rate
    currentSpeed = expSmooth(currentSpeed, targetSpeed, dtSeconds, SMOOTH_TAU);
    currentYawRate = expSmooth(currentYawRate, targetYawRate, dtSeconds, SMOOTH_TAU);
    currentGimbalPitch = expSmooth(currentGimbalPitch, targetGimbalPitch, dtSeconds, SMOOTH_TAU);
    currentGimbalYaw = expSmooth(currentGimbalYaw, targetGimbalYaw, dtSeconds, SMOOTH_TAU);

    // Update heading from yaw rate
    headingRad += currentYawRate * dtSeconds;

    // Apply body yaw (turn the whole drone)
    if (bodyRoot) {
      bodyRoot.rotation.y = headingRad;
    }

    // Compute normalized yaw command (-1 to +1)
    // +1 = full right turn, -1 = full left turn
    const yawNorm = currentYawRate / TURN_RATE_RAD;

    // Compute yaw-induced prop speed differential (rad/s)
    // At full yaw: CW props get +80 rad/s, CCW props get -80 rad/s (or vice versa)
    // This creates torque imbalance → body yaws in the commanded direction
    const yawDiff = yawNorm * YAW_DIFF_RAD_PER_SEC;

    // Compute prop spin rate based on speed + yaw differential
    for (const pg of propGroups) {
      // Base spin rate (radians/sec) scales with forward speed
      let spinRate = BASE_RAD_PER_SEC + currentSpeed * RAD_PER_SEC_PER_MPS;

      // Apply yaw differential:
      // For LEFT turn (yawNorm < 0):
      //   CW props (spin +1): spinRate -= (negative) = spinRate INCREASES
      //   CCW props (spin -1): spinRate += (negative) = spinRate DECREASES
      //   → Net CCW torque on body → body yaws left ✓
      // For RIGHT turn (yawNorm > 0):
      //   CW props (spin +1): spinRate -= (positive) = spinRate DECREASES
      //   CCW props (spin -1): spinRate += (positive) = spinRate INCREASES
      //   → Net CW torque on body → body yaws right ✓
      if (pg.spin > 0) {
        spinRate -= yawDiff;
      } else {
        spinRate += yawDiff;
      }

      // Ensure spin stays positive (props always spin, just at different rates)
      spinRate = Math.max(spinRate, BASE_RAD_PER_SEC * 0.3);

      // Compute RPM for state reporting
      pg.rpm = (spinRate * 60) / (2 * Math.PI);

      // Rotate each node in this prop group around Y axis
      const delta = spinRate * pg.spin * dtSeconds;
      for (const node of pg.nodes) {
        node.rotation.y += delta;
      }
    }

    // Apply gimbal rotation (pitch on X, yaw on Y)
    // Both gimbal joint and camera payload get the same rotation
    const allGimbalTargets = [...gimbalNodes, ...cameraNodes];
    for (const node of allGimbalTargets) {
      node.rotation.x = currentGimbalPitch;
      node.rotation.y = currentGimbalYaw;
    }
  }

  function setSpeed(metersPerSecond) {
    targetSpeed = Math.max(0, metersPerSecond);
  }

  function turnLeft() {
    targetYawRate = -TURN_RATE_RAD;
  }

  function turnRight() {
    targetYawRate = TURN_RATE_RAD;
  }

  function goStraight() {
    targetYawRate = 0;
  }

  function setGimbal(pitchDeg, yawDeg) {
    targetGimbalPitch = clamp(pitchDeg, -GIMBAL_PITCH_LIMIT, GIMBAL_PITCH_LIMIT) * DEG;
    targetGimbalYaw = clamp(yawDeg, -GIMBAL_YAW_LIMIT, GIMBAL_YAW_LIMIT) * DEG;
  }

  function getState() {
    return {
      speed: currentSpeed,
      headingDeg: headingRad * RAD_TO_DEG,
      props: propGroups.map(pg => ({ name: pg.key, rpm: pg.rpm })),
      gimbal: {
        pitch: currentGimbalPitch * RAD_TO_DEG,
        yaw: currentGimbalYaw * RAD_TO_DEG
      }
    };
  }

  function describe() {
    return {
      propGroups: PROP_GROUPS.map(g => ({
        key: g.key,
        spin: g.spin,
        names: [...g.names]
      })),
      gimbalNames: [...GIMBAL_NAMES],
      cameraNames: [...CAMERA_NAMES],
      bodyRootName: BODY_ROOT_NAME
    };
  }

  return { update, setSpeed, turnLeft, turnRight, goStraight, setGimbal, getState, describe };
}

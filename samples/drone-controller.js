// props: 55_1_3_41, 55_1_4_42, 55_1_181, 55_1_2_182 (+ spinners 56_*, locks 57_*/60_*, blades 63_*/64_*) | gimbal: gimbal_319 + camera DL_mount_293

export function createDroneController(gltfSceneRoot, THREE) {
  // Propeller assembly per corner: motor hub + spinner + lock parts + the two
  // blade nodes. The blades are SIBLINGS of the hubs in this Sketchfab export,
  // so every part must be rotated explicitly or the blades stay still.
  // spin: +1 = clockwise seen from above, -1 = counter-clockwise.
  // Diagonal pairs share a spin direction, as on a real quadcopter.
  var PROP_GROUPS = [
    { key: 'rightFront', side: 'right', spin:  1, names: ['55_1_3_41', '56_1_3_43', '57_1_3_45', '60_1_3_56', '63_3_104', '64_3_106'] },
    { key: 'rightRear',  side: 'right', spin: -1, names: ['55_1_4_42', '56_1_4_44', '57_1_4_46', '60_1_4_57', '63_4_105', '64_4_107'] },
    { key: 'leftFront',  side: 'left',  spin: -1, names: ['55_1_181',  '56_1_183',  '57_1_185',  '60_1_196',  '63_244',   '64_246']    },
    { key: 'leftRear',   side: 'left',  spin:  1, names: ['55_1_2_182', '56_1_2_184', '57_1_2_186', '60_1_2_197', '63_2_245', '64_2_247']  }
  ];
  var GIMBAL_NAMES = ['gimbal_319', 'DL_mount_293']; // joints + camera payload (siblings under the body root)

  // ---- helpers --------------------------------------------------------------
  var warned = {};
  function warn(msg) { if (!warned[msg]) { console.warn(msg); warned[msg] = true; } }

  function findNode(root, name) {
    var result = null;
    root.traverse(function (child) {
      if (!result && child.name === name) result = child;
    });
    if (!result) warn('[drone-controller] missing node: ' + name);
    return result;
  }

  // Resolve prop groups
  var groups = [];
  for (var i = 0; i < PROP_GROUPS.length; i++) {
    var g = PROP_GROUPS[i];
    var nodes = [];
    for (var j = 0; j < g.names.length; j++) {
      var n = findNode(gltfSceneRoot, g.names[j]);
      if (n) nodes.push(n);
    }
    if (nodes.length > 0) {
      groups.push({ key: g.key, side: g.side, spin: g.spin, nodes: nodes, angle: 0, rpm: 0 });
    }
  }

  // Resolve gimbal joints + camera payload; both rotate together so the camera
  // never separates from its joints.
  var gimbalNodes = [];
  for (var gi = 0; gi < GIMBAL_NAMES.length; gi++) {
    var gn = findNode(gltfSceneRoot, GIMBAL_NAMES[gi]);
    if (gn) gimbalNodes.push(gn);
  }

  // Find a suitable drone root to yaw.
  // Walk up from the first prop node to the common ancestor that sits just
  // below the scene root.  Rotating this node turns the whole drone.
  var droneRoot = null;
  if (groups.length > 0) {
    var nd = groups[0].nodes[0];
    while (nd.parent && nd.parent !== gltfSceneRoot && nd.parent.parent) {
      nd = nd.parent;
    }
    droneRoot = nd;
  }

  // ---- state ----------------------------------------------------------------
  var DEG2RAD = Math.PI / 180;

  var speed         = 0;
  var targetSpeed   = 0;
  var heading       = 0;
  var yawRate       = 0;
  var targetYawRate = 0;
  var gimbalPitch   = 0;
  var gimbalYaw     = 0;
  var targetPitch   = 0;
  var targetYaw     = 0;

  // Tuning constants
  var HOVER_RPM     = 1200;
  var CRUISE_RPM    = 3000;
  var MAX_SPEED     = 15;
  var TURN_RATE     = 90;
  var SPEED_EASE    = 2.5;
  var YAW_EASE      = 4.0;
  var GIMBAL_EASE   = 6.0;

  function easeToward(current, target, rate, dt) {
    return current + (target - current) * (1 - Math.exp(-rate * dt));
  }

  // ---- update ---------------------------------------------------------------
  function update(dt) {
    if (dt <= 0 || !isFinite(dt)) return;

    speed   = easeToward(speed, targetSpeed, SPEED_EASE, dt);
    yawRate = easeToward(yawRate, targetYawRate, YAW_EASE, dt);

    heading += yawRate * dt;
    heading = ((heading + 180) % 360 + 360) % 360 - 180;

    if (droneRoot) {
      droneRoot.rotation.y = heading * DEG2RAD;
    }

    var t = Math.min(Math.abs(speed) / MAX_SPEED, 1);
    // speed 0 = motors OFF: rotors wind down to a complete stop, not hover.
    var baseRPM = Math.abs(speed) < 0.02 ? 0 : HOVER_RPM + (CRUISE_RPM - HOVER_RPM) * t;
    var turnFactor = TURN_RATE !== 0 ? yawRate / TURN_RATE : 0;

    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      // Yaw torque on a quad comes from the CW vs CCW pair differential, not
      // left vs right (that would roll). To yaw left (turnFactor < 0), the CW
      // pair spins up so its reaction torque rotates the body CCW; mirror for
      // a right yaw.
      var rpm = baseRPM * (1 - g.spin * turnFactor * 0.35);
      if (rpm < 0) rpm = 0;
      g.rpm = rpm;

      var degPerSec = rpm * 6;  // 360 / 60
      g.angle = (g.angle + degPerSec * dt) % 360;

      var rotRad = g.angle * g.spin * DEG2RAD;

      for (var j = 0; j < g.nodes.length; j++) {
        g.nodes[j].rotation.y = rotRad;
      }
    }

    gimbalPitch = easeToward(gimbalPitch, targetPitch, GIMBAL_EASE, dt);
    gimbalYaw   = easeToward(gimbalYaw,   targetYaw,   GIMBAL_EASE, dt);

    for (var k = 0; k < gimbalNodes.length; k++) {
      gimbalNodes[k].rotation.x = gimbalPitch * DEG2RAD;
      gimbalNodes[k].rotation.y = gimbalYaw   * DEG2RAD;
    }
  }

  // ---- public API -----------------------------------------------------------
  function setSpeed(metersPerSecond) {
    targetSpeed = Math.max(0, metersPerSecond);
  }

  function turnLeft()  { targetYawRate = -TURN_RATE; }
  function turnRight() { targetYawRate =  TURN_RATE; }
  function goStraight(){ targetYawRate =  0; }

  function setGimbal(pitchDeg, yawDeg) {
    targetPitch = Math.max(-90,  Math.min(30,  pitchDeg));
    targetYaw   = Math.max(-120, Math.min(120, yawDeg));
  }

  function getState() {
    var propsArr = [];
    for (var i = 0; i < groups.length; i++) {
      propsArr.push({ name: groups[i].key, rpm: groups[i].rpm });
    }
    return {
      speed: speed,
      headingDeg: heading,
      props: propsArr,
      gimbal: { pitch: gimbalPitch, yaw: gimbalYaw }
    };
  }

  // Contract manifest: lets the headless validator (tier1) assert exactly which
  // nodes must move, without re-discovering the rig itself.
  function describe() {
    return {
      propGroups: PROP_GROUPS.map(function (g) { return { key: g.key, spin: g.spin, names: g.names }; }),
      gimbalNames: ['gimbal_319'],
      cameraNames: ['DL_mount_293'],
      bodyRootName: droneRoot ? droneRoot.name : null
    };
  }

  return {
    update: update,
    setSpeed: setSpeed,
    turnLeft: turnLeft,
    turnRight: turnRight,
    goStraight: goStraight,
    setGimbal: setGimbal,
    getState: getState,
    describe: describe
  };
}

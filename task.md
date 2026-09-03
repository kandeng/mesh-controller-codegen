Write a JavaScript ES module that animates a DJI Inspire 3 drone GLB in three.js.

Files you can read:
- The GLB itself (728 nodes, 345 meshes, Sketchfab export, 0 animations): /home/robot/drone-navigation-v2/client/assets/mesh/drone_dji_inspire3.glb
- Pre-extracted node list, TSV with columns index / name / meshIndex / childCount: /home/robot/drone-navigation-v2/.dsh-lab/nodes.txt
- Truncated glTF JSON: /home/robot/drone-navigation-v2/.dsh-lab/gltf.json

Discover the animation targets yourself:
- 4 propeller/rotor nodes. They are NOT named prop/rotor/blade. Investigate the node hierarchy (children of arm roots like ARM_MAIN_L_139 / ARM_MAIN_R_279, leaf nodes at arm extremities, repeated name patterns). If names alone are not enough, write and run your own python3 script to parse the GLB (12-byte header, first chunk is JSON; node translations/rotations will tell you which nodes sit at the propeller positions — above the arm tips).
- The gimbal: node 'gimbal_319' exists; verify it and use it (or its child camera node if more appropriate).

Output file: /home/robot/drone-navigation-v2/.dsh-lab/drone-controller.js

The test harness imports exactly this contract — do not change these names:
  import { createDroneController } from './drone-controller.js'
  const ctl = createDroneController(gltfSceneRoot, THREE)
  // once per animation frame: ctl.update(dtSeconds)
  ctl.setSpeed(metersPerSecond)   // 0 = hover; actual speed eases toward target
  ctl.turnLeft() / ctl.turnRight() / ctl.goStraight()
  ctl.setGimbal(pitchDeg, yawDeg) // clamp pitch to [-90, 30], yaw to [-120, 120]
  ctl.getState()                  // returns { speed, headingDeg, props: [{name, rpm}], gimbal: {pitch, yaw} }

Behavior requirements:
1. All 4 propellers spin continuously around their own local axis, even at hover; spin rate scales with the current speed.
2. turnLeft(): left-side propellers slow down, right-side speed up, and the drone root yaws left continuously while active. turnRight() mirrors this. goStraight() equalizes all propellers and stops the yaw.
3. All motion uses dt-based integration (frame-rate independent). Speed and heading ease smoothly toward their targets.
4. Use ONLY the THREE namespace passed as the second argument. No import statements, no DOM access, no network, no timers, no globals.
5. Guard every node lookup: if a node is missing, console.warn once and skip it — never throw.
6. The very first line of the file must be a comment listing the exact node names you chose for the 4 propellers and the gimbal, e.g. // props: a, b, c, d | gimbal: g

Before finishing, verify the module parses by running:
  node --input-type=module -e "await import('/home/robot/drone-navigation-v2/.dsh-lab/drone-controller.js').then(() => console.log('SYNTAX OK'))"
Fix any error it reports.

In your final message, report: the chosen node names for props and gimbal, how you identified them, and the max hover/cruise RPM you used.
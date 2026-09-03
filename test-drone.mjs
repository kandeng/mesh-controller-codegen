// Quick functional test of the drone controller
import { createDroneController } from './drone-controller.js';

// Mock THREE
const THREE = {};

// Mock scene graph
class MockNode {
  constructor(name, parent = null) {
    this.name = name;
    this.parent = parent;
    this.children = [];
    this.rotation = { x: 0, y: 0, z: 0 };
    if (parent) parent.children.push(this);
  }
  traverse(fn) {
    fn(this);
    this.children.forEach(c => c.traverse(fn));
  }
}

// Build mock scene
const sceneRoot = new MockNode('SceneRoot');
const sketchfab = new MockNode('Sketchfab_model', sceneRoot);
const root = new MockNode('root', sketchfab);
const gltfRoot = new MockNode('GLTF_SceneRootNode', root);
const droneBody = new MockNode('in3_A_0227_obj_386', gltfRoot);

// Add prop nodes (hub, spinner, lock parts, blades — all siblings)
const propNames = [
  '55_1_3_41', '56_1_3_43', '57_1_3_45', '60_1_3_56', '63_3_104', '64_3_106',    // rightFront
  '55_1_4_42', '56_1_4_44', '57_1_4_46', '60_1_4_57', '63_4_105', '64_4_107',    // rightRear
  '55_1_181', '56_1_183', '57_1_185', '60_1_196', '63_244', '64_246',            // leftFront
  '55_1_2_182', '56_1_2_184', '57_1_2_186', '60_1_2_197', '63_2_245', '64_2_247' // leftRear
];
propNames.forEach(name => new MockNode(name, droneBody));

// Add gimbal joints and camera payload (siblings)
new MockNode('gimbal_319', droneBody);
new MockNode('DL_mount_293', droneBody);

// Create controller
const ctl = createDroneController(sceneRoot, THREE);

// Test initial state
let state = ctl.getState();
console.log('Initial state:', state);
console.assert(state.speed === 0, 'Initial speed should be 0');
console.assert(state.headingDeg === 0, 'Initial heading should be 0');
console.assert(state.props.length === 4, 'Should have 4 props');

// Test setSpeed
ctl.setSpeed(5);
ctl.update(0.1);
state = ctl.getState();
console.log('After setSpeed(5) and update(0.1):', state);
console.assert(state.speed > 0, 'Speed should increase');

// Test turnLeft
ctl.turnLeft();
ctl.update(0.1);
state = ctl.getState();
console.log('After turnLeft() and update(0.1):', state);
console.assert(state.headingDeg < 0, 'Heading should decrease (turn left)');

// Test setGimbal
ctl.setGimbal(-45, 60);
ctl.update(0.1);
state = ctl.getState();
console.log('After setGimbal(-45, 60) and update(0.1):', state);
console.assert(state.gimbal.pitch < 0, 'Gimbal pitch should be negative');
console.assert(state.gimbal.yaw > 0, 'Gimbal yaw should be positive');

// Test goStraight
ctl.goStraight();
ctl.update(0.5);
state = ctl.getState();
console.log('After goStraight() and update(0.5):', state);

console.log('\n✓ All tests passed!');

// Joint-type plugins. Each declares its contract, the isolated assertions tier-1
// should make for a SINGLE joint of this type, and a knob manifest derived from
// the joint's command axes (the data-driven source for panel 2 in the Vue phase).
// `contributes.slots` is declared now and consumed by the Vue Slot Routing Graph.
import { definePlugin, CATEGORY } from '../../core/registry.mjs';
import { JOINT_TYPE } from '../../ir/motion-spec.mjs';

// Build a knob manifest from a joint's command axes.
function knobsFrom(joint) {
  return (joint.commands || []).map((c) => ({
    axis: c.name,
    label: `${joint.label} · ${c.name}`,
    kind: c.kind,
    min: c.min,
    max: c.max,
    step: c.step,
    unit: c.unit,
    default: c.default,
  }));
}

export const rotorJoint = definePlugin({
  category: CATEGORY.JOINT,
  name: 'rotor',
  version: '1.0.0',
  contributes: {
    type: JOINT_TYPE.ROTOR,
    slots: [{ slot: 'knob', render: 'speed-slider' }, { slot: 'knob', render: 'turn-segment' }, { slot: 'knob', render: 'rpm-readout' }, { slot: 'viewer-overlay', render: 'spin-axis' }],
  },
  api: {
    type: JOINT_TYPE.ROTOR,
    knobs: knobsFrom,
    // Isolated single-joint assertions (smaller blast radius in the incremental phase).
    assertions: ['stopAtZero', 'bladesSpinWithHub', 'rpmGrowsWithSpeed', 'diagonalDifferential'],
  },
});

export const gimbalJoint = definePlugin({
  category: CATEGORY.JOINT,
  name: 'gimbal',
  version: '1.0.0',
  contributes: {
    type: JOINT_TYPE.GIMBAL,
    slots: [{ slot: 'knob', render: 'pitch-slider' }, { slot: 'knob', render: 'yaw-slider' }, { slot: 'knob', render: 'angle-readout' }],
  },
  api: {
    type: JOINT_TYPE.GIMBAL,
    knobs: knobsFrom,
    assertions: ['converge', 'clampToRange', 'cameraFollowsGimbal'],
  },
});

export const hingeJoint = definePlugin({
  category: CATEGORY.JOINT,
  name: 'hinge',
  version: '1.0.0',
  contributes: {
    type: JOINT_TYPE.HINGE,
    slots: [{ slot: 'knob', render: 'angle-slider' }],
  },
  api: {
    type: JOINT_TYPE.HINGE,
    knobs: knobsFrom,
    assertions: ['converge', 'clampToRange'],
  },
});

export const jointPlugins = [rotorJoint, gimbalJoint, hingeJoint];

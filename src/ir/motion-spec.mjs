// Motion-Spec IR — the language-neutral single source of truth.
// Discovery drafts it; the assistant edits it through conversation; emitters
// project it to JS / Python / C#; validators assert against it. Keeping one IR
// prevents cross-language drift.
//
// Shapes:
//   spec  = { version, mesh:{assetId,path}, conventions:{rotationOrder,radians}, joints:[joint] }
//   joint = { id, label, type, nodes:[name], anchor:{x,y,z}, axis:{x,y,z},
//             commands:[axis], params:{}, rules:{} }
//   axis(command) = { name, kind, min, max, step, unit, default, stopAt }

export const SPEC_VERSION = 1;

export const JOINT_TYPE = Object.freeze({
  ROTOR: 'rotor',           // continuous spin (propeller hub + blades)
  GIMBAL: 'gimbal',         // revolute, multi-axis (pitch + yaw), may carry a hard-linked camera
  HINGE: 'hinge',           // generic single-axis revolute
});

export const CONVENTIONS = Object.freeze({ rotationOrder: 'XYZ', radians: true });

// Set of valid joint-type VALUES ('rotor'|'gimbal'|'hinge').
const JOINT_TYPE_VALUES = new Set(Object.values(JOINT_TYPE));

// ---- command-axis templates -------------------------------------------------
export function speedAxis(over = {}) {
  return { name: 'speed', kind: 'scalar', min: 0, max: 10, step: 0.1, unit: 'normalized', default: 0, stopAt: 0, ...over };
}
export function turnAxis(over = {}) {
  // Spin DIRECTION toggle: -1 = counter-clockwise, +1 = clockwise (no neutral).
  return { name: 'turn', kind: 'scalar', min: -1, max: 1, step: 2, unit: 'direction', default: 1, stopAt: 0, ...over };
}
export function angleAxis(name, min, max, dflt, over = {}) {
  return { name, kind: 'angle', min, max, step: 0.5, unit: 'degrees', default: dflt, ...over };
}

// Per-type defaults: commands + params + rules. A unit may expose multiple axes.
export function jointDefaults(type) {
  switch (type) {
    case JOINT_TYPE.ROTOR:
      return {
        commands: [speedAxis(), turnAxis()],
        params: { hoverRpm: 2800, cruiseRpm: 5500, maxSpeed: 10, direction: 1, rpmSmoothing: 2.5, yawDifferential: 0.18 },
        rules: { stopAtZero: true, bladesSpinWithHub: true },
      };
    case JOINT_TYPE.GIMBAL:
      return {
        commands: [angleAxis('pitch', -90, 30, 0), angleAxis('yaw', -120, 120, 0)],
        params: { angleSmoothing: 6, cameraHardLinked: true },
        rules: { converge: true, clampToRange: true, cameraFollows: true },
      };
    case JOINT_TYPE.HINGE:
      return {
        commands: [angleAxis('angle', -180, 180, 0)],
        params: { angleSmoothing: 6 },
        rules: { converge: true, clampToRange: true },
      };
    default:
      return { commands: [], params: {}, rules: {} };
  }
}

// ---- constructors -----------------------------------------------------------
export function createMotionSpec({ assetId = null, path = null } = {}) {
  return { version: SPEC_VERSION, mesh: { assetId, path }, conventions: { ...CONVENTIONS }, joints: [] };
}

export function createJoint({ id, label, type, nodes = [], anchor = null, axis = null, over = {} } = {}) {
  if (!id) throw new Error('joint requires an id');
  if (!JOINT_TYPE_VALUES.has(type)) throw new Error(`unknown joint type: ${type}`);
  const d = jointDefaults(type);
  return {
    id,
    label: label || id,
    type,
    nodes,
    anchor,
    axis,
    commands: d.commands,
    params: { ...d.params },
    rules: { ...d.rules },
    status: 'candidate', // candidate | confirmed | generated | verified
    ...over,
  };
}

export function addJoint(spec, joint) { spec.joints.push(joint); return joint; }
export function findJoint(spec, id) { return spec.joints.find((j) => j.id === id) || null; }

// ---- validation -------------------------------------------------------------
export function validateSpec(spec) {
  const problems = [];
  if (!spec || spec.version !== SPEC_VERSION) problems.push(`spec.version must be ${SPEC_VERSION}`);
  if (!Array.isArray(spec?.joints)) problems.push('spec.joints must be an array');
  const ids = new Set();
  for (const j of spec?.joints || []) {
    if (!j.id) problems.push('joint missing id');
    if (ids.has(j.id)) problems.push(`duplicate joint id: ${j.id}`);
    ids.add(j.id);
    if (!JOINT_TYPE_VALUES.has(j.type)) problems.push(`joint ${j.id}: unknown type ${j.type}`);
    if (!Array.isArray(j.nodes) || j.nodes.length === 0) problems.push(`joint ${j.id}: empty node set`);
    for (const c of j.commands || []) {
      if (typeof c.name !== 'string') problems.push(`joint ${j.id}: command missing name`);
      if (c.min != null && c.max != null && c.min > c.max) problems.push(`joint ${j.id}.${c.name}: min>max`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export const serialize = (spec) => JSON.stringify(spec, null, 2);
export const parse = (text) => JSON.parse(text);

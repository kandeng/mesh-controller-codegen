// Slot Routing Graph — the 9th plugin primitive, deferred from the CLI phase and
// consumed here. It joins two declarations that already exist on each joint-type
// plugin (see src/plugins/joints/types.mjs):
//   - contributes.slots : WHICH renderers a joint type wants (render ids -> Vue components)
//   - api.knobs(joint)  : the DATA for each command axis (min/max/step/unit/default)
// The graph routes each declared slot to its bound command axis (or marks it a
// derived readout / viewer overlay), and fills in a default renderer for any
// command axis the plugin forgot to declare — so the UI is fully data-driven.
import { CATEGORY } from '../src/core/registry.mjs';

const READOUT_RE = /-readout$/;
const INPUT_RE = /-(slider|segment|buttons|toggle)$/;
const DEFAULT_RENDER_BY_KIND = { angle: 'angle-slider', scalar: 'value-slider' };

const stem = (render) => render.replace(INPUT_RE, '');
const readoutSource = (render) => render.replace(READOUT_RE, '');

function axisForRender(render, knobs) {
  const s = stem(render);
  return knobs.find((k) => k.axis === s) || null;
}

// Resolve the full slot graph for ONE joint.
export function resolveSlotGraph(kernel, joint) {
  const plugin = kernel.registry.get(CATEGORY.JOINT, joint.type);
  const knobs = plugin?.api?.knobs ? plugin.api.knobs(joint) : [];
  const slots = plugin?.contributes?.slots || [];

  const knobSlots = slots.filter((s) => s.slot === 'knob');
  const overlays = slots.filter((s) => s.slot !== 'knob').map((s) => ({ slot: s.slot, render: s.render }));

  const boundAxes = new Set();
  const resolved = [];

  for (const s of knobSlots) {
    if (READOUT_RE.test(s.render)) {
      const source = readoutSource(s.render);
      resolved.push({ slot: 'knob', render: s.render, bind: 'readout', source, label: `${joint.label} · ${source}` });
    } else {
      const axis = axisForRender(s.render, knobs);
      if (axis) boundAxes.add(axis.axis);
      resolved.push({ slot: 'knob', render: s.render, bind: 'command', axis: axis?.axis || null, ...(axis || {}) });
    }
  }

  // Data-driven completeness: any command axis with no declared slot gets a default.
  for (const k of knobs) {
    if (boundAxes.has(k.axis)) continue;
    resolved.push({ slot: 'knob', render: DEFAULT_RENDER_BY_KIND[k.kind] || 'value-slider', bind: 'command', ...k });
  }

  return { jointId: joint.id, type: joint.type, label: joint.label, knobs: resolved, overlays };
}

// The renderer registry contract the frontend implements: every render id that
// any joint-type plugin can emit. Kept here so backend + frontend stay in sync.
export const KNOWN_RENDERS = Object.freeze({
  'speed-slider': { component: 'SpeedSlider', bind: 'command', control: 'setSpeed' },
  'turn-toggle': { component: 'TurnToggle', bind: 'command', control: 'turn' },
  'pitch-slider': { component: 'PitchSlider', bind: 'command', control: 'gimbalPitch' },
  'yaw-slider': { component: 'YawSlider', bind: 'command', control: 'gimbalYaw' },
  'angle-slider': { component: 'AngleSlider', bind: 'command', control: 'angle' },
  'angle-readout': { component: 'AngleReadout', bind: 'readout' },
  'value-slider': { component: 'ValueSlider', bind: 'command', control: 'value' },
  'spin-axis': { component: 'SpinAxisOverlay', bind: 'overlay' },
});

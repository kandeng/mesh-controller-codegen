// Renderer registry — maps every render id the backend Slot Routing Graph can
// emit (see server/slots.mjs KNOWN_RENDERS) to a Vue component. The *-slider ids
// all route to the one data-driven KnobSlider; toggle/readouts are distinct.
import KnobSlider from './KnobSlider.vue';
import TurnToggle from './TurnToggle.vue';
import AngleReadout from './AngleReadout.vue';

export const KNOB_COMPONENTS = {
  'speed-slider': KnobSlider,
  'pitch-slider': KnobSlider,
  'yaw-slider': KnobSlider,
  'angle-slider': KnobSlider,
  'value-slider': KnobSlider,
  'turn-toggle': TurnToggle,
  'angle-readout': AngleReadout,
};

export function componentForRender(render) {
  return KNOB_COMPONENTS[render] || null;
}

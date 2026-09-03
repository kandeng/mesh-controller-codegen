// JS-target kinematic host. In the baseline, verifying a JS controller IS the
// headless three.js harness in tier1 (load controller -> tick scenarios ->
// capture per-node transforms -> assert the contract). The browser viewer is the
// live preview for JS (viewer.html imports the controller directly), so the JS
// target needs no transform streaming. Python/C# will stream transforms INTO the
// same tier1 assertions via their own bridges.
import { definePlugin, CATEGORY } from '../../core/registry.mjs';
import { tier1 } from '../../lib/tier1.mjs';

export const nodeKinematicBridge = definePlugin({
  category: CATEGORY.BRIDGE,
  name: 'kinematic-node',
  version: '1.0.0',
  contributes: { language: 'javascript', description: 'JS kinematic host: headless three.js harness (tier1) + live browser preview.' },
  api: {
    language: 'javascript',
    available: () => true, // node + three are always present in this repo
    validate: async ({ glb, file, THREE }) => tier1(glb, file, THREE),
  },
});

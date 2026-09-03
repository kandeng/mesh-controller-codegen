// Tier-1 validator plugin: the deterministic kinematic gate. Executes the REAL
// generated controller in a Node three.js scene graph and asserts the contract
// (idle stop, cruise spin, diagonal differential, gimbal follow, blade coverage,
// NaN scan, rotor-ring centroid). This is the heart of the visual-gate automation.
import { definePlugin, CATEGORY } from '../../core/registry.mjs';
import { tier1 } from '../../lib/tier1.mjs';

export const tier1Validator = definePlugin({
  category: CATEGORY.VALIDATOR,
  name: 'tier1',
  version: '1.0.0',
  contributes: { tier: 1, description: 'Kinematic: executes the real controller in a three.js scene graph.' },
  api: {
    tier: 1,
    // glb = parsed GLB (from discovery), THREE = imported three module.
    run: async ({ glb, file, THREE }) => tier1(glb, file, THREE),
  },
});

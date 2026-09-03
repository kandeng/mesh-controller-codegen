// Plugin bootstrap — registers every plugin into the host registry at boot.
// Adding a new joint type / language / validator / discovery strategy = add a
// module here (or drop it in and import); no core edits. That's the whole point
// of the "everything is plugin" internal modularity.
import { geometryDiscovery } from './discovery/geometry.mjs';
import { jointPlugins } from './joints/types.mjs';
import { tier0Validator } from './validators/tier0.mjs';
import { tier1Validator } from './validators/tier1.mjs';
import { jsEmitter } from './emitters/javascript.mjs';
import { emitterStubs } from './emitters/stubs.mjs';
import { dshBridge } from '../bridges/dsh-bridge.mjs';
import { nodeKinematicBridge } from '../bridges/kinematic/node-bridge.mjs';
import { kinematicStubs } from '../bridges/kinematic/stubs.mjs';

export const ALL_PLUGINS = [
  geometryDiscovery,
  ...jointPlugins,
  tier0Validator,
  tier1Validator,
  jsEmitter,
  ...emitterStubs,
  dshBridge,
  nodeKinematicBridge,
  ...kinematicStubs,
];

export async function registerAllPlugins(host) {
  for (const p of ALL_PLUGINS) await host.bootPlugin(p);
  return host.registry.summary();
}

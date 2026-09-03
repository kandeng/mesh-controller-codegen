// Python / C# kinematic bridge STUBS. Registered as real plugin slots so the
// architecture is exercised, but they throw a clear NotImplemented until built.
// Future: each runs the REAL generated controller in its own runtime headlessly,
// ticking update(dt) over the scripted scenarios and streaming per-node rotations
// (stdout/WebSocket) to the backend -> the SAME tier1 assertions + browser viewer.
// `available()` detects whether the runtime is installed so the tool only offers
// targets the user can actually verify.
import { spawnSync } from 'node:child_process';
import { definePlugin, CATEGORY } from '../../core/registry.mjs';

function has(cmd, arg) {
  try { return spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

function stubBridge(name, language, detect) {
  return definePlugin({
    category: CATEGORY.BRIDGE,
    name,
    version: '0.0.0-stub',
    contributes: {
      language,
      description: `${language} kinematic host (STUB): will run the real generated ${language} controller headlessly and stream per-node transforms into the tier1 assertions + viewer.`,
    },
    api: {
      language,
      available: detect,
      async validate() {
        const err = new Error(
          `${language} kinematic bridge is not implemented in the CLI baseline (registered stub). ` +
          `The JavaScript target is fully working; ${language} verification arrives in a later phase.`,
        );
        err.code = 'ENOTIMPLEMENTED';
        throw err;
      },
    },
  });
}

export const pythonKinematicBridge = stubBridge('kinematic-python', 'python', () => has('python3', '--version'));
export const dotnetKinematicBridge = stubBridge('kinematic-dotnet', 'csharp', () => has('dotnet', '--version'));
export const kinematicStubs = [pythonKinematicBridge, dotnetKinematicBridge];

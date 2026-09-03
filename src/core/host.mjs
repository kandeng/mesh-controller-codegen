// Host assembler — builds the kernel and wires graceful shutdown so spawned
// children (DSH agent, kinematic bridges) and temp dirs are always reclaimed.
import { loadConfig, REPO_ROOT } from '../config.mjs';
import { createEventBus } from './events.mjs';
import { createRegistry } from './registry.mjs';
import { bootPlugin } from './registry.mjs';
import {
  createLifecycle, createResources, createAssets, createContext, createDiagnostics,
} from './services.mjs';

export function createHost({ configPath, runDir, projectDir = null, verbose = false } = {}) {
  const config = loadConfig(configPath);
  const log = (...a) => console.log('[mcc]', ...a);
  const bus = createEventBus();
  const resources = createResources((...a) => (verbose ? console.log(...a) : undefined));
  const diagnostics = createDiagnostics({ bus, runDir, verbose });

  const host = {
    repoRoot: REPO_ROOT,
    config,
    log,
    verbose,
    bus,
    registry: createRegistry(bus),
    lifecycle: createLifecycle(bus),
    resources,
    assets: createAssets(bus, (...a) => (verbose ? console.log(...a) : undefined)),
    context: createContext({ projectDir, runDir }),
    diagnostics,
    bootPlugin: (plugin) => bootPlugin(plugin, host),
  };

  let disposed = false;
  const shutdown = async (signal) => {
    if (disposed) return;
    disposed = true;
    bus.emit('core:shutdown', { signal });
    try { await host.context.persist(); } catch { /* best effort */ }
    await resources.disposeAll();
    diagnostics.close();
  };
  host.shutdown = shutdown;
  process.once('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(130)));
  process.once('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(143)));

  return host;
}

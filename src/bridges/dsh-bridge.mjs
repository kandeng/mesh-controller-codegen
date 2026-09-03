// DSH bridge — the invisible agent boundary. For the CLI baseline this is the
// proven one-shot headless spawn; in the Vue app phase it becomes a persistent
// JSON-RPC session (same plugin slot, swapped implementation). The child is
// registered with the resource GC so a hung agent can never leak again.
import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { definePlugin, CATEGORY } from '../core/registry.mjs';
import { EVT } from '../core/events.mjs';

export const dshBridge = definePlugin({
  category: CATEGORY.BRIDGE,
  name: 'dsh',
  version: '1.0.0',
  contributes: { description: 'DSH headless agent bridge (one-shot in CLI; persistent JSON-RPC session in the app phase).' },
  api: {
    // Run a generation task. Writes task.md + dsh.log into runDir. Returns exit code.
    async run({ host, task, runDir, model }) {
      const { config, resources, bus, diagnostics } = host;
      const activeModel = model || config.model;

      writeFileSync(resolve(runDir, 'task.md'), task);
      const logFile = resolve(runDir, 'dsh.log');

      let modelPatch = null;
      if (activeModel && activeModel !== 'qwen3.7-max') {
        modelPatch = resolve(runDir, 'model.patch.yml');
        writeFileSync(modelPatch, `- id: agent-default-model\n  config:\n    provider: bailian\n    model: ${activeModel}\n`);
      }

      bus.emit(EVT.GENERATE_START, { model: activeModel, bridge: 'dsh' });
      const code = await new Promise((res) => {
        const fd = openSync(logFile, 'w');
        const child = spawn(config.paths.dshBin, [
          '--profile', 'headless',
          '--patch', config.paths.bailianPatch,
          ...(modelPatch ? ['--patch', modelPatch] : []),
          task,
        ], { cwd: runDir, env: { ...process.env, BAILIAN_API_KEY: config.apiKey } });

        resources.trackChild(child, 'dsh');
        child.stdout.on('data', (d) => writeSync(fd, d));
        child.stderr.on('data', (d) => writeSync(fd, d));
        const killer = setTimeout(() => child.kill('SIGTERM'), config.dshTimeoutMs);
        child.on('close', (c) => { clearTimeout(killer); closeSync(fd); res(c); });
      });

      bus.emit(EVT.GENERATE_DONE, { exit: code, model: activeModel, log: logFile });
      diagnostics.note('dsh run complete', { exit: code, model: activeModel });
      return code;
    },
  },
});

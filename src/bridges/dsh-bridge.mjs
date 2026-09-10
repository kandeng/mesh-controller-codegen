// DSH bridge — the invisible agent boundary. For the CLI baseline this is the
// proven one-shot headless spawn; in the Vue app phase it becomes a persistent
// JSON-RPC session (same plugin slot, swapped implementation). The child is
// registered with the resource GC so a hung agent can never leak again.
import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { definePlugin, CATEGORY } from '../core/registry.mjs';
import { EVT } from '../core/events.mjs';

// The generation child, remembered while it runs. Generation is the one job that
// does NOT ride the supervisor's turn chain — it is a separate headless `dsh`
// process — so cancelling a model turn cannot reach it and a user Stop would
// otherwise have to wait out the timeout killer. `reason` distinguishes a human
// abort from the timeout so the failure the pipeline reports says which it was.
let active = null; // { child, reason: null | 'user' | 'timeout' }

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
      if (activeModel && activeModel !== 'qwen3.8-max') {
        modelPatch = resolve(runDir, 'model.patch.yml');
        writeFileSync(modelPatch, `- id: agent-default-model\n  config:\n    provider: bailian\n    model: ${activeModel}\n`);
      }

      bus.emit(EVT.GENERATE_START, { model: activeModel, bridge: 'dsh' });
      const done = await new Promise((res) => {
        const fd = openSync(logFile, 'w');
        const child = spawn(config.paths.dshBin, [
          '--profile', 'headless',
          '--patch', config.paths.bailianPatch,
          ...(modelPatch ? ['--patch', modelPatch] : []),
          task,
        ], { cwd: runDir, env: { ...process.env, BAILIAN_API_KEY: config.apiKey } });

        const run = { child, reason: null };
        active = run;
        resources.trackChild(child, 'dsh');
        child.stdout.on('data', (d) => writeSync(fd, d));
        child.stderr.on('data', (d) => writeSync(fd, d));
        const killer = setTimeout(() => { run.reason = 'timeout'; child.kill('SIGTERM'); }, config.dshTimeoutMs);
        child.on('close', (c) => {
          clearTimeout(killer);
          closeSync(fd);
          if (active === run) active = null;
          res({ code: c, reason: run.reason });
        });
      });

      bus.emit(EVT.GENERATE_DONE, { exit: done.code, model: activeModel, log: logFile, aborted: done.reason || null });
      diagnostics.note('dsh run complete', { exit: done.code, model: activeModel, aborted: done.reason || null });
      // A human abort is not a generation failure to be repaired by another round:
      // it is a decision. Throwing here (instead of returning a null exit code)
      // names it, and the pipeline's emitter guard turns it into one honest
      // "aborted by user" failure rather than "generation produced no controller".
      if (done.reason === 'user') throw new Error('generation aborted by the user (SIGTERM to the headless dsh child)');
      return done.code;
    },

    // Stop hook for the app's red button / /stop: end the in-flight generation now.
    // NOT_RUNNING when idle, so a stop with nothing to kill stays a no-op sentence.
    abort() {
      if (!active || active.child.exitCode !== null) return { ok: false, code: 'NOT_RUNNING', error: 'no generation is in flight' };
      active.reason = 'user';
      try { active.child.kill('SIGTERM'); } catch (e) { return { ok: false, code: 'KILL_FAILED', error: e.message }; }
      return { ok: true, pid: active.child.pid ?? null };
    },
  },
});

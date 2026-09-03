// JavaScript emitter (DSH-assisted). The proven generation path: build the
// contract task prompt (prompt.mjs) and delegate code-writing to the DSH bridge,
// which produces controller.mjs in the run dir. Conceptually the emitter is
// "IR -> code"; here the IR is realized by the agent under the contract, and a
// deterministic IR->JS projection can later complement it. Same plugin slot.
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { definePlugin, CATEGORY } from '../../core/registry.mjs';
import { buildTask } from '../../lib/prompt.mjs';

export const jsEmitter = definePlugin({
  category: CATEGORY.EMITTER,
  name: 'javascript',
  version: '1.0.0',
  contributes: { language: 'javascript', description: 'JS controller emitter (DSH-assisted): builds the contract task and delegates to the DSH bridge.' },
  api: {
    language: 'javascript',
    available: () => true,
    async emit({ host, glbPath, glb, dump, runDir, failures, humanNotes, prevCode, model }) {
      const dsh = host.registry.get(CATEGORY.BRIDGE, 'dsh');
      if (!dsh) throw new Error('dsh bridge not registered');
      const task = buildTask({
        glbPath,
        stats: glb,
        dump,
        failures: failures?.length ? failures : null,
        humanNotes,
        prevCode,
      });
      const exit = await dsh.api.run({ host, task, runDir, model });
      const file = resolve(runDir, 'controller.mjs');
      const ok = existsSync(file);
      return { file: ok ? file : null, exit, code: ok ? readFileSync(file, 'utf8') : null };
    },
  },
});

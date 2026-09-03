// Python / C# emitter STUBS. Registered plugin slots so the multi-language
// architecture is exercised end-to-end, but they throw a clear NotImplemented
// until built. Future: project the motion-spec IR deterministically to the
// target language's createJointController equivalent (no DSH needed for the
// mechanical projection), then verify via the matching kinematic bridge.
import { definePlugin, CATEGORY } from '../../core/registry.mjs';

function stubEmitter(name, language) {
  return definePlugin({
    category: CATEGORY.EMITTER,
    name,
    version: '0.0.0-stub',
    contributes: { language, description: `${language} emitter (STUB): will project the motion-spec IR to ${language} controller code.` },
    api: {
      language,
      available: () => false,
      async emit() {
        const err = new Error(
          `${language} emitter is not implemented in the CLI baseline (registered stub). ` +
          `The motion-spec IR -> ${language} projection arrives in a later phase.`,
        );
        err.code = 'ENOTIMPLEMENTED';
        throw err;
      },
    },
  });
}

export const pythonEmitter = stubEmitter('python', 'python');
export const csharpEmitter = stubEmitter('csharp', 'csharp');
export const emitterStubs = [pythonEmitter, csharpEmitter];

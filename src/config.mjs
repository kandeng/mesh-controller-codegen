// Config loader: resolves all host-relative paths so nothing is hardcoded to a
// parent repo. This replaces the old gen-controller.mjs couplings (REPO=../..,
// .dsh-lab/runtime, client/node_modules/three, server/config.json).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const abs = (p) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

export function loadConfig(explicitPath) {
  const cfgPath = explicitPath ? abs(explicitPath) : resolve(REPO_ROOT, 'config.json');
  if (!existsSync(cfgPath)) {
    throw new Error(
      `config.json not found at ${cfgPath}.\n` +
      `Copy config.example.json -> config.json and set "api_key" (or export BAILIAN_API_KEY).`,
    );
  }
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const p = raw.paths || {};
  const three = abs(p.three || 'node_modules/three/build/three.module.js');
  return {
    path: cfgPath,
    apiKey: raw.api_key || process.env.BAILIAN_API_KEY || '',
    model: raw.model || 'qwen3.7-max',
    bailianBaseUrl: raw.bailian_base_url || '',
    dshTimeoutMs: raw.dsh_timeout_ms || 900_000,
    viewerPort: raw.viewer?.port || 8788,
    paths: {
      dshBin: abs(p.dsh_bin || 'runtime/node_modules/.bin/dsh'),
      bailianPatch: abs(p.bailian_patch || 'bailian.patch.yml'),
      three,
      threeUrl: pathToFileURL(three).href,
      samples: abs(p.samples || 'samples'),
      runs: abs(p.runs || 'runs'),
    },
  };
}

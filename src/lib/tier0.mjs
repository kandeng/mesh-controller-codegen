// Tier 0 — deterministic static gate (milliseconds, no execution of the module):
// ESM syntax check, forbidden-API scan, contract export shape.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FORBIDDEN = [
  [/\brequire\s*\(/, 'require()'],
  [/\bprocess\./, 'process.*'],
  [/\bchild_process\b/, 'child_process'],
  [/\beval\s*\(/, 'eval()'],
  [/new\s+Function\s*\(/, 'new Function()'],
  [/\bimport\s*\(/, 'dynamic import()'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/\bdocument\b/, 'document (DOM)'],
  [/\bwindow\b/, 'window (DOM)'],
  [/\blocalStorage\b/, 'localStorage'],
  [/\bglobalThis\b/, 'globalThis'],
  [/__proto__/, '__proto__'],
];

export function tier0(file) {
  const problems = [];
  const src = readFileSync(file, 'utf8');
  if (src.length > 200_000) problems.push(`module too large (${src.length} bytes)`);

  // ESM syntax: node --check honours the .mjs extension.
  const dir = mkdtempSync(join(tmpdir(), 'tier0-'));
  try {
    const copy = join(dir, 'check.mjs');
    writeFileSync(copy, src);
    const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
    if (r.status !== 0) {
      problems.push('ESM syntax error: ' + (r.stderr || '').trim().split('\n').slice(0, 4).join(' | '));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  for (const [re, label] of FORBIDDEN) {
    if (re.test(src)) problems.push(`forbidden API: ${label}`);
  }
  if (!/export\s+(function\s+createDroneController|\{[^}]*createDroneController)/.test(src)) {
    problems.push('missing export: createDroneController');
  }
  if (!/describe\s*\(/.test(src)) {
    problems.push('missing contract method: describe()');
  }
  return { pass: problems.length === 0, problems };
}

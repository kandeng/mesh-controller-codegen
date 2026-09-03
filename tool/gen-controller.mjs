#!/usr/bin/env node
// Local tool: GLB -> DSH-generated JS controller -> deterministic validation
// -> bounded repair loop -> human visual gate.
//
// Usage:
//   node .dsh-lab/tool/gen-controller.mjs <glb> [options]
//     --controller <file>   skip DSH; validate an existing controller module
//     --out <file>          copy the accepted controller here (default: run dir)
//     --model <id>          Bailian model id (default: qwen3.7-max)
//     --rounds <n>          max DSH repair rounds (default 3)
//     --gate <mode>         interactive (default) | auto (print checklist, don't wait)
//     --port <n>            viewer http port (default 8788)
//
// Blender is deliberately NOT part of this pipeline: it cannot execute JS, and a
// Python "behavioural adapter" would validate a paraphrase of the code instead of
// the code. Tier 1 below executes the real JS in Node against a three.js scene
// graph; genuinely visual judgement is routed to the human gate.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseGlb, dumpNodes } from './lib/gltf.mjs';
import { tier0 } from './lib/tier0.mjs';
import { tier1 } from './lib/tier1.mjs';
import { buildTask } from './lib/prompt.mjs';

const TOOL = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(TOOL, '../..');
const LAB = resolve(REPO, '.dsh-lab');
const DSH_BIN = resolve(LAB, 'runtime/node_modules/.bin/dsh');
const BAILIAN_PATCH = resolve(LAB, 'bailian.patch.yml');
const THREE_URL = pathToFileURL(resolve(REPO, 'client/node_modules/three/build/three.module.js')).href;
const DSH_TIMEOUT_MS = 900_000;

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  return argv[i + 1];
};
const glbArg = argv.find((a) => !a.startsWith('--'));
if (!glbArg) {
  console.error('usage: node gen-controller.mjs <glb> [--controller f] [--out f] [--model id] [--rounds n] [--gate interactive|auto] [--port n]');
  process.exit(2);
}
const GLB = isAbsolute(glbArg) ? glbArg : resolve(process.cwd(), glbArg);
const CONTROLLER_ARG = opt('controller', null);
const OUT = opt('out', null);
const MODEL = opt('model', 'qwen3.7-max');
const ROUNDS = parseInt(opt('rounds', '3'), 10);
const GATE = opt('gate', 'interactive');
const PORT = parseInt(opt('port', '8788'), 10);

const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN = resolve(LAB, 'runs', TS);
mkdirSync(RUN, { recursive: true });
const log = (...a) => console.log('[gen-controller]', ...a);

// ---- model + key ------------------------------------------------------------
const cfg = JSON.parse(readFileSync(resolve(REPO, 'server/config.json'), 'utf8'));
const API_KEY = cfg?.chat?.api_key || '';
let modelPatch = null;
if (MODEL !== 'qwen3.7-max') {
  modelPatch = resolve(RUN, 'model.patch.yml');
  writeFileSync(modelPatch, `- id: agent-default-model\n  config:\n    provider: bailian\n    model: ${MODEL}\n`);
}

// ---- DSH one-shot run ---------------------------------------------------------
function runDsh(task) {
  const taskFile = resolve(RUN, 'task.md');
  writeFileSync(taskFile, task);
  const logFile = resolve(RUN, 'dsh.log');
  log(`DSH headless run (model=${MODEL}) -> ${logFile}`);
  return new Promise((res) => {
    const out = [];
    const child = spawn(DSH_BIN, [
      '--profile', 'headless',
      '--patch', BAILIAN_PATCH,
      ...(modelPatch ? ['--patch', modelPatch] : []),
      task,
    ], { cwd: RUN, env: { ...process.env, BAILIAN_API_KEY: API_KEY } });
    const fd = require_fs_open(logFile);
    child.stdout.on('data', (d) => append(fd, d));
    child.stderr.on('data', (d) => append(fd, d));
    const killer = setTimeout(() => child.kill('SIGTERM'), DSH_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(killer); close_fd(fd); res(code); });
  });
}
// tiny sync-free fd helpers (avoid importing fs promises twice)
import { openSync, writeSync, closeSync } from 'node:fs';
function require_fs_open(p) { return openSync(p, 'w'); }
function append(fd, d) { writeSync(fd, d); }
function close_fd(fd) { closeSync(fd); }

// ---- validation ---------------------------------------------------------------
const THREE = await import(THREE_URL);
const glb = parseGlb(GLB);
log(`GLB: ${relative(REPO, GLB)} — ${glb.count} nodes, ${glb.animations} animations`);

let controller = CONTROLLER_ARG ? (isAbsolute(CONTROLLER_ARG) ? CONTROLLER_ARG : resolve(process.cwd(), CONTROLLER_ARG)) : resolve(RUN, 'controller.mjs');
let failures = [];
let warnings = [];
let metrics = {};
let roundsUsed = 0;

async function validate(file) {
  const t0 = tier0(file);
  if (!t0.pass) return { pass: false, failures: t0.problems, warnings: [], metrics: {} };
  return tier1(glb, file, THREE);
}

if (!CONTROLLER_ARG) {
  let prevCode = null;
  let humanNotes = null;
  for (let round = 1; round <= ROUNDS; round++) {
    roundsUsed = round;
    const task = buildTask({
      glbPath: GLB,
      stats: glb,
      dump: dumpNodes(glb),
      failures: failures.length ? failures : null,
      humanNotes,
      prevCode,
    });
    const code = await runDsh(task);
    log(`DSH exit=${code}`);
    if (!existsSync(controller)) {
      failures = [`DSH run produced no controller.mjs (exit=${code}); see ${resolve(RUN, 'dsh.log')}`];
      prevCode = null;
      continue;
    }
    prevCode = readFileSync(controller, 'utf8');
    const r = await validate(controller);
    ({ failures, warnings, metrics } = r);
    log(`round ${round}: tier0+tier1 ${r.pass ? 'PASS' : 'FAIL'}${r.failures.length ? ` — ${r.failures[0]}` : ''}`);
    if (r.pass) break;
    humanNotes = null;
  }
} else {
  const r = await validate(controller);
  ({ failures, warnings, metrics } = r);
  log(`validate-only: ${r.pass ? 'PASS' : 'FAIL'}`);
}

// ---- human visual gate ----------------------------------------------------------
function checklist(url) {
  return `
HUMAN VISUAL VERIFICATION REQUIRED (the AI cannot be trusted for these)
  1. Open ${url}
  2. Propeller BLADES spin together with their motor hubs (not hubs alone).
  3. Gimbal pitch/yaw sliders tilt the camera body TOGETHER with the gimbal joints.
  4. Turn Left / Turn Right visibly differentiate the diagonal propeller pairs.
  5. RPM readout grows with the speed slider.
  6. At Speed 0 the propellers come to a COMPLETE stop (check after moving the slider back).
${warnings.length ? `\nAutomated warnings to check by eye (full list in report.json):\n${warnings.slice(0, 6).map((w) => `  - ${w}`).join('\n')}${warnings.length > 6 ? `\n  … +${warnings.length - 6} more` : ''}\n` : ''}`;
}

async function ensureServer() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'HEAD' });
    if (r.ok || r.status === 404) return;
  } catch { /* not up */ }
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: REPO, stdio: 'ignore', detached: true });
  srv.unref();
  await new Promise((r) => setTimeout(r, 1200));
}

let accepted = failures.length === 0;
if (accepted) {
  // Browsers need a JS-mime module: serve a .js copy of the accepted controller.
  const viewFile = resolve(RUN, 'controller.view.js');
  const refreshView = () => copyFileSync(controller, viewFile);
  refreshView();
  const glbUrl = '/' + relative(REPO, GLB);
  const ctlUrl = '/' + relative(REPO, viewFile);
  const url = `http://127.0.0.1:${PORT}/.dsh-lab/tool/viewer.html?glb=${encodeURIComponent(glbUrl)}&ctl=${encodeURIComponent(ctlUrl)}`;
  console.log(checklist(url));
  if (GATE === 'interactive') {
    await ensureServer();
    let humanRounds = 2;
    for (;;) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('Visual check — type "pass" or describe what is wrong: ')).trim();
      rl.close();
      if (/^pass$/i.test(answer)) break;
      if (humanRounds-- <= 0 || CONTROLLER_ARG) {
        accepted = false;
        failures = [`human gate rejected: ${answer}`];
        break;
      }
      const prevCode = readFileSync(controller, 'utf8');
      const code = await runDsh(buildTask({
        glbPath: GLB, stats: glb, dump: dumpNodes(glb),
        failures: null, humanNotes: answer, prevCode,
      }));
      log(`repair DSH exit=${code}`);
      const r = await validate(controller);
      ({ failures, warnings, metrics } = r);
      accepted = r.pass;
      if (r.pass) refreshView();
      if (!r.pass) { console.log(checklist(url)); continue; }
      console.log(checklist(url));
    }
  } else {
    log('gate=auto: interactive visual verification skipped (run with --gate interactive for the human step)');
  }
}

// ---- finalize ---------------------------------------------------------------------
if (accepted && OUT) {
  const out = isAbsolute(OUT) ? OUT : resolve(process.cwd(), OUT);
  copyFileSync(controller, out);
  log(`accepted controller copied to ${out}`);
}
writeFileSync(resolve(RUN, 'report.json'), JSON.stringify({ accepted, roundsUsed, failures, warnings, metrics, controller }, null, 2));
log(`DONE accepted=${accepted} rounds=${roundsUsed} run=${RUN}`);
if (!accepted) failures.forEach((f) => log('FAIL: ' + f));
warnings.forEach((w) => log('WARN: ' + w));
process.exit(accepted ? 0 : 1);

#!/usr/bin/env node
// mesh-controller-codegen — CLI baseline (thin wrapper over src/pipeline.mjs).
// The orchestration now lives in pipeline.mjs so the Fastify backend reuses the
// exact same code path. This file only handles: arg parsing, kernel boot, the
// interactive human gate (readline + console), and final console reporting.
//
// Usage:
//   node src/cli.mjs <glb> [options]
//     --controller <file>   skip generation; validate an existing controller module
//     --out <file>          copy the accepted controller here
//     --lang <id>           javascript (default) | python | csharp  (py/cs are stubs)
//     --model <id>          Bailian model id (default from config.json)
//     --rounds <n>          max repair rounds (default 1)
//     --gate <mode>         interactive (default) | auto
//     --port <n>            viewer http port (default from config.json)
//     --config <file>       config path (default <repo>/config.json)
//     --verbose             trace every event to stderr
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve, relative, isAbsolute } from 'node:path';

import { createHost } from './core/host.mjs';
import { loadConfig } from './config.mjs';
import { registerAllPlugins } from './plugins/index.mjs';
import { startViewerServer } from './serve/viewer-server.mjs';
import {
  discoverJoints, validateController, generateController, repairWithNotes,
  loadThree, toViewerUrl, refreshView, finalizeRun,
} from './pipeline.mjs';

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i === -1 ? dflt : argv[i + 1]; };
const flag = (name) => argv.includes(`--${name}`);
const VALUE_OPTS = new Set(['controller', 'out', 'lang', 'model', 'rounds', 'gate', 'port', 'config']);
let glbArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (VALUE_OPTS.has(a.slice(2))) i++; continue; } // skip flags (and their values)
  glbArg = a; break; // first bare positional is the GLB
}
if (!glbArg) {
  console.error('usage: node src/cli.mjs <glb> [--controller f] [--out f] [--lang javascript|python|csharp] [--model id] [--rounds n] [--gate interactive|auto] [--port n] [--config f] [--verbose]');
  process.exit(2);
}
const LANG_ALIAS = { js: 'javascript', javascript: 'javascript', py: 'python', python: 'python', cs: 'csharp', csharp: 'csharp' };
const LANG = LANG_ALIAS[(opt('lang', 'javascript') || '').toLowerCase()] || 'javascript';
const CONTROLLER_ARG = opt('controller', null);
const OUT = opt('out', null);
const MODEL = opt('model', null);
const ROUNDS = parseInt(opt('rounds', '1'), 10);
const GATE = opt('gate', 'interactive');
const PORT = parseInt(opt('port', '0'), 10);
const VERBOSE = flag('verbose');

// ---- boot kernel ------------------------------------------------------------
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const CONFIG_ARG = opt('config', null);
// Resolve the run dir from config FIRST so the diagnostics trace, context.json,
// report.json, and the generated controller all land in the same run dir.
const RUN = resolve(loadConfig(CONFIG_ARG).paths.runs, TS);
mkdirSync(RUN, { recursive: true });
const host = createHost({ configPath: CONFIG_ARG, runDir: RUN, verbose: VERBOSE });
const REPO_ROOT = host.repoRoot;
const PORT_FINAL = Number.isFinite(PORT) && PORT > 0 ? PORT : host.config.viewerPort;
host.diagnostics.note('cli boot', { lang: LANG, gate: GATE, rounds: ROUNDS, model: MODEL || host.config.model });
const log = (...a) => console.log('[mcc]', ...a);

const GLB = isAbsolute(glbArg) ? glbArg : resolve(process.cwd(), glbArg);
if (!existsSync(GLB)) { log(`GLB not found: ${GLB}`); await host.shutdown('error'); process.exit(2); }

// ---- register plugins -------------------------------------------------------
const summary = await registerAllPlugins(host);
log(`plugins registered: ${Object.entries(summary).map(([c, n]) => `${c}=[${n.join(',')}]`).join(' ')}`);

// ---- asset + discovery ------------------------------------------------------
const disc = await discoverJoints(host, GLB);
const { stats: glb, dump, joints } = disc;
log(`GLB: ${relative(REPO_ROOT, GLB)} — ${glb.count} nodes, ${glb.animations} animations, radius ${glb.radius.toFixed(1)}`);
log(`discovered ${joints.length} joint unit(s): ${joints.map((j) => `${j.label}[${j.type}:${j.nodes.length}]`).join(', ')}`);
if (!disc.specCheck.ok) log(`motion-spec problems: ${disc.specCheck.problems.join('; ')}`);

// ---- three + validation / generation ---------------------------------------
const THREE = await loadThree(host);
const emitter = host.registry.get('emitter', LANG);
let controller = CONTROLLER_ARG ? (isAbsolute(CONTROLLER_ARG) ? CONTROLLER_ARG : resolve(process.cwd(), CONTROLLER_ARG)) : resolve(RUN, 'controller.mjs');
let failures = []; let warnings = []; let metrics = {}; let roundsUsed = 0;

if (!CONTROLLER_ARG) {
  if (!emitter) { log(`no emitter for lang=${LANG}`); await host.shutdown('error'); process.exit(2); }
  const gen = await generateController(host, {
    glbPath: GLB, glb, dump, runDir: RUN, lang: LANG, model: MODEL, rounds: ROUNDS, THREE,
    onRound: ({ round, pass, failures: f }) => log(`round ${round}: tier0+tier1 ${pass ? 'PASS' : 'FAIL'}${f.length ? ` — ${f[0]}` : ''}`),
  });
  ({ controller, failures, warnings, metrics, roundsUsed } = gen);
} else {
  const r = await validateController(host, controller, { glb, THREE });
  ({ failures, warnings, metrics } = r);
  log(`validate-only (${relative(REPO_ROOT, controller)}): ${r.pass ? 'PASS' : 'FAIL'}`);
}

// ---- human visual gate ------------------------------------------------------
function checklist(url) {
  return `\nHUMAN VISUAL VERIFICATION REQUIRED (the AI cannot be trusted for these)\n  1. Open ${url}\n  2. Propeller BLADES spin together with their motor hubs (not hubs alone).\n  3. Gimbal pitch/yaw sliders tilt the camera body TOGETHER with the gimbal joints.\n  4. Turn Left / Turn Right visibly differentiate the diagonal propeller pairs.\n  5. RPM readout grows with the speed slider.\n  6. At Speed 0 the propellers come to a COMPLETE stop.\n${warnings.length ? `\nAutomated warnings to check by eye (full list in report.json):\n${warnings.slice(0, 6).map((w) => `  - ${w}`).join('\n')}${warnings.length > 6 ? `\n  … +${warnings.length - 6} more` : ''}\n` : ''}`;
}

let accepted = failures.length === 0;
const viewFile = resolve(RUN, 'controller.view.js');
let url = `http://127.0.0.1:${PORT_FINAL}/viewer/viewer.html`;

if (accepted) {
  refreshView(RUN, controller);
  const gateUrl = () => `http://127.0.0.1:${PORT_FINAL}/viewer/viewer.html?glb=${encodeURIComponent(toViewerUrl(host, RUN, GLB))}&ctl=${encodeURIComponent(toViewerUrl(host, RUN, viewFile))}`;
  if (GATE === 'interactive') {
    const server = await startViewerServer({ root: REPO_ROOT, port: PORT_FINAL, host });
    url = gateUrl();
    console.log(checklist(url));
    let humanRounds = 2;
    for (;;) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('Visual check — type "pass" or describe what is wrong: ')).trim();
      rl.close();
      if (/^pass$/i.test(answer)) break;
      if (humanRounds-- <= 0 || CONTROLLER_ARG) { accepted = false; failures = [`human gate rejected: ${answer}`]; break; }
      const prevCode = readFileSync(controller, 'utf8');
      const r = await repairWithNotes(host, { glbPath: GLB, glb, dump, runDir: RUN, controller, humanNotes: answer, prevCode, model: MODEL, lang: LANG, THREE });
      ({ failures, warnings, metrics } = r);
      accepted = r.pass;
      if (r.pass) refreshView(RUN, controller);
      console.log(checklist(url));
    }
  } else {
    url = gateUrl();
    console.log(checklist(url));
    log('gate=auto: live viewer not started (run with --gate interactive to open it)');
  }
}

// ---- finalize ---------------------------------------------------------------
if (accepted && OUT) {
  const out = isAbsolute(OUT) ? OUT : resolve(process.cwd(), OUT);
  copyFileSync(controller, out); log(`accepted controller copied to ${out}`);
}
finalizeRun(host, { runDir: RUN, accepted, roundsUsed, lang: LANG, model: MODEL, failures, warnings, metrics, controller, joints });

log(`DONE accepted=${accepted} rounds=${roundsUsed} lang=${LANG} run=${RUN}`);
if (!accepted) failures.forEach((f) => log('FAIL: ' + f));
warnings.forEach((w) => log('WARN: ' + w));

await host.resources.disposeAll();
host.diagnostics.close();
process.exit(accepted ? 0 : 1);

// Shared orchestration for BOTH the CLI and the Fastify backend. Pure functions
// over an already-booted host: discover -> motion-spec IR -> validate -> generate
// loop -> finalize. They emit on the existing event bus and return plain results,
// so the server can stream progress and the CLI can print it — same code path,
// no duplication. The backend is the system-of-record; this is its pipeline.
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, relative, basename, sep, isAbsolute } from 'node:path';
import { CATEGORY } from './core/registry.mjs';
import { EVT } from './core/events.mjs';
import { createMotionSpec, addJoint, validateSpec } from './ir/motion-spec.mjs';

// three is loaded from the configured module URL (the same build the viewer uses).
export async function loadThree(host) {
  return import(host.config.paths.threeUrl);
}

// Resolve a possibly-relative path against the repo root (not cwd) so the server
// and CLI behave identically regardless of where they were launched.
export function resolvePath(host, p) {
  return isAbsolute(p) ? p : resolve(host.repoRoot, p);
}

// ---- discovery --------------------------------------------------------------
// Register the mesh asset, run geometry discovery, draft the motion-spec IR, and
// persist the work state into the shared context store.
export async function discoverJoints(host, glbPath) {
  const GLB = resolvePath(host, glbPath);
  if (!existsSync(GLB)) throw new Error(`GLB not found: ${GLB}`);

  const asset = host.assets.register({ id: basename(GLB), kind: 'mesh', path: GLB });
  const discovery = host.registry.get(CATEGORY.DISCOVERY, 'geometry');
  if (!discovery) throw new Error('discovery plugin "geometry" not registered');

  const { stats, dump, joints } = discovery.api.discover(GLB, host);

  const spec = createMotionSpec({ assetId: asset.id, path: GLB });
  for (const j of joints) addJoint(spec, j);
  const specCheck = validateSpec(spec);

  host.context.set({
    mesh: {
      assetId: asset.id,
      path: GLB,
      hash: asset.hash,
      stats: { count: stats.count, animations: stats.animations, radius: stats.radius, maxWExt: stats.maxWExt },
    },
    joints,
    motionSpec: spec,
  });

  return { glbPath: GLB, asset, stats, dump, joints, spec, specCheck };
}

// ---- validation -------------------------------------------------------------
// Run every validator plugin in tier order; short-circuit on the first failure.
export async function validateController(host, file, { glb, THREE }) {
  const validators = host.registry
    .list(CATEGORY.VALIDATOR)
    .sort((a, b) => (a.api.tier || 0) - (b.api.tier || 0));
  let last = { pass: true, failures: [], warnings: [], metrics: {} };
  for (const v of validators) {
    host.bus.emit(EVT.VALIDATE_START, { validator: v.name, file: basename(file) });
    let r;
    try {
      r = await v.api.run({ file, glb, THREE });
    } catch (e) {
      r = { pass: false, failures: [`${v.name} errored: ${e.message}`], warnings: [], metrics: {} };
    }
    host.bus.emit(EVT.VALIDATE_DONE, { validator: v.name, pass: r.pass, failures: r.failures?.length || 0 });
    last = r;
    if (!r.pass) return r; // short-circuit on the first failing tier
  }
  return last;
}

// ---- generation -------------------------------------------------------------
// Bounded generate -> validate repair loop. `onRound` lets the caller (CLI print /
// server WS stream) observe each round. Returns the controller path + results.
export async function generateController(host, opts) {
  const {
    glbPath, glb, dump, runDir,
    lang = 'javascript', model = null, rounds = 3,
    THREE: THREE_IN = null, onRound = null,
  } = opts;

  const emitter = host.registry.get(CATEGORY.EMITTER, lang);
  if (!emitter) throw new Error(`no emitter for lang=${lang}`);

  const THREE = THREE_IN || (await loadThree(host));
  const controller = resolve(runDir, 'controller.mjs');

  let failures = []; let warnings = []; let metrics = {};
  let roundsUsed = 0; let prevCode = null; let humanNotes = null;

  for (let round = 1; round <= rounds; round++) {
    roundsUsed = round;
    let out;
    try {
      out = await emitter.api.emit({ host, glbPath, glb, dump, runDir, failures, humanNotes, prevCode, model });
    } catch (e) {
      failures = [`emitter(${lang}) failed: ${e.message}`];
      onRound?.({ round, pass: false, failures, warnings, metrics, error: e.message });
      break;
    }
    if (!out.file) {
      failures = [`generation produced no controller.mjs (exit=${out.exit}); see ${resolve(runDir, 'dsh.log')}`];
      prevCode = null;
      onRound?.({ round, pass: false, failures, warnings, metrics });
      continue;
    }
    prevCode = out.code;
    const r = await validateController(host, controller, { glb, THREE });
    ({ failures, warnings, metrics } = r);
    onRound?.({ round, pass: r.pass, failures, warnings, metrics });
    if (r.pass) break;
    humanNotes = null;
  }

  return { controller, failures, warnings, metrics, roundsUsed, THREE };
}

// One human-note-driven repair round (used by the interactive gate).
export async function repairWithNotes(host, opts) {
  const { glbPath, glb, dump, runDir, controller, humanNotes, prevCode, model, lang = 'javascript', THREE } = opts;
  const emitter = host.registry.get(CATEGORY.EMITTER, lang);
  if (!emitter) throw new Error(`no emitter for lang=${lang}`);
  await emitter.api.emit({ host, glbPath, glb, dump, runDir, failures: null, humanNotes, prevCode, model });
  return validateController(host, controller, { glb, THREE });
}

// ---- viewer artifacts -------------------------------------------------------
// Map an on-disk file to a repo-root-relative URL the static server can serve;
// files outside the root are copied into the run dir first.
export function toViewerUrl(host, runDir, file) {
  const rel = relative(host.repoRoot, file);
  if (!rel.startsWith('..')) return `/${rel.split(sep).join('/')}`;
  const dest = resolve(runDir, basename(file));
  copyFileSync(file, dest);
  return `/${relative(host.repoRoot, dest).split(sep).join('/')}`;
}

// Copy the accepted controller to controller.view.js (the URL the viewer imports).
export function refreshView(runDir, controller) {
  const viewFile = resolve(runDir, 'controller.view.js');
  if (existsSync(controller)) copyFileSync(controller, viewFile);
  return viewFile;
}

// ---- finalize ---------------------------------------------------------------
// Persist work state + write report.json. Returns the report object.
export function finalizeRun(host, { runDir, accepted, roundsUsed, lang, model, failures, warnings, metrics, controller, joints }) {
  host.context.set({
    validation: { accepted, failures, warnings, metrics },
    artifacts: { ...(host.context.state.artifacts || {}), controller },
  });
  host.context.persist();

  const report = {
    accepted,
    roundsUsed,
    lang,
    model: model || host.config.model,
    failures,
    warnings,
    metrics,
    controller,
    joints: (joints || []).map((j) => ({ id: j.id, label: j.label, type: j.type, nodes: j.nodes.length })),
    diagnostics: { trace: host.diagnostics.tracePath, counts: host.diagnostics.count() },
    runDir,
  };
  writeFileSync(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

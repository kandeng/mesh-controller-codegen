// Long-lived kernel host for the Fastify backend. The CLI boots a host per run;
// the server boots ONE host for its whole lifetime and reuses it across requests.
// This facade wraps src/pipeline.mjs so routes stay thin, caches the last
// discovery (glb stats / dump / THREE) so validate+generate don't re-parse the
// 23MB GLB, and keeps the kernel as the system-of-record for work state.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHost } from '../src/core/host.mjs';
import { loadConfig } from '../src/config.mjs';
import { registerAllPlugins } from '../src/plugins/index.mjs';
import {
  discoverJoints, validateController, generateController, repairWithNotes,
  loadThree, toViewerUrl, refreshView, finalizeRun,
} from '../src/pipeline.mjs';
import { createSessionStore } from './session-store.mjs';

const TS = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export async function createKernelHost({ configPath = null, verbose = false } = {}) {
  const cfg = loadConfig(configPath);
  const runDir = resolve(cfg.paths.runs, `app-${TS()}`);
  mkdirSync(runDir, { recursive: true });

  const host = createHost({ configPath, runDir, verbose });
  const summary = await registerAllPlugins(host);
  host.diagnostics.note('server kernel boot', { runDir, plugins: Object.values(summary).flat().length });

  // Cached state for the currently-loaded project (single active project in M1).
  const current = {
    glbPath: null,
    glb: null,      // parse stats
    dump: null,     // node dump (for the generator prompt)
    joints: [],
    spec: null,
    THREE: null,
    controller: null,
    lastValidation: null,
  };

  const THREE = await loadThree(host);
  current.THREE = THREE;

  // Stable-path conversation/session store (survives server restarts).
  const sessionStore = createSessionStore({ repoRoot: host.repoRoot });
  sessionStore.setSession({ runDir });

  const kernel = {
    host,
    runDir,
    config: host.config,
    bus: host.bus,
    context: host.context,
    assets: host.assets,
    diagnostics: host.diagnostics,
    registry: host.registry,
    resources: host.resources,
    current,
    sessionStore,
    pluginSummary: summary,

    // Discover joints for a GLB; caches the parsed mesh for later validate/generate.
    async discover(glbPath) {
      const d = await discoverJoints(host, glbPath);
      current.glbPath = d.glbPath;
      current.glb = d.stats;
      current.dump = d.dump;
      current.joints = d.joints;
      current.spec = d.spec;
      current.controller = null;
      current.lastValidation = null;
      sessionStore.setSession({ glb: d.glbPath });
      sessionStore.setWork({ joints: d.joints.map((j) => ({ id: j.id, label: j.label, type: j.type, nodeCount: (j.nodes || []).length })) });
      return d;
    },

    // Validate a controller file against the cached mesh.
    async validate(file) {
      if (!current.glb) throw new Error('no project loaded; POST /api/project first');
      const abs = resolve(host.repoRoot, file);
      const r = await validateController(host, abs, { glb: current.glb, THREE });
      current.controller = abs;
      current.lastValidation = r;
      return { ...r, controller: abs, controllerUrl: toViewerUrl(host, runDir, abs) };
    },

    // Bounded generate->validate loop (DSH). onRound streams to the caller.
    async generate({ lang = 'javascript', model = null, rounds = 3, onRound = null } = {}) {
      if (!current.glb) throw new Error('no project loaded; POST /api/project first');
      const gen = await generateController(host, {
        glbPath: current.glbPath, glb: current.glb, dump: current.dump,
        runDir, lang, model, rounds, THREE, onRound,
      });
      current.controller = gen.controller;
      current.lastValidation = { pass: gen.failures.length === 0, failures: gen.failures, warnings: gen.warnings, metrics: gen.metrics };
      return gen;
    },

    // One human-note repair round (interactive gate over WS).
    async repair({ humanNotes, model = null, lang = 'javascript' }) {
      if (!current.controller) throw new Error('nothing to repair; generate or validate first');
      const r = await repairWithNotes(host, {
        glbPath: current.glbPath, glb: current.glb, dump: current.dump, runDir,
        controller: current.controller, humanNotes, prevCode: null, model, lang, THREE,
      });
      current.lastValidation = r;
      return r;
    },

    // Refresh controller.view.js + return the viewer URLs for the current project.
    viewerUrls() {
      const out = { glb: current.glbPath ? toViewerUrl(host, runDir, current.glbPath) : null, ctl: null };
      if (current.controller) {
        const viewFile = refreshView(runDir, current.controller);
        out.ctl = toViewerUrl(host, runDir, viewFile);
      }
      return out;
    },

    finalize({ accepted, roundsUsed = 0, lang = 'javascript', model = null, failures = [], warnings = [], metrics = {}, controller = null }) {
      return finalizeRun(host, {
        runDir, accepted, roundsUsed, lang, model, failures, warnings, metrics,
        controller: controller || current.controller, joints: current.joints,
      });
    },

    async shutdown(signal = 'server') { return host.shutdown(signal); },
  };

  return kernel;
}

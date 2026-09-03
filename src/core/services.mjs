// Kernel services — the thin primitives the host owns. Plugins are the domain
// extensions; these five are the kernel. Each is a small factory, no framework.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  mkdirSync, readFileSync, writeFileSync, existsSync, rmSync,
  openSync, writeSync, closeSync,
} from 'node:fs';
import { resolve, basename } from 'node:path';
import { EVT } from './events.mjs';

// ---- Lifecycle Hooks --------------------------------------------------------
// Pipeline hooks: beforeDiscover/afterDiscover/beforeGenerate/afterGenerate/
// beforeValidate/afterValidate/beforeVerify/afterVerify/beforeExport/afterExport
export function createLifecycle(bus) {
  const hooks = new Map(); // hookName -> [fn]
  return {
    on(hookName, fn) {
      if (!hooks.has(hookName)) hooks.set(hookName, []);
      hooks.get(hookName).push(fn);
      return () => { const a = hooks.get(hookName); const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
    },
    // Run hooks in order; a hook may return a transformed payload.
    async run(hookName, payload) {
      let p = payload;
      for (const fn of hooks.get(hookName) || []) {
        const r = await fn(p);
        if (r !== undefined) p = r;
      }
      bus?.emit(`lifecycle:${hookName}`, { hook: hookName });
      return p;
    },
    names() { return [...hooks.keys()]; },
  };
}

// ---- Resource Garbage Collector --------------------------------------------
// Tracks spawned child processes, temp dirs, and generic disposers; tears them
// down on shutdown. Directly addresses the runaway-DSH-process pain.
export function createResources(log = () => {}) {
  const disposers = [];
  const children = new Set();
  const tempDirs = new Set();
  return {
    onDispose(fn) { disposers.push(fn); return () => { const i = disposers.indexOf(fn); if (i >= 0) disposers.splice(i, 1); }; },
    trackChild(child, label = 'child') {
      children.add(child);
      const done = () => children.delete(child);
      child.once?.('close', done);
      child.once?.('exit', done);
      log(`[resources] track ${label} pid=${child.pid}`);
      return child;
    },
    trackTempDir(dir) { tempDirs.add(dir); return dir; },
    async disposeAll() {
      for (const c of [...children]) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
      while (disposers.length) {
        const fn = disposers.pop();
        try { await fn(); } catch (e) { log(`[resources] disposer error: ${e?.message}`); }
      }
      for (const d of [...tempDirs]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
      children.clear(); tempDirs.clear();
      log('[resources] disposed all');
    },
    counts() { return { children: children.size, tempDirs: tempDirs.size, disposers: disposers.length }; },
  };
}

// ---- Asset Registry ---------------------------------------------------------
// id -> {kind, path, hash, meta}. Content-addressable hash for meshes (dedup).
export function createAssets(bus, log = () => {}) {
  const byId = new Map();
  const hashFile = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16); } catch { return null; } };
  return {
    register({ id, kind, path, meta = {} }) {
      if (!existsSync(path)) throw new Error(`asset path missing: ${path}`);
      const rec = { id, kind, path, hash: meta.hash || (kind === 'mesh' ? hashFile(path) : null), meta, registeredAt: Date.now() };
      byId.set(id, rec);
      bus?.emit(EVT.ASSET_REGISTERED, { id, kind, path: basename(path) });
      log(`[assets] registered ${kind} ${id} -> ${basename(path)}`);
      return rec;
    },
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    list: (kind) => [...byId.values()].filter((a) => !kind || a.kind === kind),
  };
}

// ---- Shared Context Store ---------------------------------------------------
// The app is the system-of-record for WORK state. Persisted to the run dir so a
// closed/reopened session restores the joint map, artifacts, and transcript.
export function createContext({ projectDir = null, runDir, initial = {} } = {}) {
  const state = {
    createdAt: Date.now(),
    projectDir,
    runDir,
    mesh: null,        // { assetId, path, stats }
    joints: [],        // discovered/confirmed joint units
    activeJoint: null,
    artifacts: {},     // jointName -> { spec, code:{js,python,csharp}, validation }
    motionSpec: null,  // language-neutral IR (whole project)
    conversation: [],  // transcript for resumability
    validation: null,
    ...initial,
  };
  const file = resolve(runDir, 'context.json');
  return {
    state,
    file,
    set(patch) { Object.assign(state, patch); return state; },
    update(fn) { fn(state); return state; },
    persist() { mkdirSync(runDir, { recursive: true }); writeFileSync(file, JSON.stringify(state, null, 2)); return file; },
    load() { if (existsSync(file)) Object.assign(state, JSON.parse(readFileSync(file, 'utf8'))); return state; },
  };
}

// ---- Dev Diagnostics --------------------------------------------------------
// Subscribes to EVERY bus event (onAny) and writes a slim trace.jsonl per run,
// plus per-type counters. Addresses the opaque-agent-loop pain.
export function createDiagnostics({ bus, runDir, verbose = false }) {
  mkdirSync(runDir, { recursive: true });
  const tracePath = resolve(runDir, 'trace.jsonl');
  // Synchronous fd writes: the CLI may process.exit() right after close(), and an
  // async createWriteStream would lose buffered lines. writeSync always flushes.
  const fd = openSync(tracePath, 'a');
  const counters = new Map();

  const off = bus.onAny((evt) => {
    const { type, ts, ...rest } = evt;
    counters.set(type, (counters.get(type) || 0) + 1);
    const slim = { t: ts, type };
    for (const k of Object.keys(rest)) {
      const v = rest[k];
      if (v == null) continue;
      if (typeof v === 'string') slim[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
      else if (typeof v === 'number' || typeof v === 'boolean') slim[k] = v;
      else slim[k] = Array.isArray(v) ? `[array:${v.length}]` : `[${typeof v}]`;
    }
    writeSync(fd, `${JSON.stringify(slim)}\n`);
    if (verbose) console.error(`[trace] ${type}`);
  });

  return {
    tracePath,
    count: (type) => (type ? counters.get(type) || 0 : Object.fromEntries(counters)),
    note: (msg, data = {}) => bus.emit(EVT.DIAG, { msg, ...data }),
    close() { off(); try { closeSync(fd); } catch { /* already closed */ } },
  };
}

// Re-export for convenience so the host can be assembled from one import.
export { EventEmitter };

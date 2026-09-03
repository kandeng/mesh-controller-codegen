// Plugin Registry — catalog of extension points that genuinely vary:
//   discovery | joint | emitter | validator | bridge
// A "plugin" is a plain module implementing a known interface, registered at
// boot (in-process; no dynamic loading/sandboxing — deliberately thin).
import { EVT } from './events.mjs';

export const CATEGORY = Object.freeze({
  DISCOVERY: 'discovery',
  JOINT: 'joint',
  EMITTER: 'emitter',
  VALIDATOR: 'validator',
  BRIDGE: 'bridge',
});

export function createRegistry(bus) {
  const byCategory = new Map(); // category -> Map(name -> plugin)

  return {
    register(plugin) {
      const { category, name } = plugin;
      if (!category || !name) throw new Error('plugin needs {category, name}');
      if (!byCategory.has(category)) byCategory.set(category, new Map());
      const cat = byCategory.get(category);
      if (cat.has(name)) throw new Error(`plugin already registered: ${category}/${name}`);
      cat.set(name, plugin);
      bus?.emit(EVT.BOOT, { plugin: `${category}/${name}` });
      return plugin;
    },
    get(category, name) { return byCategory.get(category)?.get(name); },
    has(category, name) { return !!byCategory.get(category)?.has(name); },
    list(category) { return [...(byCategory.get(category)?.values() || [])]; },
    categories() { return [...byCategory.keys()]; },
    // First plugin in a category whose when(ctx) is true (default: always).
    select(category, ctx) {
      for (const p of this.list(category)) if (!p.when || p.when(ctx)) return p;
      return null;
    },
    summary() {
      const out = {};
      for (const [c, m] of byCategory) out[c] = [...m.keys()];
      return out;
    },
  };
}

// Normalized plugin shape. `contributes.slots` is declared now but consumed by
// the Vue 3 shell later (Slot Routing Graph) — the CLI ignores it.
export function definePlugin(spec) {
  return {
    category: spec.category,
    name: spec.name,
    version: spec.version || '0.0.0',
    contributes: spec.contributes || {},
    when: spec.when,
    activate: spec.activate,     // async (host) => void
    deactivate: spec.deactivate, // async (host) => void
    api: spec.api || {},
  };
}

// Register + activate a plugin, wiring its deactivate into the resource GC.
export async function bootPlugin(plugin, host) {
  host.registry.register(plugin);
  if (plugin.activate) await plugin.activate(host);
  if (plugin.deactivate) host.resources.onDispose(() => plugin.deactivate(host));
  return plugin;
}

// The shared trust rules for BOTH proposal producers (L2 text and L2 vision).
//
// Why this file exists separately rather than living in ai-propose.mjs: these
// rules are the only thing standing between a hallucinating model and the
// manifest. If each producer carried its own copy, they would drift — and the
// drift would be invisible, because a producer that validates less strictly
// still "works", it just admits worse records. One gate, one vocabulary, and
// every rejection reason phrased identically no matter which model produced it.
//
// The gate is STATEFUL on purpose. Three of the rules are only expressible
// against accumulated state, not against a single proposal in isolation:
//   - node-set dedupe must see the manifest AND the records admitted so far,
//     or two proposals in the same reply can claim the same part twice
//   - isolation-vs-claimed must see every accepted record, or a batch that
//     re-claims its own earlier winner passes
//   - id allocation must see the ids already taken, or they collide
// So a producer creates one gate per reply and drives it proposal by proposal.
import { claimedNodeSet } from './manifest.mjs';

export const OPS = new Set(['new', 'split', 'merge', 'confirm']);
export const TYPES = new Set(['rotor', 'gimbal', 'hinge']);
export const MAX_PROPOSALS = 6;

export const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));

// Fence-tolerant extraction of the JSON array from a raw model reply. Shared
// because both producers face the same failure: a model that wraps its JSON in
// prose or code fences despite being told not to.
export function parseReply(reply) {
  const text = String(reply || '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const a = body.indexOf('[');
  const b = body.lastIndexOf(']');
  if (a < 0 || b <= a) return { items: [], warnings: ['no JSON array found in reply'] };
  try {
    const items = JSON.parse(body.slice(a, b + 1));
    if (!Array.isArray(items)) return { items: [], warnings: ['parsed value is not an array'] };
    return {
      items: items.slice(0, MAX_PROPOSALS),
      warnings: items.length > MAX_PROPOSALS ? [`truncated to ${MAX_PROPOSALS} proposals`] : [],
    };
  } catch (e) {
    return { items: [], warnings: [`JSON parse failed: ${e.message}`] };
  }
}

// Create one gate over a parse table + manifest.
//
// opts:
//   g, manifest      the world the proposals are judged against
//   idTag            id infix: 'l2' for text, 'vis' for vision — so a reader can
//                    tell which producer wrote a record from its id alone
//   label            (type) => human label
//   evidenceTag      first entry of `evidence`, naming the producer
//   baseConfidence   the confidence EVERY admitted record starts at
//   origin           'L2-ai' | 'L2-vision'
//   allowOps         which ops this producer may use (merge is refused by both)
export function createProposalGate({
  g, manifest, idTag = 'l2', label = (t) => `${t} (AI proposal)`,
  evidenceTag = 'l2-batch', baseConfidence = 0.7, origin = 'L2-ai',
  allowOps = ['new', 'split', 'confirm'],
} = {}) {
  const records = [];
  const confirms = [];
  const warnings = [];

  const nodeNames = new Set((g?.nodes || []).map((n) => n.name));
  const claimed = claimedNodeSet(manifest);
  const byId = new Map((manifest || []).map((r) => [r.id, r]));
  const taken = new Set(byId.keys());
  const setKey = (ids) => [...ids].sort().join('');
  // Content dedupe against the manifest, so a reopened run does not re-admit a
  // joint that already exists under a different id.
  const seen = new Set((manifest || []).map((r) => setKey(r.nodes)));
  const allow = new Set(allowOps);

  function drop(idx, why) {
    warnings.push(`proposal[${idx}] dropped: ${why}`);
    return null;
  }

  // Admit one parsed proposal. `names` is the node set the producer resolved —
  // for the text producer that is `p.nodeIds` verbatim; for the vision producer
  // it is the output of grounding.mjs, because that model never names nodes.
  // Returns 'record' | 'confirm' | null (dropped, reason already in warnings).
  //
  // `extra` carries producer-specific fields (reasoning, uncertainties,
  // suggestView, grounding provenance). It is spread BEFORE the protected
  // invariants below, so no producer can smuggle in a different confidence,
  // status or node list. That ordering is the enforcement of the rule that a
  // model's self-reported confidence never writes rec.confidence.
  function admit(p, idx, { names = null, extra = null } = {}) {
    if (!p || typeof p !== 'object') return drop(idx, 'not an object');
    if (!OPS.has(p.op)) return drop(idx, `unknown op "${p.op}"`);
    if (!allow.has(p.op)) {
      return drop(idx, p.op === 'merge'
        ? `op "merge" is not supported in phase ${idTag === 'vis' ? 3 : 2}`
        : `op "${p.op}" is not supported by this producer`);
    }
    if (!byId.has(p.targetId) && p.op !== 'new') return drop(idx, `op "${p.op}" needs a valid targetId`);

    if (p.op === 'confirm') {
      confirms.push({ targetId: p.targetId, rationale: String(p.rationale || p.reasoning || '') });
      return 'confirm';
    }

    if (!TYPES.has(p.type)) return drop(idx, `unknown type "${p.type}"`);

    const nodes = names || p.nodeIds;
    if (!Array.isArray(nodes) || !nodes.length) return drop(idx, 'nodeIds missing/empty');
    const unknown = nodes.filter((n) => !nodeNames.has(n));
    if (unknown.length) return drop(idx, `unknown nodes: ${unknown.join(', ')}`);

    const key = setKey(nodes);
    if (seen.has(key)) return drop(idx, 'duplicate of an existing record (same node set)');

    if (!vec3(p.axis)) return drop(idx, 'axis must be [x,y,z] of finite numbers');
    if (!vec3(p.anchor)) return drop(idx, 'anchor must be [x,y,z] of finite numbers');

    if (p.op === 'new') {
      const clash = nodes.filter((n) => claimed.has(n));
      if (clash.length) return drop(idx, `claims already-claimed nodes: ${clash.join(', ')} (use op:"split")`);
    } else { // split
      const target = byId.get(p.targetId);
      const outside = nodes.filter((n) => !target.nodes.includes(n));
      if (outside.length) return drop(idx, `split nodes not in ${p.targetId}: ${outside.join(', ')}`);
      if (nodes.length >= target.nodes.length) return drop(idx, 'split must be a proper subset of the target');
    }

    let id = `${p.type}_${idTag}_${idx}`;
    for (let n = 1; taken.has(id); n += 1) id = `${p.type}_${idTag}_${idx}_${n}`;
    taken.add(id);
    seen.add(key);

    // `extra.evidence` is appended rather than replacing: the producer tag is
    // always first, so a record's provenance cannot be overwritten by the model
    // that produced it.
    const extraEv = Array.isArray(extra?.evidence) ? extra.evidence.map((e) => String(e).slice(0, 160)) : [];
    records.push({
      id,
      label: label(p.type),
      type: p.type,
      ...(extra || {}),
      nodes: [...nodes],
      anchor: { x: p.anchor[0], y: p.anchor[1], z: p.anchor[2] },
      axis: { x: p.axis[0], y: p.axis[1], z: p.axis[2] },
      evidence: [evidenceTag, ...extraEv, ...(p.rationale ? [String(p.rationale).slice(0, 120)] : [])],
      confidence: baseConfidence,
      origin,
      splitFrom: p.op === 'split' ? p.targetId : undefined,
      tests: [],
      status: 'candidate',
      history: [],
    });
    return 'record';
  }

  return {
    records, confirms, warnings, admit, drop,
    byId, claimed, nodeNames, setKey,
    has: (id) => byId.has(id),
    get: (id) => byId.get(id),
    isClaimed: (n) => claimed.has(n),
    isDupSet: (ids) => seen.has(setKey(ids)),
    reserve: (ids) => seen.add(setKey(ids)),
  };
}

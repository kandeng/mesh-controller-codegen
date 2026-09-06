// L2 producer — turns one batched LLM reply into validated candidate records.
// PURE: the LLM call itself is injected by the caller (kernel wires the DSH
// supervisor; tests inject canned replies). Proposals NEVER touch statuses —
// they enter the manifest as candidates at L2_BASE_CONFIDENCE and only the
// deterministic battery can corroborate them upward (see loop.mjs).
//
// Confidence rule (phase 2): base 0.70. After the battery, the loop bumps to
// 0.80 ONLY if every test passed with zero warn-level failures (auto-accept
// possible — physics corroborated), 0.75 if warnings remain (needs-verdict).
// An AI proposal can never auto-accept on AI say-so alone.
import { claimedNodeSet } from './manifest.mjs';

export const L2_BASE_CONFIDENCE = 0.7;

const OPS = new Set(['new', 'split', 'merge', 'confirm']);
const TYPES = new Set(['rotor', 'gimbal', 'hinge']);
const MAX_PROPOSALS = 6;

// Fence-tolerant extraction of the JSON array from a raw LLM reply.
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
    return { items: items.slice(0, MAX_PROPOSALS), warnings: items.length > MAX_PROPOSALS ? [`truncated to ${MAX_PROPOSALS} proposals`] : [] };
  } catch (e) {
    return { items: [], warnings: [`JSON parse failed: ${e.message}`] };
  }
}

const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));

// Validate the parsed reply against the graph + manifest claims.
// Returns { records, confirms, warnings }:
//   records  — candidate manifest records (ops new/split)
//   confirms — [{ targetId, rationale }] corroborations for existing records
export function aiPropose({ reply, g, manifest }) {
  const { items, warnings } = parseReply(reply);
  const records = [];
  const confirms = [];
  const nodeNames = new Set(g.nodes.map((n) => n.name));
  const claimed = claimedNodeSet(manifest);
  const byId = new Map((manifest || []).map((r) => [r.id, r]));
  const taken = new Set(byId.keys());
  const setKey = (ids) => [...ids].sort().join('');
  const seen = new Set((manifest || []).map((r) => setKey(r.nodes))); // content dedupe

  items.forEach((p, idx) => {
    const bad = (why) => warnings.push(`proposal[${idx}] dropped: ${why}`);
    if (!p || typeof p !== 'object') return bad('not an object');
    if (!OPS.has(p.op)) return bad(`unknown op "${p.op}"`);
    if (!byId.has(p.targetId)) {
      if (p.op !== 'new') return bad(`op "${p.op}" needs a valid targetId`);
    }
    if (p.op === 'merge') return bad('op "merge" is not supported in phase 2');

    if (p.op === 'confirm') {
      confirms.push({ targetId: p.targetId, rationale: String(p.rationale || '') });
      return;
    }

    if (!TYPES.has(p.type)) return bad(`unknown type "${p.type}"`);
    if (!Array.isArray(p.nodeIds) || !p.nodeIds.length) return bad('nodeIds missing/empty');
    const unknown = p.nodeIds.filter((n) => !nodeNames.has(n));
    if (unknown.length) return bad(`unknown nodes: ${unknown.join(', ')}`);
    const key = setKey(p.nodeIds);
    if (seen.has(key)) return bad('duplicate of an existing record (same node set)');
    if (!vec3(p.axis)) return bad('axis must be [x,y,z] of finite numbers');
    if (!vec3(p.anchor)) return bad('anchor must be [x,y,z] of finite numbers');

    if (p.op === 'new') {
      const clash = p.nodeIds.filter((n) => claimed.has(n));
      if (clash.length) return bad(`claims already-claimed nodes: ${clash.join(', ')} (use op:"split")`);
    } else { // split
      const target = byId.get(p.targetId);
      const outside = p.nodeIds.filter((n) => !target.nodes.includes(n));
      if (outside.length) return bad(`split nodes not in ${p.targetId}: ${outside.join(', ')}`);
      if (p.nodeIds.length >= target.nodes.length) return bad('split must be a proper subset of the target');
    }

    let id = `${p.type}_l2_${idx}`;
    for (let n = 1; taken.has(id); n += 1) id = `${p.type}_l2_${idx}_${n}`;
    taken.add(id);
    seen.add(key);
    records.push({
      id,
      label: `${p.type} (AI proposal)`,
      type: p.type,
      nodes: [...p.nodeIds],
      anchor: { x: p.anchor[0], y: p.anchor[1], z: p.anchor[2] },
      axis: { x: p.axis[0], y: p.axis[1], z: p.axis[2] },
      evidence: ['l2-batch', ...(p.rationale ? [String(p.rationale).slice(0, 120)] : [])],
      confidence: L2_BASE_CONFIDENCE,
      origin: 'L2-ai',
      splitFrom: p.op === 'split' ? p.targetId : undefined,
      tests: [],
      status: 'candidate',
      history: [],
    });
  });

  return { records, confirms, warnings };
}

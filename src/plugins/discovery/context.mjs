// Selective context slicer — the MoR-inspired prompt builder for the L2
// producer. Instead of dumping the whole node table (728 lines for the drone
// sample), it feeds only:
//   1. the ACTIVE region — nodes of uncertain (needs-verdict) records plus
//      every node not claimed by any record, and
//   2. validated records as one-line CONSTRAINT FACTS that subtract from the
//      search space ("these nodes are claimed — do not re-propose").
// Compute is routed proportional to residual uncertainty: auto-accepted
// regions cost the model zero tokens.
import { claimedNodeSet, constraintSummary } from './manifest.mjs';

// Compact table, same columns as dumpNodes (gltf.mjs), restricted to the
// active region: focus records' nodes + all unclaimed nodes. Claimed nodes
// outside the focus are excluded — their constraint lines already say why.
export function sliceNodeTable(g, { excludeIds = new Set(), focusIds = new Set() } = {}) {
  const lines = [];
  for (const n of g.nodes) {
    const claimed = excludeIds.has(n.name);
    if (claimed && !focusIds.has(n.name)) continue;
    const wp = n.wm ? `(${n.wm[12].toFixed(1)},${n.wm[13].toFixed(1)},${n.wm[14].toFixed(1)})` : '-';
    lines.push(
      `${n.i}\t${n.name}\tparent=${n.parent}\tkids=${n.children}\tmesh=${n.mesh}` +
      `\twxy=${n.wext ? `${n.wext.ex.toFixed(2)}x${n.wext.ey.toFixed(2)}x${n.wext.ez.toFixed(2)}` : '-'}` +
      `\twpos=${wp}\tr=${n.r.toFixed(1)}${claimed ? '\tCLAIMED-BY-FOCUS' : ''}`,
    );
  }
  return lines.join('\n');
}

// The full L2 prompt: role + output contract + pruning facts + sliced table.
export function buildProposalPrompt({ g, manifest, focusIds = new Set() }) {
  const claimed = claimedNodeSet(manifest);
  const constraints = constraintSummary(manifest);
  const table = sliceNodeTable(g, { excludeIds: claimed, focusIds });
  return [
    'You are L2, a hypothesis producer in a rigged-mesh joint-discovery loop.',
    'Propose movable joints (rotor/gimbal) over the mesh nodes below.',
    '',
    'Reply with JSON ONLY (no prose, no code fences): an array of at most 6 objects:',
    '[{ "op": "new|split|merge|confirm", "targetId": "<existing joint id, for split/merge/confirm>",',
   '   "nodeIds": ["<node names from the table>"],',
   '   "type": "rotor|gimbal", "axis": [x,y,z], "anchor": [x,y,z], "rationale": "..." }]',
    '',
    'Rules:',
    '- Use only node names that appear in the table below.',
    '- Nodes listed in VALIDATED CONSTRAINTS are claimed — do NOT re-propose them,',
    '  except through op:"split" with targetId naming the claiming joint.',
    '- anchor/axis are world-space (scene is Z-up: rotors spin about [0,0,1]).',
    '- Prefer few, well-supported proposals over many speculative ones.',
    '',
    constraints.length ? 'VALIDATED CONSTRAINTS (subtracted from the search space):' : 'VALIDATED CONSTRAINTS: (none yet)',
    ...constraints,
    '',
    `NODE TABLE (${table ? table.split('\n').length : 0} rows — active region only):`,
    'i\tname\tparent\tkids\tmesh\twext(world)\twpos(world)\tr',
    table,
  ].join('\n');
}

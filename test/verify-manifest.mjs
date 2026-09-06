// Manifest / L2-proposal / reopen-edge proof — phase 2 of the
// hypothesis-validation loop. Exit 0 only if every check passes:
//   1) reopen(): a falsified record regresses to needs-verdict with evidence
//   2) slicer: validated nodes leave the prompt table; constraints stay as facts
//   3) aiPropose: valid/malformed/isolation-violating/duplicate canned replies
//   4) runL2Round with a fake producer: gimbal split merges, battery re-runs
//   5) reopen state SURVIVES a subsequent refine round (resume semantics)
//
// Usage: node test/verify-manifest.mjs
import { parseGlb } from '../src/lib/gltf.mjs';
import { geometryDiscovery } from '../src/plugins/discovery/geometry.mjs';
import {
  buildManifest, claimedNodeSet, deriveStatus, reopen,
} from '../src/plugins/discovery/manifest.mjs';
import { buildProposalPrompt } from '../src/plugins/discovery/context.mjs';
import { aiPropose } from '../src/plugins/discovery/ai-propose.mjs';
import { runDiscoveryLoop, runL2Round } from '../src/plugins/discovery/loop.mjs';

const GLB = 'samples/drone_dji_inspire3.glb';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('\nProving manifest primitives + L2 round + reopen edge\n');

const g = await parseGlb(GLB);
const { joints } = await geometryDiscovery.api.discover(GLB, null);
const { manifest } = runDiscoveryLoop(g, joints, {});

// ---- 1) reopen edge ----------------------------------------------------------
{
  const rec = manifest.find((r) => r.status === 'auto-accepted');
  const nTests = rec.tests.length;
  reopen(rec, { name: 'rigidity-gate', detail: 'fake crack' }, 'test reopen');
  ok('reopen regresses status to needs-verdict', rec.status === 'needs-verdict');
  ok('reopen appends the failing test + history', rec.tests.length === nTests + 1
    && rec.tests.at(-1).name === 'rigidity-gate' && rec.tests.at(-1).pass === false
    && rec.history.some((h) => h.event === 'reopened'));
}

// Fresh manifest for slicing/proposal checks (rotors auto-accepted again).
const manifest2 = buildManifest(joints);
for (const r of manifest2) r.status = deriveStatus(r);
const claimed = claimedNodeSet(manifest2);
const freeNames = g.nodes.filter((n) => !claimed.has(n.name) && n.wext).slice(0, 2).map((n) => n.name);

// ---- 2) selective context slicer ----------------------------------------------
{
  const prompt = buildProposalPrompt({ g, manifest: manifest2 });
  const table = prompt.split('NODE TABLE')[1] || '';
  const rotorNode = manifest2.find((r) => r.type === 'rotor').nodes[0];
  ok('slicer emits constraint facts for validated records', prompt.includes('ACCEPTED(auto'));
  ok('validated nodes leave the node table (search space pruned)', !table.includes(`\t${rotorNode}\t`), rotorNode);
  ok('unclaimed nodes stay in the node table', table.includes(`\t${freeNames[0]}\t`), freeNames[0]);
}

// ---- 3) aiPropose validation ---------------------------------------------------
{
  const anchor = g.nodes.find((n) => n.name === freeNames[0]).wp;
  const good = JSON.stringify([{
    op: 'new', nodeIds: freeNames, type: 'hinge', axis: [0, 0, 1],
    anchor: [anchor[0], anchor[1], anchor[2]], rationale: 'unit test',
  }]);
  const r1 = aiPropose({ reply: good, g, manifest: manifest2 });
  ok('valid proposal becomes a candidate at base confidence', r1.records.length === 1
    && r1.records[0].status === 'candidate' && r1.records[0].confidence === 0.7
    && r1.records[0].origin === 'L2-ai', r1.records[0]?.id);

  const r2 = aiPropose({ reply: '[{"op": "new", ', g, manifest: manifest2 });
  ok('malformed reply → no records, warning raised', r2.records.length === 0 && r2.warnings.length > 0);

  const r3 = aiPropose({
    reply: JSON.stringify([{ op: 'new', nodeIds: [freeNames[0], 'NoSuchNode'], type: 'hinge', axis: [0, 0, 1], anchor: [0, 0, 0] }]),
    g, manifest: manifest2,
  });
  ok('unknown node ids are rejected', r3.records.length === 0 && r3.warnings.some((w) => w.includes('unknown nodes')));

  const rotorNodes = manifest2.find((r) => r.type === 'rotor').nodes;
  const r4 = aiPropose({
    reply: JSON.stringify([{ op: 'new', nodeIds: rotorNodes, type: 'rotor', axis: [0, 0, 1], anchor: [0, 0, 0] }]),
    g, manifest: manifest2,
  });
  ok('isolation violation rejected (claimed nodes, op:new)', r4.records.length === 0
    && r4.warnings.some((w) => w.includes('already-claimed') || w.includes('duplicate')));

  const fenced = aiPropose({ reply: `Here you go:\n\`\`\`json\n${good}\n\`\`\``, g, manifest: manifest2 });
  ok('fenced replies parse (record would duplicate → dropped, but parsed)', fenced.warnings.some((w) => w.includes('duplicate')) || fenced.records.length === 1);
}

// ---- 4) runL2Round with a fake producer: gimbal split --------------------------
{
  const gimbal = manifest2.find((r) => r.type === 'gimbal');
  const subset = gimbal.nodes.slice(0, 2);
  const before = gimbal.nodes.length;
  const nManifest = manifest2.length;
  const reply = JSON.stringify([{
    op: 'split', targetId: gimbal.id, nodeIds: subset, type: 'gimbal',
    axis: [gimbal.axis.x, gimbal.axis.y, gimbal.axis.z],
    anchor: [gimbal.anchor.x, gimbal.anchor.y, gimbal.anchor.z],
    rationale: 'camera sub-unit',
  }]);
  const res = await runL2Round(g, joints, manifest2, async () => reply);
  const rec = manifest2.find((r) => r.origin === 'L2-ai');
  ok('split proposal merges as one new candidate', res.added === 1 && manifest2.length === nManifest + 1, rec?.id);
  ok('split subtracts nodes from the target record', gimbal.nodes.length === before - 2
    && gimbal.history.some((h) => h.event === 'split-off'));
  ok('battery re-ran on the proposal (isolation holds)', !!rec
    && rec.tests.some((t) => t.name === 'isolation' && t.pass));
  ok('corroboration sets confidence by physics, not by the model', !!rec
    && [0.7, 0.75, 0.8].includes(rec.confidence), `conf=${rec?.confidence} status=${rec?.status}`);
}

// ---- 5) reopen survives a later refine round -----------------------------------
{
  const reopened = manifest.find((r) => r.history.some((h) => h.event === 'reopened'));
  const res = await runL2Round(g, joints, manifest, async () => '[]');
  ok('empty refine adds nothing', res.added === 0);
  ok('reopened record stays needs-verdict with its history', reopened.status === 'needs-verdict'
    && reopened.history.some((h) => h.event === 'reopened')
    && reopened.tests.some((t) => t.name === 'rigidity-gate' && !t.pass));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('MANIFEST_PROBE_OK');

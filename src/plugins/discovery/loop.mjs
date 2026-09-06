// Discovery loop — the hypothesis-testing + human-verdict + graph-based-loop
// architecture. Per the strangler-fig decision, the existing geometry
// heuristics are the L1 producer; this loop wraps them in the manifest state
// machine and runs the deterministic test battery.
//
// Phase 1 (runDiscoveryLoop): L1 hypotheses → manifest → rest-pose tests →
// deriveStatus → persist. Phase 2 (runL2Round): ONE bounded AI-proposal round
// over the needs-verdict frontier, on the EXISTING manifest — reopen state
// and history survive. Split descent (L3) and verdicts remain phase 3.
import {
  AUTO_ACCEPT_CONFIDENCE, applyManifest, buildManifest, deriveStatus, reopen, saveManifest,
} from './manifest.mjs';
import { attachmentSanity, discCoherence, isolation } from './tests.mjs';
import { buildProposalPrompt } from './context.mjs';
import { aiPropose } from './ai-propose.mjs';

function runBattery(g, joints, recs) {
  const iso = isolation(joints); // cross-joint test — same verdict for all
  for (const rec of recs) {
    const joint = joints.find((j) => j.id === rec.id);
    rec.tests.push(discCoherence(g, joint));
    rec.tests.push({ ...iso });
    rec.tests.push(attachmentSanity(g, joint));
  }
}

export function runDiscoveryLoop(g, joints, { runDir = null } = {}) {
  const manifest = buildManifest(joints);
  const frontier = [...manifest]; // BFS frontier — phase 1: depth 0 only
  const producers = { L2: [], L3: [] }; // filled by runL2Round / phase 3

  runBattery(g, joints, frontier);
  for (const rec of frontier) rec.status = deriveStatus(rec);

  applyManifest(joints, manifest);
  const file = saveManifest(runDir, manifest);
  return { manifest, frontier, producers, file };
}

// Phase 2: one L2 round. `l2` is an injected async (prompt) => reply callable
// (kernel wires the DSH supervisor; tests inject canned replies). Proposals
// merge as candidates; only deterministic corroboration lifts a proposal to
// auto-accept (0.80, zero warnings) — never the model's own say-so.
export async function runL2Round(g, joints, manifest, l2) {
  const warnings = [];
  const uncertain = manifest.filter((r) => r.status === 'needs-verdict');
  if (!uncertain.length) return { added: 0, reason: 'frontier empty', warnings };

  let parsed;
  try {
    const focusIds = new Set(uncertain.flatMap((r) => r.nodes));
    const prompt = buildProposalPrompt({ g, manifest, focusIds });
    parsed = aiPropose({ reply: await l2(prompt), g, manifest });
  } catch (e) {
    return { added: 0, warnings: [`L2 round failed (manifest untouched): ${e.message}`] };
  }
  const { records, confirms } = parsed;
  warnings.push(...parsed.warnings);

  // Confirms are evidence only — capped below the auto-accept threshold so an
  // AI corroboration can never flip a record to auto-accepted by itself.
  for (const c of confirms) {
    const t = manifest.find((r) => r.id === c.targetId);
    if (!t) continue;
    t.evidence.push('l2-confirm');
    t.confidence = Math.min(AUTO_ACCEPT_CONFIDENCE - 0.01, t.confidence + 0.05);
    t.status = deriveStatus(t);
  }

  // Splits subtract the claimed subset from the target (manifest AND joint),
  // keeping the isolation test meaningful for the new candidate.
  const affected = new Set();
  for (const rec of records) {
    if (rec.splitFrom) {
      const t = manifest.find((r) => r.id === rec.splitFrom);
      const tj = joints.find((j) => j.id === rec.splitFrom);
      if (t) {
        t.nodes = t.nodes.filter((n) => !rec.nodes.includes(n));
        t.history.push({ at: new Date().toISOString(), event: 'split-off', note: `${rec.nodes.length} nodes → ${rec.id}` });
        affected.add(t.id);
      }
      if (tj) tj.nodes = tj.nodes.filter((n) => !rec.nodes.includes(n));
    }
    joints.push({ ...rec }); // joint-shaped view for the battery + UI
    manifest.push(rec);
  }

  const retest = [...records, ...manifest.filter((r) => affected.has(r.id))];
  if (retest.length) {
    runBattery(g, joints, retest);
    for (const rec of records) {
      const fails = rec.tests.some((t) => t.level !== 'warn' && !t.pass);
      const warns = rec.tests.some((t) => t.level === 'warn' && !t.pass);
      rec.confidence = fails ? 0.7 : warns ? 0.75 : 0.8; // physics disposes
    }
    for (const rec of retest) rec.status = deriveStatus(rec);
  }

  applyManifest(joints, manifest);
  return { added: records.length, proposals: records.map((r) => r.id), warnings };
}

// Reopen edge, controller stage: map each failing declared motion set to the
// ONE manifest record it best overlaps (unambiguous max only — ambiguity is
// reported, never guessed) and regress that record with the failing evidence.
export function reopenFromRigidity(manifest, rigidity) {
  const reopened = [];
  const skipped = [];
  for (const res of (rigidity?.results || []).filter((x) => !x.pass)) {
    const names = new Set(res.names || []);
    if (!names.size) { skipped.push(`${res.set}: no member names`); continue; }
    let best = null; let second = 0;
    for (const rec of manifest) {
      const hit = (rec.nodes || []).filter((n) => names.has(n)).length;
      if (hit > (best?.hit || 0)) { second = best?.hit || 0; best = { rec, hit }; }
      else if (hit > second) second = hit;
    }
    if (!best || best.hit === 0 || best.hit === second) { skipped.push(`${res.set}: ambiguous/unmapped`); continue; }
    if (best.rec.tests.some((t) => t.name === 'rigidity-gate' && !t.pass)) { skipped.push(`${res.set}: already reopened`); continue; }
    reopen(best.rec, {
      name: 'rigidity-gate',
      detail: `set "${res.set}": ${(res.offenders || []).map((o) => o.name).slice(0, 4).join(', ') || 'relative-pose invariance failed'}`,
    }, `controller set "${res.set}" cracked under motion`);
    reopened.push(best.rec.id);
  }
  return { reopened, skipped };
}

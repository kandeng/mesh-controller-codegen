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
//
// The validation rules themselves live in propose-core.mjs and are SHARED with
// the vision producer. This file is now only the text producer's own concern:
// it reads nodeIds off the reply, because a text model is handed real names.
import { createProposalGate, parseReply } from './propose-core.mjs';

export { parseReply };
export const L2_BASE_CONFIDENCE = 0.7;

// Validate the parsed reply against the graph + manifest claims.
// Returns { records, confirms, warnings }:
//   records  — candidate manifest records (ops new/split)
//   confirms — [{ targetId, rationale }] corroborations for existing records
export function aiPropose({ reply, g, manifest }) {
  const gate = createProposalGate({
    g,
    manifest,
    idTag: 'l2',
    label: (t) => `${t} (AI proposal)`,
    evidenceTag: 'l2-batch',
    baseConfidence: L2_BASE_CONFIDENCE,
    origin: 'L2-ai',
  });
  // Parse warnings go first, matching the pre-refactor ordering, so a reader
  // sees "the reply was truncated" before the per-proposal drops it caused.
  const { items, warnings } = parseReply(reply);
  gate.warnings.push(...warnings);

  items.forEach((p, idx) => gate.admit(p, idx));

  return { records: gate.records, confirms: gate.confirms, warnings: gate.warnings };
}

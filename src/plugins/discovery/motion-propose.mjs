// Motion propose — turns ONE multi-image VLM reply about a driven joint into a
// semantic assessment. Phase 3, task 18.
//
// The asymmetry with vision-propose is the whole design, and it is the same
// asymmetry as between the two prompts:
//
//   vision-propose  resolves a POINTED-AT region into node names and creates or
//                   splits records, because discovery has not happened yet. It
//                   leans on grounding.mjs and the proposal gate.
//   motion-propose  creates NOTHING and grounds NOTHING. The joint already exists
//                   and its geometry is already measured. It reads a single-object
//                   judgement ("what is this thing, is the motion sensible") and
//                   folds it into an ASSESSMENT the loop attaches to the record.
//
// So there is no gate here and no confidence write. The trust rules that matter
// are different and smaller:
//   - `observedType` must be one of our four words or it is dropped, not guessed.
//   - `motionSensible` is coerced to a REAL boolean or to null — and null means
//     "the model did not say", which must NEVER be silently read as "insensible".
//     Turning an honest "I cannot tell" into a negative finding would be worse than
//     no finding, because a human would then review a joint the model never doubted.
//   - `agreesWithType` is COMPUTED here, never trusted from the model: comparing
//     two strings is exactly the kind of trivial step a model gets inconsistently
//     right, and this agreement is the entire signal the turn exists to produce.
//
// `confidence` from the model is carried as `modelConfidence` for ROUTING only, the
// same discipline as vision: it never becomes a record's confidence.

export const MOTION_TYPES = new Set(['rotor', 'gimbal', 'hinge', 'static']);

// Fence-tolerant extraction of ONE object from a raw reply. The prompt asks for a
// single object, but a model told "one object" still sometimes wraps it in an array
// or pads it with prose, so both are tolerated. `parseReply` (shared with the other
// producers) only knows how to pull an ARRAY out, and re-using it here would mean
// asking for `[{...}]` and then taking element 0 — a shape the model is more likely
// to get wrong than the bare object the question actually implies.
export function parseMotionReply(reply) {
  const text = String(reply || '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;

  // Object-braces first: for the common `[{...}]` wrap this slice is already the
  // bare inner object, so the array fallback is only reached for genuinely odd
  // shapes (several objects, or a top-level array of scalars).
  const candidates = [];
  const oa = body.indexOf('{'); const ob = body.lastIndexOf('}');
  if (oa >= 0 && ob > oa) candidates.push(body.slice(oa, ob + 1));
  const aa = body.indexOf('['); const ab = body.lastIndexOf(']');
  if (aa >= 0 && ab > aa) candidates.push(body.slice(aa, ab + 1));

  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { item: v, warnings: [] };
      if (Array.isArray(v)) {
        const first = v.find((x) => x && typeof x === 'object' && !Array.isArray(x));
        if (first) return { item: first, warnings: ['reply was an array; assessed its first object'] };
      }
    } catch { /* try the next candidate slice */ }
  }
  return { item: null, warnings: ['no JSON object found in reply'] };
}

// Coerce a model's "is it sensible" to a real boolean WITHOUT inventing one. Any
// value that is not unmistakably affirmative or negative becomes null (unknown),
// because the cost of a false negative — a human dragged in to review a joint the
// model never actually doubted — is higher than the cost of "unknown".
function boolish(v) {
  if (typeof v === 'boolean') return v;
  if (v === 1) return true;
  if (v === 0) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'yes', 'y', 'sensible', 'correct', 'ok'].includes(s)) return true;
    if (['false', 'no', 'n', 'insensible', 'incorrect', 'wrong'].includes(s)) return false;
  }
  return null;
}

// Read one reply into an assessment of one existing joint.
//
// in:  { reply, joint }  joint is the record being characterised ({ id, type }).
// out: { assessment, warnings }  assessment is null when the reply carried no
//      usable object, so the caller can tell "the model said nothing parseable"
//      from "the model said the motion is fine".
export function motionAssess({ reply, joint = null } = {}) {
  const warnings = [];
  const { item, warnings: parseWarnings } = parseMotionReply(reply);
  warnings.push(...parseWarnings);
  if (!item) return { assessment: null, warnings };

  const claimedType = joint?.type || null;

  let observedType = null;
  if (item.observedType != null) {
    const t = String(item.observedType).trim().toLowerCase();
    if (MOTION_TYPES.has(t)) observedType = t;
    else warnings.push(`observedType "${item.observedType}" is not one of rotor|gimbal|hinge|static; ignored`);
  } else {
    warnings.push('reply gave no observedType');
  }

  const motionSensible = boolish(item.motionSensible);
  if (item.motionSensible != null && motionSensible === null) {
    warnings.push(`motionSensible "${item.motionSensible}" was not a clear boolean; recorded as unknown, NOT as insensible`);
  }

  // Computed, never trusted: see the file header. null when either side is unknown,
  // so "we cannot compare" is distinct from "they disagree".
  const agreesWithType = (observedType && claimedType) ? (observedType === claimedType) : null;

  const label = item.label != null ? String(item.label).slice(0, 120) : null;
  const reasoning = item.reasoning != null ? String(item.reasoning).slice(0, 480) : null;
  const uncertainties = Array.isArray(item.uncertainties)
    ? item.uncertainties.map((u) => String(u).slice(0, 240)).filter(Boolean).slice(0, 8)
    : [];
  // ROUTING ONLY — never folded into a record's confidence (see header).
  const modelConfidence = Number.isFinite(item.confidence)
    ? Math.max(0, Math.min(1, Number(item.confidence)))
    : null;

  // The human-readable distillation. A motion that looks wrong, a type that
  // disagrees with what we claimed, or nothing moving at all is exactly what a
  // human verdict (task 17) should be pointed at — so these are surfaced as
  // concerns rather than acted on automatically.
  const concerns = [];
  if (motionSensible === false) concerns.push('the model judged the motion NOT sensible');
  if (agreesWithType === false) concerns.push(`the motion looks like a ${observedType}, but the joint is claimed as a ${claimedType}`);
  if (observedType === 'static') concerns.push('nothing appeared to move between the frames');

  return {
    assessment: {
      label,
      observedType,
      claimedType,
      agreesWithType,
      motionSensible,
      reasoning,
      uncertainties,
      modelConfidence,
      concerns,
    },
    warnings,
  };
}

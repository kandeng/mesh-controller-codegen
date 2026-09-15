// Category expectation — a lane that AIMS and CHECKS, and never merges.
//
// The question this answers is the one a coverage-driven planner cannot ask:
// "what machine is this, and where does a machine like this keep its joints?"
// Coverage picks frames by marginal gain over a kd-tree of parts, which is the
// right answer to "what have we not seen" and no answer at all to "what are we
// looking at". A quadrotor keeps its joints at four arm tips and its nose; a
// tank keeps theirs along both hull flanks and on a turret ring. Saying that out
// loud, before the discovery turn, buys three concrete things:
//
//   1. AIM. Round 2's close-ups come from `suggestView` sentences alone today.
//      An expectation whose instances have NOT been grounded is a list of places
//      worth a frame, resolved to real geometry by views.mjs.
//   2. A NUMBER TO FALSIFY. `expectationGap` compares what a category says
//      should be there against what actually grounded. "expected 4 rotors,
//      grounded 3" is a discrepancy a human can act on, and it feeds the
//      symmetry machinery that amortizes one verdict across a family.
//   3. VOCABULARY. The IR only expresses rotor|gimbal|hinge. A turret is a
//      gimbal and a road wheel is a rotor, but nothing in the geometry says so;
//      a category prior is what maps an unknown machine onto those three words.
//
// AND ONE HARD BOUNDARY, which is the whole reason this is its own module:
// there is NO path from here to mergeProposals. Nothing this file returns can
// become a manifest record. An expectation is a hypothesis the discovery turn is
// asked to falsify with a locator, and the only things that ever reach the
// manifest are proposals that grounding resolved and the physics battery scored.
// A guess that could mint a joint would be a hallucination with extra steps —
// the model's own confidence in the category is not evidence about this mesh.
//
// Pure: builds a prompt, parses a reply, compares counts. The transport is the
// same `propose` effect the discovery turn uses, so this is testable headless.
import { normBox } from './grounding.mjs';
import { TYPES } from './propose-core.mjs';
import { CATEGORY_KEYS } from './actuator-dictionary.mjs';
import { frameLine, sceneFacts, sceneHeader } from './vision-prompt.mjs';

// One turn over the survey photos. Bounded for the same reason the discovery turn
// is: an unbounded image list turns one cheap prior into the most expensive part
// of the round, and a category does not need twelve looks to name itself.
export const MAX_EXPECTATION_FRAMES = 6;
// Below this the prior is not worth aiming with. Not a quality judgement about
// the model — a low-confidence category is a coin flip, and aiming a scarce
// round-2 budget at a coin flip is worse than leaving coverage to decide.
export const MIN_EXPECTATION_CONFIDENCE = 0.5;
export const MAX_EXPECTATION_INSTANCES = 12;
export const MAX_CATEGORY_CHARS = 120;
// One instance may claim this many of a type. Beyond it the number is a
// transcription error (40 rotors on a quadrotor) rather than a category fact.
export const MAX_INSTANCE_COUNT = 32;
// How much of an expectation's box the discovery turn's grounded box must cover
// before that instance counts as VERIFIED — i.e. before we stop aiming at it.
export const MIN_VERIFY_OVERLAP = 0.5;

// The frames a category is read from: whole-machine opaque photos, preferring the
// survey tier the planner forced. A colorId mask is abstract art at that scale and
// a ghost invites a description of the render, so neither is offered; a `solo`
// frame shows one sub-assembly and cannot name a machine.
export function surveyPhotos(frames = []) {
  const photos = (frames || []).filter((f) => f?.dataBase64 && (f.mode || 'photo') === 'photo');
  // 'panel' frames are survey-class: whole-machine looks at the human's own
  // distance/FOV, exactly the frames a category can honestly be read from.
  const survey = photos.filter((f) => f.spec?.kind === 'survey' || f.spec?.kind === 'panel');
  return survey.length ? survey : photos;
}

// Build the category turn. Same image shape agent.send() wants, and the same
// locator contract as the discovery prompt — because an instance that cannot be
// pointed at cannot be aimed at either, and the two turns must agree on what
// "pointing" means for `regionsFromExpectations` to resolve anything.
export function buildExpectationPrompt({ frames = [], g = null, viewport = null, maxFrames = MAX_EXPECTATION_FRAMES } = {}) {
  const warnings = [];
  const cap = Math.max(1, maxFrames | 0);
  const wanted = surveyPhotos(frames);
  if (!wanted.length) {
    return { text: null, images: [], frames: [], warnings: ['no whole-machine photo frame to read a category from'] };
  }
  if (wanted.length > cap) warnings.push(`truncated ${wanted.length} survey frames to ${cap}`);
  const used = wanted.slice(0, cap);

  const lines = [];
  lines.push('You are the CATEGORY PRIOR step of a rigged-mesh joint-discovery loop.');
  lines.push('You are looking at RENDERED FRAMES of one 3D CAD assembly, drawn by us from an');
  lines.push('omni survey of poses we chose: the six orthographic looks — four eye-level side');
  lines.push('views 90\u00b0 apart, plus, where they are listed, a true top-down and a true');
  lines.push('bottom-up. Which side view is "front" is for YOU to decide from the machine.');
  lines.push('They are not photographs — there is no lighting realism and no branding.');
  lines.push('');
  lines.push(...sceneHeader(sceneFacts(g, viewport, used)));
  lines.push('');
  lines.push('TASK: first say WHAT KIND OF MACHINE this is. Then say which parts a machine of');
  lines.push('that kind usually has that MOVE RELATIVE TO THE REST, how many of each, and where');
  lines.push('in these frames each kind of place is.');
  lines.push('');
  lines.push('Naming the category: our reference table knows these kinds —');
  lines.push(`  ${CATEGORY_KEYS.join(', ')}`);
  lines.push('If this machine is one of them, use THAT word so the table\'s counts apply. If it is');
  lines.push('none of them, name it plainly anyway — a true unknown beats a forced match.');
  lines.push('');
  lines.push('READ THIS BEFORE ANSWERING — it is what makes the step safe:');
  lines.push('You are describing a CATEGORY, not this mesh. Every expectation you give is checked');
  lines.push('against what is actually visible by a later step, and an expectation is NEVER a');
  lines.push('discovery: nothing you write here becomes a joint. What it does is aim a camera and');
  lines.push('give the next step a count to falsify, so be specific about WHERE and HOW MANY, and');
  lines.push('be specific about what you are NOT sure of.');
  lines.push('');
  lines.push('Motion vocabulary — the only three kinds the loop downstream can express:');
  lines.push('  rotor  - spins continuously about one axis (propeller, fan, road wheel, rotor head)');
  lines.push('  gimbal - pivots about a point over a limited range (camera mount, turret, boom)');
  lines.push('  hinge  - rotates about an axis over a limited range (folding arm, landing gear,');
  lines.push('           control surface, bay door, hatch)');
  lines.push('A continuous track, a sliding hatch or a telescoping leg has no exact match: report');
  lines.push('the nearest expressible kind (a track\'s road wheels are rotors) and say in "doubts"');
  lines.push('that the real motion is not expressible. Do not invent a fourth kind.');
  lines.push('');
  lines.push('HOW TO POINT AT A PLACE (same contract as the discovery step):');
  lines.push('You do NOT know our internal part names and you must NOT invent them. Instead give');
  lines.push('  "frameId"   - which frame below shows the place (use the exact id)');
  lines.push('  "regionBox" - [x0, y0, x1, y1] as FRACTIONS of that frame, 0..1, origin at the');
  lines.push('                TOP-LEFT, y increasing DOWNWARD, tight around the place');
  lines.push('');
  lines.push('Reply with JSON ONLY (no prose, no code fences), ONE object:');
  lines.push('{ "category": "short machine category, e.g. quadrotor drone / main battle tank / robotic arm",');
  lines.push('  "confidence": 0.0-1.0,');
  lines.push('  "summary": "one sentence: what it is and what moves on it",');
  lines.push('  "instances": [');
  lines.push('    { "type": "rotor|gimbal|hinge", "count": <how many a machine like this has>,');
  lines.push('      "frameId": "<a frame below>", "regionBox": [x0,y0,x1,y1],');
  lines.push('      "symmetry": "how they are arranged, e.g. 4-fold about the vertical, one per arm');
  lines.push('                  tip / left-right mirror along the hull",');
  lines.push('      "note": "what the moving group is, and why it moves" } ],');
  lines.push('  "doubts": ["what you are NOT sure about, stated plainly"],');
  lines.push('  "alternatives": ["at least one other category this could be, and what would settle it"] }');
  lines.push('');
  lines.push('Rules:');
  lines.push('- ONE instance entry per KIND of moving part, with "count" saying how many. Not one');
  lines.push('  entry per part: four rotors are one entry with count 4.');
  lines.push('- "regionBox" must point at a place actually visible in the frame you name. If a kind');
  lines.push('  of part is NOT visible in any frame (a hull-hidden suspension, an internal gearbox),');
  lines.push('  still report it, box the region that HIDES it, and say so in "doubts".');
  lines.push('- Give the count a machine of this category really has. If you do not know, say so in');
  lines.push('  "doubts" and give your best count anyway: a wrong count gets checked, a missing one');
  lines.push('  does not.');
  lines.push('- Name at least one ALTERNATIVE category. A prior that cannot imagine being wrong is');
  lines.push('  not a hypothesis.');
  lines.push('- Never describe the render itself (transparency, colours, grid, background). Describe');
  lines.push('  the MACHINE.');
  lines.push('- An empty "instances" array is a valid answer when you cannot tell what the machine');
  lines.push('  is, and is far better than a confident guess.');
  lines.push('');
  lines.push(`FRAMES (${used.length} attached, in order):`);
  used.forEach((f, i) => lines.push(`  ${frameLine(f, i)}`));

  const images = [];
  for (const f of used) {
    if (!f.dataBase64) { warnings.push(`frame ${f.id} has no image bytes; described in text but not attached`); continue; }
    images.push({ mediaType: f.mediaType || 'image/png', dataBase64: f.dataBase64, name: String(f.id) });
  }
  if (!images.length) warnings.push('no survey frame carried image bytes - no category can be read from text alone');

  return {
    text: images.length ? lines.join('\n') : null,
    images,
    frames: used.map((f, i) => ({
      index: i + 1, id: f.id, mode: f.mode || 'photo', viewId: f.viewId || null,
      spec: f.spec || null,
      covers: Array.isArray(f.covers) ? f.covers.length : (f.covers ?? null),
      attached: images.some((im) => im.name === String(f.id)),
    })),
    warnings,
  };
}

// The sentinel a caller (or a test double) can use to tell the two turns of a
// round apart. Content-based rather than a call counter, because a round makes
// two `propose` calls and only one of them is about joints — counting them would
// silently shift every round index the rest of the campaign is keyed on.
export const EXPECTATION_MARK = 'CATEGORY PRIOR step';
export const isExpectationPrompt = (text) => String(text || '').includes(EXPECTATION_MARK);

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// A box is only usable if it is a real, ordered, in-frame rectangle — but
// "in-frame" is a UNIT question before it is a value question. Models switch
// between 0..1 fractions and pixel counts without warning, so the convention is
// inferred by the same `normBox` the discovery turn already uses, and which
// `regionsFromExpectations` will apply to this very box again downstream: the
// two conventions are decidable because their ranges barely overlap, no fraction
// exceeds 2 and no pixel box exceeds the frame it was drawn on. Normalizing is
// idempotent, so the second pass sees fractions and changes nothing.
//
// Normalizing instead of dropping matters here because a dropped instance is not
// a no-op. It removes a place from round 2's close-up plan and a term from the
// expected-vs-found count, so the campaign quietly stops looking for a part it
// was explicitly told about — and the human sees one warning line where a
// hypothesis used to be.
//
// What is still refused, and deliberately: a box beyond the frame it was drawn
// on is NEITHER convention, and repairing it would aim a camera at a place the
// model never indicated. `normBox` returns null for that, and so do we. Mild
// overshoot is a different case — a VLM's 10% slop is normal — so it is clamped,
// exactly as the discovery turn clamps it.
function normInstanceBox(v, viewport) {
  const raw = Array.isArray(v) ? v : (Array.isArray(v?.box) ? v.box : null);
  if (!raw || raw.length !== 4) return null;
  const b = normBox(raw, viewport);
  if (!b) return null;
  return { box: [b.x0, b.y0, b.x1, b.y1], pixels: !!b.pixels };
}

// Parse + validate the reply. Everything malformed is DROPPED WITH A WARNING and
// the remainder is returned, because a prior with one bad instance still aims
// three good ones — and because a silent drop would leave the campaign aiming at
// a box nobody can explain.
//
// `frameIds` is the set of frames actually sent. An instance pointing at a frame
// that was never attached is unresolvable by construction, so it is dropped here
// rather than becoming an unresolved region later.
//
// `viewport` is the size those frames were drawn at, and it is only needed to
// read a regionBox the model gave in pixels. Omit it and `normBox` falls back to
// VIEWPORT, which is what the campaign renders at; pass it (as loop.mjs does,
// from the same value it handed buildExpectationPrompt) when the round was
// planned at a different size, so the prompt and the parser agree about what one
// pixel means.
export function parseExpectation(reply, { frameIds = null, viewport } = {}) {
  const warnings = [];
  const empty = { category: '', confidence: 0, summary: '', instances: [], doubts: [], alternatives: [] };
  const text = String(reply == null ? '' : reply);
  if (!text.trim()) return { expectation: empty, warnings: ['the category turn returned nothing'] };

  // Fence-tolerant, like parseReply: a model told "JSON only" still wraps it.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return { expectation: empty, warnings: ['no JSON object found in the category reply'] };

  let raw = null;
  try {
    raw = JSON.parse(body.slice(a, b + 1));
  } catch (e) {
    return { expectation: empty, warnings: [`category reply JSON parse failed: ${e.message}`] };
  }
  // A model that answers with an array of instances and no category is still
  // usable: the instances are the part that aims anything.
  if (Array.isArray(raw)) raw = { instances: raw };
  if (!raw || typeof raw !== 'object') return { expectation: empty, warnings: ['the category reply was not an object'] };

  const category = str(raw.category ?? raw.kind ?? raw.machine, MAX_CATEGORY_CHARS);
  const conf = num(raw.confidence);
  const confidence = conf == null ? 0 : Math.max(0, Math.min(1, conf));
  if (conf == null) warnings.push('the category reply declared no confidence — treated as 0');
  const summary = str(raw.summary ?? raw.description, 480);

  const rawInstances = Array.isArray(raw.instances) ? raw.instances : [];
  if (rawInstances.length > MAX_EXPECTATION_INSTANCES) {
    warnings.push(`truncated ${rawInstances.length} category instances to ${MAX_EXPECTATION_INSTANCES}`);
  }
  const sent = frameIds ? new Set([...frameIds].map(String)) : null;
  const instances = [];
  rawInstances.slice(0, MAX_EXPECTATION_INSTANCES).forEach((ins, i) => {
    if (!ins || typeof ins !== 'object') { warnings.push(`instance[${i}] was not an object — dropped`); return; }
    const type = str(ins.type ?? ins.kind ?? ins.motion, 16);
    if (!TYPES.has(type)) { warnings.push(`instance[${i}] type "${type || '(none)'}" is not rotor|gimbal|hinge — dropped`); return; }
    const frameId = str(ins.frameId ?? ins.frame ?? ins.viewId, 64);
    if (sent && !sent.has(frameId)) {
      warnings.push(`instance[${i}] (${type}) names frame "${frameId || '(none)'}", which was not sent — dropped`);
      return;
    }
    const boxed = normInstanceBox(ins.regionBox ?? ins.box ?? null, viewport);
    if (!boxed) { warnings.push(`instance[${i}] (${type}) has no usable regionBox — dropped`); return; }
    // A repair is announced, never absorbed: the same reply read as pixels or as
    // fractions aims the camera at different places, and which one the model
    // meant is the one thing we inferred rather than were told.
    if (boxed.pixels) warnings.push(`instance[${i}] (${type}) drew regionBox in pixels — normalized to fractions`);
    const regionBox = boxed.box;
    const count = Math.max(1, Math.min(MAX_INSTANCE_COUNT, Math.round(num(ins.count ?? ins.instances ?? 1) ?? 1)));
    if (Number(ins.count) > MAX_INSTANCE_COUNT) warnings.push(`instance[${i}] (${type}) claimed ${ins.count}; capped to ${MAX_INSTANCE_COUNT}`);
    instances.push({
      type, count, frameId: frameId || null, regionBox,
      symmetry: str(ins.symmetry ?? ins.arrangement, 120) || null,
      note: str(ins.note ?? ins.reason ?? ins.reasoning, 240) || null,
    });
  });

  const list = (v, max, n) => (Array.isArray(v) ? v.map((x) => str(typeof x === 'string' ? x : x?.text, max)).filter(Boolean).slice(0, n) : []);
  const expectation = {
    category,
    confidence,
    summary,
    instances,
    doubts: list(raw.doubts ?? raw.uncertainties, 240, 12),
    alternatives: list(raw.alternatives ?? raw.alternative, 160, 6),
  };
  return { expectation, warnings };
}

// Whether the prior is worth acting on. False means the campaign behaves exactly
// as it did before this lane existed: no hypothesis block, no expectation-driven
// round-2 regions. Degrading to today's behaviour is the design — a prior is an
// optimisation, never a dependency.
export function expectationIsUsable(exp, { minConfidence = MIN_EXPECTATION_CONFIDENCE } = {}) {
  if (!exp || typeof exp !== 'object') return false;
  if (!Number.isFinite(exp.confidence) || exp.confidence < minConfidence) return false;
  if (!exp.category) return false;
  return Array.isArray(exp.instances) && exp.instances.length > 0;
}

// Expected vs grounded, per type. `records` is the manifest AFTER the discovery
// turn merged, so the comparison is against what the project actually believes —
// including anything geometry found before vision ever looked.
export function expectationGap(exp, records = []) {
  if (!exp || (!Array.isArray(exp.instances) && !exp.dictCounts) || (!exp.instances?.length && !exp.dictCounts)) return [];
  const expected = new Map();
  for (const ins of exp.instances || []) {
    if (!ins?.type) continue;
    expected.set(ins.type, (expected.get(ins.type) || 0) + Math.max(0, Number(ins.count) || 0));
  }
  // The dictionary's totals are the counts to FALSIFY when the category is one
  // the table knows: they are deterministic, where the model's per-type sum
  // drifts run to run. Union rather than replacement — a kind the model
  // expected and the table does not list (a drone's folding arms) is still a
  // place the loop was asked to look.
  for (const [type, n] of Object.entries(exp.dictCounts || {})) {
    if (Number.isFinite(n) && n >= 0) expected.set(type, n);
  }
  const found = new Map();
  for (const rec of records || []) {
    // A rejected record is not a joint, so counting one would report a gap as
    // filled by something a human threw away.
    if (!rec?.type || rec.status === 'rejected') continue;
    found.set(rec.type, (found.get(rec.type) || 0) + 1);
  }
  return [...expected.entries()].map(([type, e]) => {
    const f = found.get(type) || 0;
    return { type, expected: e, found: f, missing: Math.max(0, e - f), surplus: Math.max(0, f - e) };
  });
}

// Stable identity for one instance, so "verified" can be passed around as a list
// of strings instead of as object identity across two turns.
export function instanceKey(ins) {
  if (!ins) return null;
  const box = (ins.regionBox || []).map((v) => Number(v).toFixed(3)).join(',');
  return `${ins.type}|${ins.frameId ?? ''}|${box}`;
}

// Fraction of the EXPECTATION's box covered by the grounded box. Asymmetric on
// purpose: grounding dilates (BOX_DILATE) and can swallow neighbours, so "how
// much of the place we predicted did it point at" is the question that decides
// verification, not an IoU that a bigger box would unfairly penalise.
const asBox = (b) => (Array.isArray(b)
  ? { x0: b[0], y0: b[1], x1: b[2], y1: b[3] }
  : (b && typeof b === 'object' ? b : null));

function overlapFraction(a, b) {
  const A = asBox(a); const B = asBox(b);
  if (!A || !B) return 0;
  const [x0, y0, x1, y1] = [A.x0, A.y0, A.x1, A.y1].map(Number);
  const [bx0, by0, bx1, by1] = [B.x0, B.y0, B.x1, B.y1].map(Number);
  if (![x0, y0, x1, y1, bx0, by0, bx1, by1].every(Number.isFinite)) return 0;
  const ix = Math.max(0, Math.min(x1, bx1) - Math.max(x0, bx0));
  const iy = Math.max(0, Math.min(y1, by1) - Math.max(y0, by0));
  const area = (x1 - x0) * (y1 - y0);
  return area > 0 ? (ix * iy) / area : 0;
}

// Which instances the discovery turn ALREADY pointed at, as INDICES into
// `exp.instances`. Matched by frame + box overlap rather than by type, because
// "4 rotors expected, 3 grounded" does not say WHICH three — and aiming round 2
// at a rotor the model already located would spend the extra-view budget
// re-answering a settled question.
//
// Indices rather than keys so the caller (views/grounding) needs no knowledge of
// the instance shape to skip one; `instanceKey` stays exported for reporting.
//
// `grounded` entries are vision-propose's: { frameId, grounding: { box } }.
export function verifiedInstances(exp, grounded = [], { minOverlap = MIN_VERIFY_OVERLAP } = {}) {
  if (!exp?.instances?.length) return [];
  const out = [];
  exp.instances.forEach((ins, i) => {
    const hit = (grounded || []).some((e) => {
      if (!e || String(e.frameId ?? '') !== String(ins.frameId ?? '')) return false;
      const box = e.grounding?.box || e.box || null;
      return box ? overlapFraction(ins.regionBox, box) >= minOverlap : false;
    });
    if (hit) out.push(i);
  });
  return out;
}

// The HYPOTHESIS TO FALSIFY block. Wording matters as much as content here: the
// block is inserted into a prompt whose model has just been told to report what
// it sees, and a prior phrased as a finding would be agreed with rather than
// tested. So every line is attributed to the earlier look and every count is
// stated as an expectation.
export function expectationBrief(exp, gaps = []) {
  if (!expectationIsUsable(exp)) return [];
  const lines = [];
  lines.push(`a first look at these frames classified the machine as "${exp.category}" (its own confidence ${Number(exp.confidence).toFixed(2)})`);
  if (exp.summary) lines.push(`it said: ${exp.summary}`);
  if (exp.dictRef) {
    lines.push(`the reference list for a ${exp.dictKey} — the counts to falsify — is: ${exp.dictRef}`);
  }
  for (const ins of exp.instances) {
    const box = (ins.regionBox || []).map((v) => Number(v).toFixed(2)).join(',');
    lines.push(`it expects ${ins.count} x ${ins.type}${ins.symmetry ? `, arranged ${ins.symmetry}` : ''} — one such place is in frame "${ins.frameId}" at [${box}]${ins.note ? ` (${ins.note})` : ''}`);
  }
  const gapLines = (gaps || []).filter((x) => x.missing > 0 || x.surplus > 0);
  for (const gap of gapLines) {
    lines.push(gap.missing > 0
      ? `only ${gap.found} of the ${gap.expected} ${gap.type}(s) it expected have been grounded — look for the missing ${gap.missing}`
      : `${gap.found} ${gap.type}(s) were grounded where it expected ${gap.expected} — the extra ${gap.surplus} may be real, or the category may be wrong`);
  }
  for (const d of (exp.doubts || []).slice(0, 3)) lines.push(`it doubted: ${d}`);
  for (const alt of (exp.alternatives || []).slice(0, 2)) lines.push(`it also considered: ${alt}`);
  return lines;
}

// Category expectation — a lane that CLASSIFIES and CHECKS, and never merges.
//
// The question this answers is the one a coverage-driven planner cannot ask:
// "what machine is this?" Coverage picks frames by marginal gain over a
// kd-tree of parts, which is the right answer to "what have we not seen" and
// no answer at all to "what are we looking at". The turn is deliberately
// CLASSIFY-ONLY: the model names the machine, and the actuator dictionary
// (actuator-dictionary.mjs, a JSON data file) supplies the expected parts —
// because a model asked to enumerate moving parts invents internal mechanisms
// ("two steering gimbals") and speculates about structures it cannot see, and
// both used to land in the chat narration and the discovery prompt. Naming
// the category, and only that, buys three concrete things:
//
//   1. THE REFERENCE LIST. The dictionary entry the category resolves to is
//      the per-part ask the localization turn (localize.mjs) walks ONE BY ONE
//      — four wheels are four asks — with category names (wheel, door), never
//      motion types.
//   2. A NUMBER TO FALSIFY. `expectationGap` compares what the table says
//      should be there against what actually grounded, per part NAME.
//      "expected 4 wheel, named 3" is a discrepancy a human can act on.
//   3. A REVIEW WHEN THE TABLE DOESN'T KNOW. For an unknown category the
//      model may PROPOSE the machine's on-surface actuators (the `actuators`
//      field); the workflow then stops and asks a human to confirm the new
//      entry before any discovery continues (loop.mjs, CATEGORY_REVIEW).
//
// AND ONE HARD BOUNDARY, which is the whole reason this is its own module:
// there is NO path from here to mergeProposals. Nothing this file returns can
// become a manifest record. An expectation is a hypothesis the discovery turn
// is asked to falsify, and the only things that ever reach the manifest are
// proposals that grounding resolved and the physics battery scored. A guess
// that could mint a joint would be a hallucination with extra steps — the
// model's own confidence in the category is not evidence about this mesh.
//
// Pure: builds a prompt, parses a reply, compares counts. The transport is
// the same `propose` effect the discovery turn uses, so this is testable
// headless.
import { normBox } from './grounding.mjs';
import { CATEGORY_KEYS, lookupDictionary, normPartName } from './actuator-dictionary.mjs';
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
// Kinds of actuator an unknown-category proposal may carry. Bounded because
// the reply is model output: past this, the list is a ramble, not a machine.
export const MAX_EXPECTATION_ACTUATORS = 8;
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

// Build the category turn. Same image shape agent.send() wants. The ask is
// classify-only: no part enumeration, no pointing contract — the reference
// table does the listing and the localization turn does the pointing.
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
  lines.push('TASK: say WHAT KIND OF MACHINE this is. Nothing more — naming the parts is');
  lines.push('NOT your job here. A later step finds them one by one, guided by our reference');
  lines.push('table, not by anything you list in this reply.');
  lines.push('');
  lines.push('Naming the category: our reference table knows these kinds —');
  lines.push(`  ${CATEGORY_KEYS.join(', ')}`);
  lines.push('If this machine is one of them, use THAT word so the table\'s counts apply. If it is');
  lines.push('none of them, name it plainly anyway — a true unknown beats a forced match.');
  lines.push('');
  lines.push('SCOPE — read this before answering:');
  lines.push('We only model parts that are visible on the OUTER SURFACE of the machine. No');
  lines.push('interior, and no internal mechanical structure: no steering linkage, no');
  lines.push('suspension, no gearbox, no engine internals. Do not report them, do not count');
  lines.push('them, and do not speculate about them in "doubts" — a part we cannot see is');
  lines.push('simply out of scope, not a finding.');
  lines.push('');
  lines.push('READ THIS BEFORE ANSWERING — it is what makes the step safe:');
  lines.push('You are describing a CATEGORY, not this mesh, and nothing you write here');
  lines.push('becomes a joint. What your answer does is choose the reference list the next');
  lines.push('step checks part by part against the frames.');
  lines.push('');
  lines.push('KEEP IT SHORT. One sentence for "summary"; one short sentence per "doubts" or');
  lines.push('"alternatives" entry, at most 3 of each. Long replies fail to parse.');
  lines.push('');
  lines.push('Reply with JSON ONLY (no prose, no code fences), ONE object:');
  lines.push('{ "category": "short machine category, e.g. quadrotor drone / main battle tank / robotic arm",');
  lines.push('  "confidence": 0.0-1.0,');
  lines.push('  "summary": "one sentence: what it is and what moves on its outer surface",');
  lines.push('  "doubts": ["at most 3 short entries: what you are NOT sure about"],');
  lines.push('  "alternatives": ["at least one other category this could be, and what would settle it"],');
  lines.push('  "actuators": [ ONLY when your category is NOT one of the table words above:');
  lines.push('    { "name": "plain part word, snake_case, e.g. wheel / dome / hatch",');
  lines.push('      "motion": "rotor|gimbal",');
  lines.push('      "count": <how many a machine like this has, on its outer surface>,');
  lines.push('      "where": "where on the machine these sit" } ] }');
  lines.push('');
  lines.push('Rules:');
  lines.push('- "rotor" spins continuously about one axis (propeller, fan, road wheel); "gimbal"');
  lines.push('  pivots over a limited range (camera mount, folding arm, a swinging door or');
  lines.push('  hatch). Do not invent a third kind.');
  lines.push('- Omit "actuators" (or leave it empty) when you used a table word — the table');
  lines.push('  already says what that machine carries, and its list wins over anything you');
  lines.push('  could write here.');
  lines.push('- Every actuator you propose must be visible on the OUTER SURFACE in these');
  lines.push('  frames. If no part of it can be seen, do not list it.');
  lines.push('- Name at least one ALTERNATIVE category. A prior that cannot imagine being');
  lines.push('  wrong is not a hypothesis.');
  lines.push('- Never describe the render itself (transparency, colours, grid, background).');
  lines.push('  Describe the MACHINE.');
  lines.push('- An empty "category" with a low "confidence" is a valid answer when you cannot');
  lines.push('  tell what the machine is, and is far better than a confident guess.');
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

// The model-facing vocabulary. The IR keeps `hinge` as an internal structural
// type (propose-core / motion-spec), but this prompt offers only these two —
// so a reply outside them is either stale (hinge: re-typed, because an
// expectation is a hypothesis, not a record, and a limited-swing panel IS a
// gimbal here) or meaningless (anything else: dropped).
const PRIOR_TYPES = new Set(['rotor', 'gimbal']);

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
    let type = str(ins.type ?? ins.kind ?? ins.motion, 16);
    // A stale prompt's word for a limited-swing part. Re-typed rather than
    // dropped: the instance still aims a camera and feeds the count, which is
    // all an expectation ever does. The remap is ANNOUNCED, never absorbed.
    if (type === 'hinge') {
      warnings.push(`instance[${i}] type "hinge" re-typed to gimbal — the motion vocabulary offered to the model is rotor|gimbal; a limited-swing part is a gimbal`);
      type = 'gimbal';
    }
    if (!PRIOR_TYPES.has(type)) { warnings.push(`instance[${i}] type "${type || '(none)'}" is not rotor|gimbal — dropped`); return; }
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

  // The unknown-category proposal: the machine's ON-SURFACE actuators, asked
  // for only when the category is not a table word. These names are NOT yet
  // vocabulary (the whole point is that the table doesn't know this machine),
  // so validation is shape-only — snake_case name, rotor|gimbal, a sane count.
  // What survives becomes the candidate a human confirms into the dictionary
  // JSON (addDictionaryEntry); until then it mints nothing.
  const actuators = [];
  const rawActs = Array.isArray(raw.actuators) ? raw.actuators : [];
  if (rawActs.length > MAX_EXPECTATION_ACTUATORS) {
    warnings.push(`truncated ${rawActs.length} proposed actuators to ${MAX_EXPECTATION_ACTUATORS}`);
  }
  rawActs.slice(0, MAX_EXPECTATION_ACTUATORS).forEach((a, i) => {
    if (!a || typeof a !== 'object') { warnings.push(`actuator[${i}] was not an object — dropped`); return; }
    const name = str(a.name ?? a.part, 40).toLowerCase().replace(/[\s-]+/g, '_');
    if (!name) { warnings.push(`actuator[${i}] has no name — dropped`); return; }
    const motion = str(a.motion ?? a.type, 16);
    if (!PRIOR_TYPES.has(motion)) { warnings.push(`actuator[${i}] ("${name}") motion "${motion || '(none)'}" is not rotor|gimbal — dropped`); return; }
    const count = Math.max(1, Math.min(MAX_INSTANCE_COUNT, Math.round(num(a.count ?? 1) ?? 1)));
    actuators.push({ name, motion, count, where: str(a.where ?? a.location, 120) });
  });

  const list = (v, max, n) => (Array.isArray(v) ? v.map((x) => str(typeof x === 'string' ? x : x?.text, max)).filter(Boolean).slice(0, n) : []);
  const expectation = {
    category,
    confidence,
    summary,
    instances,
    actuators,
    doubts: list(raw.doubts ?? raw.uncertainties, 240, 12),
    alternatives: list(raw.alternatives ?? raw.alternative, 160, 6),
  };
  return { expectation, warnings };
}

// Whether the prior is worth acting on. A usable prior is a NAMED CATEGORY at
// enough confidence — the classify-only turn produces no instances, and none
// are needed: the dictionary supplies the parts. False means the campaign
// behaves exactly as it did before this lane existed: no hypothesis block, no
// localization ask. Degrading to today's behaviour is the design — a prior is
// an optimisation, never a dependency.
export function expectationIsUsable(exp, { minConfidence = MIN_EXPECTATION_CONFIDENCE } = {}) {
  if (!exp || typeof exp !== 'object') return false;
  if (!Number.isFinite(exp.confidence) || exp.confidence < minConfidence) return false;
  return !!exp.category;
}

// Expected vs grounded. `records` is the manifest AFTER the discovery turn
// merged, so the comparison is against what the project actually believes —
// including anything geometry found before vision ever looked.
//
// With a dictionary category the rows are per PART NAME (wheel, door — the
// words the human reads and the localization turn asks for), never per motion
// type: expected comes from the table entry, found counts the non-rejected
// records whose `part` normalizes to that name. Movers nobody has named yet
// ride as one trailing row with part: null — "2 movers are not named yet" is
// the honest pre-recognition state, and it keeps a named-3-of-4 from reading
// as 4-of-4.
//
// With no dictionary entry the legacy per-type rows are computed from the
// model's own instances, exactly as before the table — which, since the
// classify-only turn, is precisely the case the workflow stops to review.
export function expectationGap(exp, records = []) {
  const live = (records || []).filter((r) => r && r.status !== 'rejected');
  const hit = exp?.dictKey ? lookupDictionary(exp.category) : null;
  if (hit?.entry) {
    const rows = hit.entry.actuators.map((a) => {
      const found = live.filter((r) => normPartName(r.part) === a.name).length;
      return { part: a.name, expected: a.count, found, missing: Math.max(0, a.count - found), surplus: Math.max(0, found - a.count) };
    });
    const unnamed = live.filter((r) => !normPartName(r.part)).length;
    if (unnamed) rows.push({ part: null, expected: 0, found: unnamed, missing: 0, surplus: unnamed });
    return rows;
  }
  if (!exp || !Array.isArray(exp.instances) || !exp.instances.length) return [];
  const expected = new Map();
  for (const ins of exp.instances) {
    if (!ins?.type) continue;
    expected.set(ins.type, (expected.get(ins.type) || 0) + Math.max(0, Number(ins.count) || 0));
  }
  const found = new Map();
  for (const rec of live) {
    if (!rec?.type) continue;
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
// stated as an expectation. Counts are stated per PART NAME — the words the
// reference table and the localization turn both speak.
export function expectationBrief(exp, gaps = []) {
  if (!expectationIsUsable(exp)) return [];
  const lines = [];
  lines.push(`a first look at these frames classified the machine as "${exp.category}" (its own confidence ${Number(exp.confidence).toFixed(2)})`);
  if (exp.summary) lines.push(`it said: ${exp.summary}`);
  if (exp.dictRef) {
    lines.push(`the reference list for a ${exp.dictKey} — the parts to find, one by one — is: ${exp.dictRef}`);
  }
  for (const ins of exp.instances || []) {
    const box = (ins.regionBox || []).map((v) => Number(v).toFixed(2)).join(',');
    lines.push(`it expects ${ins.count} x ${ins.type}${ins.symmetry ? `, arranged ${ins.symmetry}` : ''} — one such place is in frame "${ins.frameId}" at [${box}]${ins.note ? ` (${ins.note})` : ''}`);
  }
  const gapLines = (gaps || []).filter((x) => x.missing > 0 || x.surplus > 0);
  for (const gap of gapLines) {
    if (gap.part === null) {
      lines.push(`${gap.found} mover(s) on the map have not been named yet — the localization step is what names them`);
    } else if (gap.part) {
      lines.push(gap.missing > 0
        ? `only ${gap.found} of the ${gap.expected} ${gap.part}(s) the table expects have been found — look for the missing ${gap.missing}`
        : `${gap.found} ${gap.part}(s) were found where the table expects ${gap.expected} — the extra ${gap.surplus} may be real, or the category may be wrong`);
    } else {
      lines.push(gap.missing > 0
        ? `only ${gap.found} of the ${gap.expected} ${gap.type}(s) it expected have been grounded — look for the missing ${gap.missing}`
        : `${gap.found} ${gap.type}(s) were grounded where it expected ${gap.expected} — the extra ${gap.surplus} may be real, or the category may be wrong`);
    }
  }
  for (const d of (exp.doubts || []).slice(0, 3)) lines.push(`it doubted: ${d}`);
  for (const alt of (exp.alternatives || []).slice(0, 2)) lines.push(`it also considered: ${alt}`);
  return lines;
}

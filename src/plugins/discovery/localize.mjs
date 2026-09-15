// Per-part localization — turn A′, the bridge between "what machine this is"
// and "where each expected part sits".
//
// The category turn (expectation.mjs) answers per KIND: "a car, four wheels,
// four doors". The dictionary (actuator-dictionary.mjs) makes that reference
// list deterministic. What neither can say is WHERE EACH ONE is — and per-part
// scope is exactly what the baked-vertex mesh class needs, because on those
// exports every origin-based instrument is blind and only a visually pointed
// box resolves to truthful node sets (grounding.mjs projects the box through
// the frame's camera; the battery then disposes of the membership).
//
// So this turn asks the model to point at EVERY expected part INDIVIDUALLY —
// four wheels are FOUR entries, where the category turn's were one entry with
// count 4 — and the reply parses through the SAME visionPropose channel as the
// discovery turn, under a distinct gate profile (HINT_GATE_PROFILE). What comes
// out is a scope HYPOTHESIS with `hinted: true`, never a discovery: grounding
// resolved the nodes, the physics battery will dispose of them, and a part the
// model could not see is simply absent from the reply — reported through the
// ask list, never invented.
//
// Pure: builds a prompt; the transport is the same `propose` effect every other
// turn uses, so this is testable headless with no agent and no model.
import { frameLine, legendLine, sceneFacts, sceneHeader } from './vision-prompt.mjs';
import { surveyPhotos } from './expectation.mjs';

export const LOCALIZATION_MARK = 'PART LOCALIZATION step';
export const isLocalizationPrompt = (text) => String(text || '').includes(LOCALIZATION_MARK);

// The ask is bounded twice: the dictionary entry bounds it semantically (a car
// has 16 expected instances, hard parts first), and this cap bounds it
// mechanically. Beyond it the reply would be truncated mid-list, which reads
// as "the model skipped parts" — so the prompt says the real number and the
// parse cap (loop.mjs passes `asked` to visionPropose) is the same number.
export const MAX_LOCALIZATION_ITEMS = 16;
// Whole-machine photos are what a part can be pointed at in; more than the
// category turn's cap buys nothing, because the parts list is already known.
export const MAX_LOCALIZATION_FRAMES = 6;

// One line of the ask per INSTANCE, hard parts (wheels, doors) before soft ones
// (mirrors, headlights): when the cap bites, what falls off the end is the part
// whose absence the dictionary itself calls not-a-failure.
function askList(entry) {
  const acts = [...(entry?.actuators || [])].sort((a, b) => (a.soft ? 1 : 0) - (b.soft ? 1 : 0));
  const wanted = [];
  for (const a of acts) {
    const n = Math.max(0, a.count | 0);
    for (let k = 1; k <= n; k += 1) {
      wanted.push({ name: a.name, motion: a.motion, where: a.where, soft: !!a.soft, k, of: n });
    }
  }
  return wanted;
}

// Build the localization turn. Returns { text, images, frames, asked, warnings }
// in the same shape buildExpectationPrompt returns, so the loop can persist and
// narrate the two priors identically. `asked` is the number of part instances
// the reply may hold — the loop hands it to visionPropose as the parse cap.
export function buildLocalizationPrompt({
  frames = [], g = null, viewport = null,
  dictKey = null, entry = null, gaps = [], maxFrames = MAX_LOCALIZATION_FRAMES,
} = {}) {
  const warnings = [];
  if (!entry?.actuators?.length || !dictKey) {
    return { text: null, images: [], frames: [], asked: 0, warnings: ['no dictionary entry to localize against'] };
  }
  const wanted = askList(entry);
  if (!wanted.length) {
    return { text: null, images: [], frames: [], asked: 0, warnings: [`the ${dictKey} dictionary entry lists no parts`] };
  }
  const dropped = wanted.length > MAX_LOCALIZATION_ITEMS ? wanted.length - MAX_LOCALIZATION_ITEMS : 0;
  const ask = wanted.slice(0, MAX_LOCALIZATION_ITEMS);
  if (dropped) warnings.push(`the ${dictKey} reference list has ${wanted.length} instances; only the first ${ask.length} are asked (soft parts drop first)`);

  const cap = Math.max(1, maxFrames | 0);
  const photos = surveyPhotos(frames);
  if (!photos.length) {
    return { text: null, images: [], frames: [], asked: ask.length, warnings: ['no whole-machine photo frame to point at parts in'] };
  }
  if (photos.length > cap) warnings.push(`truncated ${photos.length} survey frames to ${cap}`);
  // Each photo's colorId twin rides along where one exists: a mask colour is
  // the strongest locator this loop can resolve, and the pairing is by viewId
  // — the two frames were drawn from the same pose, so a box on one and colours
  // from the other describe the same pixels.
  const byView = new Map();
  for (const f of frames || []) {
    if ((f?.mode || 'photo') !== 'colorId' || !f?.dataBase64) continue;
    const key = f.viewId || f.id;
    if (!byView.has(key)) byView.set(key, f);
  }
  const used = [];
  for (const p of photos.slice(0, cap)) {
    used.push(p);
    const mask = byView.get(p.viewId || p.id);
    if (mask) used.push(mask);
  }

  const lines = [];
  lines.push(`You are the ${LOCALIZATION_MARK} of a rigged-mesh joint-discovery loop.`);
  lines.push('You are looking at RENDERED FRAMES of one 3D CAD assembly, drawn by us from an');
  lines.push('omni survey of poses we chose. They are not photographs — there is no lighting');
  lines.push('realism and no branding.');
  lines.push('');
  lines.push(...sceneHeader(sceneFacts(g, viewport, used), { unknownMachine: false }));
  lines.push('');
  lines.push(`An earlier step looked at these same frames and read this machine as a "${dictKey}".`);
  lines.push('Treat that as a working hypothesis, not as proof — but our reference table says a');
  lines.push(`machine of that kind carries exactly these moving parts, and your job is to say WHERE`);
  lines.push('EACH ONE is:');
  lines.push('');
  lines.push('EXPECTED PARTS (point at every one you can see):');
  ask.forEach((a, i) => lines.push(`  ${i + 1}. ${a.name} ${a.k} of ${a.of} — ${a.motion} — usually at: ${a.where}${a.soft ? ' [may be fused or cosmetic]' : ''}`));
  lines.push('');
  const missing = (gaps || []).filter((x) => x?.missing > 0);
  if (missing.length) {
    lines.push(`The project's current joint map is MISSING ${missing.map((x) => `${x.missing} of ${x.expected} ${x.type}(s)`).join(', ')}.`);
    lines.push('Pay special attention to finding those — but point at every listed part, found or not.');
    lines.push('');
  }
  lines.push('TASK: for EACH numbered part you can see, emit ONE reply entry pointing at THAT');
  lines.push('SPECIFIC instance. One entry PER PART — the four wheels of a car are FOUR entries,');
  lines.push('one per wheel, never one entry covering all four. Your box is used as a HINT: a');
  lines.push('later step measures the real rigid membership from the mesh itself, so a box that is');
  lines.push('10% too large is fine; a box around the WRONG part is not.');
  lines.push('');
  lines.push('HOW TO POINT AT A PART (the same contract the discovery step uses):');
  lines.push('You do NOT know our internal part names and you must NOT invent them. Instead,');
  lines.push('for every entry give us a way to LOCATE the part:');
  lines.push('  "frameId"       - which frame you are looking at (use the exact id from below)');
  lines.push('  "regionBox"     - [x0, y0, x1, y1] as FRACTIONS of the frame, 0..1, origin at');
  lines.push('                    the TOP-LEFT, y increasing DOWNWARD. Tight around the ONE part.');
  lines.push('  "regionColors"  - for a colorId mask frame ONLY: the exact hex colours of the');
  lines.push('                    parts you mean, e.g. ["#9ec091"]. This is the strongest');
  lines.push('                    evidence you can give us - prefer it whenever a mask frame');
  lines.push('                    covers the part.');
  lines.push('');
  lines.push(`Reply with JSON ONLY (no prose, no code fences): an array of at most ${ask.length} objects:`);
  lines.push('[{ "op": "new",');
  lines.push('   "type": "<the motion word from the numbered list>", "part": "<the name from the list>",');
  lines.push('   "frameId": "<frame id>", "regionBox": [x0,y0,x1,y1], "regionColors": ["#rrggbb"],');
  lines.push('   "axis": [x,y,z], "anchor": [x,y,z],');
  lines.push('   "reasoning": "what you see at that spot",');
  lines.push('   "uncertainties": ["what you are NOT sure about, stated plainly"] }]');
  lines.push('');
  lines.push('Rules:');
  lines.push('- "type" and "part" come from the numbered list VERBATIM — they are given, not chosen.');
  lines.push('- Two instances of the same kind are two entries pointing at two DIFFERENT places;');
  lines.push('  wheel 1 and wheel 2 are not the same wheel, and one box around both is wrong.');
  lines.push('- Point only at parts you can actually SEE in the frame you name. A part hidden in');
  lines.push('  every frame is simply omitted from the array — never guess a box for it.');
  lines.push('- The scene is Z-UP; axis and anchor are in MODEL world units. A rotor\'s spin axis is');
  lines.push('  usually [0,0,1]; a door hinge is usually vertical. Omit either rather than invent it —');
  lines.push('  we derive both from the geometry your box selects whenever we can.');
  lines.push('- Put every real doubt in "uncertainties". A stated doubt is acted on; a hidden one is not.');
  lines.push('- Never describe the render itself (transparency, colours, grid, background).');
  lines.push('  Describe the MACHINE.');
  lines.push('');
  lines.push(`FRAMES (${used.length} attached, in order):`);
  used.forEach((f, i) => lines.push(`  ${frameLine(f, i)}`));
  const legends = used.map(legendLine).filter(Boolean);
  if (legends.length) { lines.push(''); lines.push(...legends); }

  const images = [];
  for (const f of used) {
    if (!f.dataBase64) { warnings.push(`frame ${f.id} has no image bytes; described in text but not attached`); continue; }
    images.push({ mediaType: f.mediaType || 'image/png', dataBase64: f.dataBase64, name: String(f.id) });
  }
  if (!images.length) warnings.push('no frame carried image bytes - no part can be localized from text alone');

  return {
    text: images.length ? lines.join('\n') : null,
    images,
    asked: ask.length,
    frames: used.map((f, i) => ({
      index: i + 1, id: f.id, mode: f.mode || 'photo', viewId: f.viewId || null,
      spec: f.spec || null,
      covers: Array.isArray(f.covers) ? f.covers.length : (f.covers ?? null),
      attached: images.some((im) => im.name === String(f.id)),
    })),
    warnings,
  };
}

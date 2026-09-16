// Vision prompt — the text+image turn that asks a VLM what MOVES in this model.
//
// This is not the L2 text prompt with pictures bolted on. Two differences shape
// the whole design:
//
//  1. THE MODEL NEVER NAMES NODES. It cannot: the names are `63_3_104`, exported
//     by a CAD pipeline with no semantic content, and a model asked to pick from a
//     728-row table hallucinates plausible-looking ids. Instead it POINTS — a
//     frame id plus a normalized region box, and/or the flat colour ids painted by
//     the colorId render — and grounding.mjs resolves that to exact node names
//     against geometry the server already knows. `nodeIds` stays optional for the
//     rare case where the model is handed names it can actually use.
//
//  2. UNCERTAINTY IS A FIRST-CLASS OUTPUT. `reasoning` and `uncertainties[]` are
//     not decoration: they are what the amber chip in the joint list shows, and
//     `suggestView` is what makes round 2 aim itself (Task 16). A model that is
//     told to be confident produces confident wrongness; one that is told where
//     its answer will be checked produces usable doubt.
//
// Pure: builds strings and an image list. The provider (vision-provider.mjs) does
// the transport, so this is testable headless with no agent and no model.
//
// It deliberately imports NOTHING from views.mjs. views.mjs imports MAX_LEGEND
// from here, so a reverse import would close a cycle; and this module is a
// formatter, so every fact it prints is handed to it — `g` for the model's own
// size, a planned view's `cam` for the camera it was drawn with.
import { constraintSummary } from './manifest.mjs';
import { ACTUATOR_VOCABULARY } from './actuator-dictionary.mjs';

export const MAX_VISION_FRAMES = 12;
// A colour legend beyond this stops being readable and starts costing more tokens
// than the grounding it saves; the model can still report a hex it sees.
export const MAX_LEGEND = 40;

// ---- the annotations that remove the model's guesswork -----------------------
//
// A regionBox is a fraction of an image, so it is meaningless unless the model
// knows the image's geometry: how wide the frustum was, how big the machine is
// relative to the numbers in "eye distance", and — the one whose absence
// produced the dominant doubt in a real air3 reply, "left/right labelling in
// this near-top view assumes screen-right is +X" — which way the world axes run
// across the screen. Telling it removes a guess it would otherwise have to
// declare, and a declared guess costs a round-2 frame to settle.

// How aligned a basis vector must be with a world axis before we NAME it.
// cos(30°): past that the axis is a description of the frame rather than an
// approximation of it, and below it we print the vector instead of lying.
export const AXIS_ALIGN = 0.866;
const WORLD_AXES = [['+X', [1, 0, 0]], ['-X', [-1, 0, 0]], ['+Y', [0, 1, 0]], ['-Y', [0, -1, 0]], ['+Z', [0, 0, 1]], ['-Z', [0, 0, -1]]];

function axisName(v) {
  if (!Array.isArray(v) || v.length !== 3) return null;
  let best = null; let bd = AXIS_ALIGN;
  for (const [name, a] of WORLD_AXES) {
    const d = v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
    if (d > bd) { bd = d; best = name; }
  }
  return best;
}

// "screen-right = +X, screen-up = +Z" — the mapping a regionBox is drawn in.
// Derived from the SAME basis grounding projects with (views.mjs makeCamera), so
// the sentence is a fact about the frame rather than a description of a
// convention we hope the renderer followed.
export function screenAxes(cam) {
  if (!cam?.r || !cam?.u) return null;
  const fmt = (v) => axisName(v) || `(${v.map((x) => Number(x).toFixed(2)).join(',')})`;
  return `screen-right = ${fmt(cam.r)}, screen-up = ${fmt(cam.u)}`;
}

// The facts every frame shares. Radius falls back the way views.mjs modelRadius
// does (placed-bbox circumradius, else the spread of node origins) — copied
// rather than imported, see the note at the top of this file.
export function sceneFacts(g = null, viewport = null, frames = []) {
  const cam = (frames || []).map((f) => f?.cam).find((c) => c && Number.isFinite(c.fov)) || null;
  const vp = viewport && Number.isFinite(viewport.fov)
    ? { w: viewport.w, h: viewport.h, fov: viewport.fov }
    : (cam ? { w: cam.w, h: cam.h, fov: cam.fov } : null);
  const radius = Number(g?.wradius) || Number(g?.radius) || null;
  const b = g?.bounds;
  const extent = b && Array.isArray(b.min) && Array.isArray(b.max)
    ? [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
    : null;
  return { vp, radius, extent, nodes: Number(g?.nodes?.length) || null };
}

export function sceneHeader(facts, { unknownMachine = true } = {}) {
  const lines = [];
  const { vp, radius, extent } = facts || {};
  if (!vp && !radius) return lines;
  lines.push('SCENE (every frame shares these facts):');
  if (vp) {
    lines.push(`  frame ${vp.w}x${vp.h} px, fov ${Math.round(vp.fov)}\u00b0 vertical, pinhole — a regionBox is a FRACTION of that frame`);
  }
  if (radius) {
    lines.push(`  the whole machine fits a sphere of radius ${radius.toFixed(1)} world units${extent ? `, bounding box ${extent.map((x) => x.toFixed(1)).join(' x ')} (X x Y x Z)` : ''}`);
    lines.push('  so an "eye distance" below is in those units: 2.0 means two machine-radii away, 0.2 means a close-up');
  }
  lines.push('  the scene is Z-UP; "anchor" and "axis" are in these same world units');
  if (unknownMachine) {
    lines.push('  WE DO NOT KNOW WHAT MACHINE THIS IS. It may be an aircraft, a ground vehicle, an arm,');
    lines.push('  a fixture — anything. Report every part that MOVES relative to the rest, and do not let');
    lines.push('  a plausible category talk you out of a part you can actually see.');
  }
  return lines;
}

const MODE_EXPLAINS = {
  photo: 'an ordinary opaque render — what a photograph of the assembly would show',
  clay: 'every part in ONE bright neutral matte material — real colours and textures are hidden on purpose so SHAPE and silhouette are easier to read. Judge by form only; nothing is discoloured or broken',
  ghost: 'the enclosing shell made TRANSLUCENT on purpose, so interior parts become visible. Nothing is broken or missing; see through the hull',
  solo: 'ONLY the focused sub-assembly drawn, everything else hidden — this is the full extent of that group',
  colorId: 'a flat unlit segmentation mask: every part painted one unique colour, listed in the LEGEND below. Report these colours to identify parts exactly',
};

// One line per image, so the model knows what it is looking at before it looks.
// A ghost frame with no explanation reads as a corrupted render, and a colorId
// mask reads as abstract art — both invite the model to describe the artefact
// instead of the machine.
export function frameLine(frame, i) {
  const s = frame.spec || {};
  const bits = [`frame ${i + 1} = "${frame.id}"`];
  bits.push(`${frame.mode || 'photo'} (${MODE_EXPLAINS[frame.mode] || MODE_EXPLAINS.photo})`);
  if (Number.isFinite(s.azimuth)) bits.push(`azimuth ${Math.round(s.azimuth)}\u00b0`);
  if (Number.isFinite(s.elevation)) bits.push(`elevation ${Math.round(s.elevation)}\u00b0`);
  if (Number.isFinite(s.distance)) bits.push(`eye distance ${Number(s.distance).toFixed(1)} units`);
  // The survey tier is FOUR ORTHOGONAL eye-level side views 90° apart plus one
  // true pole each way, and only `spec.pole` and the elevation tell them apart.
  // Calling an eye-level frame "top-down" — or calling it "oblique" when it is
  // square to the machine — is not a cosmetic slip: the model reasons about which
  // side of the machine a regionBox is on from the words we print here, and a
  // wrong one is believed. It is the same class of error the screen-axis
  // annotation below exists to remove.
  if (s.kind === 'survey') {
    bits.push(s.pole === 'bottom' ? 'true bottom-up whole-machine view'
      : s.pole === 'top' ? 'true top-down whole-machine view'
        : 'eye-level orthogonal side view of the whole machine (one of four, 90\u00b0 apart)');
  } else if (s.kind === 'panel') {
    // The panel tier is the human's own framing of the whole machine, orbited to
    // a fixed bearing. Same honesty rule as the survey line: the elevation and
    // the pole flag are what actually distinguish the twelve, so the words must
    // not claim "side view" for an oblique or "top-down" for 35\u00b0.
    bits.push(s.pole === 'bottom' ? 'true bottom-up whole-machine view (human panel framing)'
      : s.pole === 'top' ? 'true top-down whole-machine view (human panel framing)'
        : 'whole-machine view at the distance and FOV the human set in the 3D view panel');
  } else if (s.kind === 'cell') bits.push(`zoomed into one region of ${s.members ?? '?'} parts`);
  else if (s.kind === 'close-up') bits.push('close-up of one region');
  else bits.push('whole-model view');
  // `covers` is a NAME LIST on a plan view and a COUNT on a stored frame entry.
  // Both shapes reach here, and printing an array would read as "~[object Array]".
  const n = Array.isArray(frame.covers) ? frame.covers.length : frame.covers;
  if (Number.isFinite(n)) bits.push(`shows ~${n} parts`);
  if (Array.isArray(frame.focus) && frame.focus.length) bits.push(`focused on: ${frame.focus.slice(0, 6).join(', ')}`);
  // The camera it was actually drawn with. Absent on a frame replayed from disk
  // with no plan beside it, in which case the annotation is omitted rather than
  // guessed — a wrong axis mapping is worse than none, because it is believed.
  const cam = frame.cam || null;
  if (cam) {
    if (Number.isFinite(cam.fov)) bits.push(`fov ${Math.round(cam.fov)}\u00b0`);
    if (Number.isFinite(cam.w) && Number.isFinite(cam.h)) bits.push(`${cam.w}x${cam.h}px`);
    const axes = screenAxes(cam);
    if (axes) bits.push(axes);
  }
  return bits.join(', ');
}

// The colour legend for a mask frame. Kept beside the frame it belongs to so the
// model does not have to hold one global table in mind across twelve images.
export function legendLine(frame) {
  const map = frame.colorMap;
  // Same guard as the frames manifest: an unloaded entry carries a filename, and
  // a legend built from a string's characters would be worse than no legend — it
  // would invite the model to report colours that were never painted.
  if (!map || typeof map !== 'object') return null;
  const entries = Object.entries(map).filter(([c, n]) => /^#?[0-9a-fA-F]{3,8}$/.test(String(c)) && n);
  if (!entries.length) return null;
  const shown = entries.slice(0, MAX_LEGEND).map(([c, n]) => `${c}=${n}`).join(' ');
  const more = entries.length > MAX_LEGEND ? ` (+${entries.length - MAX_LEGEND} more not listed — report the hex you see anyway)` : '';
  return `LEGEND for "${frame.id}": ${shown}${more}`;
}

// Build the turn. Returns { text, images, frames, references, warnings } where
// `images` is exactly the shape agent.send() wants: [{ mediaType, dataBase64,
// name }] — the rendered frames first, then any human reference images.
//
// `frames` in: [{ id, mode, spec, pose, covers, focus, colorMap, mediaType,
//                dataBase64 }] — i.e. observation entries joined with the bytes
//                read back off disk and, where available, the plan view that
//                asked for them.
// `extraImages` in: the same image-part shape, but pictures a HUMAN sent. They
//                are described in text as not-frames and reported back in
//                `references` (names only, no bytes) so a persisted round can
//                say it was steered.
export function buildVisionPrompt({
  manifest = null, frames = [], plan = null, maxFrames = MAX_VISION_FRAMES, question = null,
  // The parse table, for the SCENE header only: this module never projects
  // anything, it just says how big the machine is so "eye distance 212.5 units"
  // means something to the reader.
  g = null, viewport = null,
  // A CATEGORY PRIOR to falsify (see expectation.mjs). Lines, already formatted;
  // null or empty leaves the prompt exactly as it was before that lane existed.
  hypothesis = null,
  // INDEPENDENT OBSERVER mode. The other producer's conclusions are withheld and
  // only human-confirmed records are listed as off-limits, so a geometry guess
  // cannot steer this one. Off by default: the manual "refine what is doubtful"
  // mode is a follow-up look and legitimately stands on what is already known.
  independent = false,
  // HUMAN-SUPPLIED REFERENCE IMAGES, attached AFTER the rendered frames and
  // described in text as NOT one of them. The whole pointing contract rests on
  // `frameId` naming a frame WE drew from a pose we recorded, because grounding
  // projects the reply's regionBox through that pose's camera. A box cited
  // against a photograph has no camera behind it and gets dropped at the gate —
  // so the prompt says that out loud instead of letting the model discover it
  // silently and lose a proposal it believed it had supported.
  extraImages = [],
} = {}) {
  const warnings = [];
  const wanted = Array.isArray(frames) ? frames : [];
  if (wanted.length > maxFrames) warnings.push(`truncated ${wanted.length} frames to ${maxFrames}`);
  const used = wanted.slice(0, Math.max(0, maxFrames | 0));

  // Join each frame to the plan view that produced it, so the manifest line can
  // say how many parts the planner expected to be visible. That number is what
  // makes a hallucination detectable later: a part named from a frame whose pose
  // cannot show it is not a discovery, it is an invention.
  //
  // `cam` rides along for the same reason: it is the basis grounding will project
  // the reply's regionBox through, so the screen-axis mapping printed below is
  // the one the frame was really drawn in, not a convention we assume.
  const viewById = new Map((plan?.views || []).map((v) => [v.id, v]));
  const enriched = used.map((f) => {
    const v = viewById.get(f.viewId || f.id) || null;
    return {
      ...f,
      covers: f.covers ?? v?.covers ?? null,
      sees: f.sees ?? v?.sees ?? null,
      spec: f.spec ?? v?.spec ?? null,
      cam: f.cam ?? v?.cam ?? null,
    };
  });

  const constraints = constraintSummary(manifest, { confirmedOnly: !!independent });
  const lines = [];
  lines.push('You are the VISION producer in a rigged-mesh joint-discovery loop.');
  lines.push('You are looking at RENDERED FRAMES of one 3D CAD assembly (a machine with moving');
  lines.push('parts), drawn by us from poses we chose. They are not photographs: there is no');
  lines.push('lighting realism, no branding, and some frames are deliberately altered — each');
  lines.push('frame below says exactly how.');
  lines.push('');
  const scene = sceneHeader(sceneFacts(g, viewport, enriched));
  if (scene.length) { lines.push(...scene); lines.push(''); }
  if (independent) {
    lines.push('You are an INDEPENDENT OBSERVER. Another producer has already looked at this mesh and');
    lines.push('its conclusions are deliberately WITHHELD from you, because agreeing with a wrong guess');
    lines.push('is worse than contradicting it. Report every part you can see that moves, wherever it');
    lines.push('is; only the HUMAN-CONFIRMED records listed below are off-limits, and they are listed');
    lines.push('because a person has already disposed of them.');
    lines.push('');
  }
  lines.push(question || 'TASK: identify the parts of this machine that MOVE RELATIVE to the rest,');
  lines.push('and say what kind of motion each has.');
  lines.push('  rotor  - spins continuously about one axis (propeller, fan, motor, wheel)');
  lines.push('  gimbal - pivots over a limited range (camera mount, turret, mirror, door): a');
  lines.push('           panel that swings about a fixed edge is a gimbal too');
  lines.push('There is no third kind. A DOOR is proposed — as a gimbal, part "door". Other hinged');
  lines.push('panels (hood, hatch, trunk, wiper) are NOT proposed: they are service panels, not');
  lines.push('driven actuators, and their extent cannot be pointed at reliably enough to rig.');
  lines.push('If a moving part is FUSED into a larger shell — no seam, no separate node — point');
  lines.push('at it anyway: the surface is cut out mechanically, and your box tells the cutter');
  lines.push('where to start. Never name the whole shell as the part to avoid pointing.');
  lines.push('');
  lines.push('PARTS vocabulary — WHAT a part is, as opposed to how it moves. For every proposal');
  lines.push('also name the part with ONE word from this list:');
  lines.push(`  ${[...ACTUATOR_VOCABULARY].sort().join(', ')}`);
  lines.push('Use null when none of these honestly fits what you are pointing at. A wrong name');
  lines.push('is worse than none: an unnamed part is excluded from the actuator list, a wrongly');
  lines.push('named one gets the wrong controller.');
  lines.push('');
  lines.push('HOW TO POINT AT A PART (read this carefully - it is the whole contract):');
  lines.push('You do NOT know our internal part names and you must NOT invent them. Instead,');
  lines.push('for every proposal give us a way to LOCATE the part:');
  lines.push('  "frameId"       - which frame you are looking at (use the exact id from below)');
  lines.push('  "regionBox"     - [x0, y0, x1, y1] as FRACTIONS of the frame, 0..1, origin at');
  lines.push('                    the TOP-LEFT, y increasing DOWNWARD. Tight around the part.');
  lines.push('  "regionColors"  - for a colorId mask frame ONLY: the exact hex colours of the');
  lines.push('                    parts you mean, e.g. ["#9ec091"]. This is the strongest');
  lines.push('                    evidence you can give us - prefer it whenever a mask frame');
  lines.push('                    covers the part.');
  lines.push('We resolve these against the real geometry ourselves. A box that is 10% too');
  lines.push('large is fine; a box around the WRONG part is not. Give regionBox on a photo,');
  lines.push('ghost or solo frame, and regionColors from the matching mask frame.');
  lines.push('');
  lines.push('Reply with JSON ONLY (no prose, no code fences): an array of at most 6 objects:');
  lines.push('[{ "op": "new|split|confirm", "targetId": "<existing id, for split/confirm only>",');
  lines.push('   "type": "rotor|gimbal", "part": "<one word from the PARTS vocabulary, or null>",');
  lines.push('   "frameId": "<frame id>", "regionBox": [x0,y0,x1,y1], "regionColors": ["#rrggbb"],');
  lines.push('   "nodeIds": ["<only if we gave you names below>"],');
  lines.push('   "axis": [x,y,z], "anchor": [x,y,z],');
  lines.push('   "reasoning": "what you see that makes this a moving part",');
  lines.push('   "uncertainties": ["what you are NOT sure about, stated plainly"],');
  lines.push('   "suggestView": { "target": "what to look at", "reason": "why it would settle it" } }]');
  lines.push('');
  lines.push('Rules:');
  lines.push('- We only model parts visible on the OUTER SURFACE of the machine. No interior,');
  lines.push('  and no internal mechanical structure: no steering linkage, no suspension, no');
  lines.push('  gearbox, no engine internals. Do not propose them, even where you can infer them.');
  lines.push('- The scene is Z-UP. A rotor\'s spin axis is usually [0,0,1]; a gimbal usually');
  lines.push('  tilts about a horizontal axis. axis and anchor are in MODEL world units.');
  lines.push('- anchor is the point the part rotates ABOUT (a rotor hub, not a blade tip).');
  lines.push('- Report the MOVING GROUP, not one fastener: all blades of one propeller belong');
  lines.push('  to one rotor. Use several regionColors or a box around the whole hub.');
  lines.push('- Parts listed below are already claimed. Do not re-propose');
  lines.push('  them, except via op:"split" naming the claiming joint in targetId.');
  lines.push('- op:"confirm" means "your existing joint X is right, I can see it" - use it.');
  lines.push('- Prefer FEW well-supported proposals over many speculative ones. An empty array');
  lines.push('  is a valid answer and is far better than a guess.');
  lines.push('- Put every real doubt in "uncertainties". Do not soften a doubt into confidence:');
  lines.push('  we can act on a stated uncertainty and we cannot act on a hidden one.');
  lines.push('- If you need a better look, DO NOT GUESS - return no proposal for that part and');
  lines.push('  fill in "suggestView" instead. We can render more frames; we cannot undo a');
  lines.push('  confident wrong joint.');
  lines.push('- Never describe the render itself (transparency, colours, grid, background).');
  lines.push('  Describe the MACHINE.');
  lines.push('');
  // The hypothesis goes AFTER the rules and BEFORE the constraints, so it reads as
  // a claim to test rather than as context to agree with.
  const hyp = Array.isArray(hypothesis) ? hypothesis.filter((x) => x && String(x).trim()) : [];
  if (hyp.length) {
    lines.push('HYPOTHESIS TO FALSIFY (a first look at these same frames produced it — it is NOT evidence):');
    lines.push(...hyp.map((h) => `  ${String(h).trim()}`));
    lines.push('Verify or refute EACH of these against what you can actually see, and give a locator for');
    lines.push('every one you keep. Then report anything it MISSED: a hypothesis that named four rotors');
    lines.push('does not make a fifth invisible. An expectation is never a discovery — only what you can');
    lines.push('point at is.');
    lines.push('');
  }
  const cTitle = constraints.length
    ? (independent ? 'HUMAN-CONFIRMED CONSTRAINTS (a person settled these — do not re-propose them):' : 'VALIDATED CONSTRAINTS (already claimed - subtract from your search):')
    : 'VALIDATED CONSTRAINTS: (none yet - nothing is claimed)';
  lines.push(cTitle);
  lines.push(...constraints);
  lines.push('');
  lines.push(`FRAMES (${enriched.length} attached, in order):`);
  enriched.forEach((f, i) => lines.push(`  ${frameLine(f, i)}`));
  const legends = enriched.map(legendLine).filter(Boolean);
  if (legends.length) { lines.push(''); lines.push(...legends); }

  const images = [];
  for (const f of enriched) {
    if (!f.dataBase64) { warnings.push(`frame ${f.id} has no image bytes; described in text but not attached`); continue; }
    images.push({ mediaType: f.mediaType || 'image/png', dataBase64: f.dataBase64, name: String(f.id) });
  }
  if (!images.length) warnings.push('no frame carried image bytes - the model will be reasoning from text alone');

  // The human's pictures go on the END of the same attachment list, named with a
  // `ref:` prefix so they can never collide with a frame id — and so a reply that
  // cites "ref:screenshot.png" as a frameId is visibly wrong rather than silently
  // matching something.
  const extras = (Array.isArray(extraImages) ? extraImages : []).filter((im) => im && im.dataBase64);
  const droppedExtras = (Array.isArray(extraImages) ? extraImages : []).length - extras.length;
  if (droppedExtras > 0) warnings.push(`${droppedExtras} reference image(s) carried no bytes and were not attached`);
  if (extras.length) {
    lines.push('');
    lines.push(`REFERENCE IMAGES FROM THE HUMAN (${extras.length} attached AFTER the frames above):`);
    lines.push('These are NOT frames we rendered. They are pictures the person watching this run sent');
    lines.push('while it was in flight, to show you something about the machine. Read them as guidance.');
    lines.push('You CANNOT point at them: "frameId" must name one of the frames listed above, because');
    lines.push('those are the only frames we have a camera pose for, and a locator we cannot project');
    lines.push('back into the geometry is dropped. If a reference image shows a part that none of our');
    lines.push('frames cover, do not cite it - return no proposal for that part and fill in');
    lines.push('"suggestView" saying what to render, and we will look again.');
    extras.forEach((im, i) => lines.push(`  [ref ${i + 1}] ${im.name || 'unnamed'} (${im.mediaType || 'image/png'})`));
    for (const im of extras) {
      images.push({ mediaType: im.mediaType || 'image/png', dataBase64: im.dataBase64, name: `ref:${im.name || `human-${images.length}`}` });
    }
  }

  return {
    text: lines.join('\n'),
    images,
    // What was actually sent, so the persisted reply can be read back against the
    // frames it was produced from. Without this, an answer naming frame "v48"
    // cannot be checked after the fact.
    frames: enriched.map((f, i) => ({
      index: i + 1, id: f.id, mode: f.mode || 'photo', viewId: f.viewId || null,
      spec: f.spec || null,
      covers: Array.isArray(f.covers) ? f.covers.length : (f.covers ?? null),
      sees: Array.isArray(f.sees) ? f.sees : null,
      // A stored entry holds the colour map's FILENAME until it is loaded, and
      // Object.keys of a string counts characters — so require a real object.
      colors: f.colorMap && typeof f.colorMap === 'object' ? Object.keys(f.colorMap).length : 0,
      attached: images.some((im) => im.name === String(f.id)),
    })),
    // What the human added, recorded the same way: an audit trail that says a
    // round was steered, and by how many pictures, without keeping the bytes.
    references: extras.map((im, i) => ({ index: i + 1, name: im.name || null, mediaType: im.mediaType || 'image/png' })),
    warnings,
  };
}

// The ONE strict retry a discovery turn gets when its reply carried no
// parseable proposals at all (prose essay, empty text, broken JSON). A format
// failure is not a judgement: the model often read the machine perfectly and
// then answered the wrong QUESTION — an essay about what it saw instead of the
// array the grounding gate reads. Appended to the SAME prompt over the SAME
// frames, so nothing is re-rendered and no new evidence is invented; the reply
// is quoted back to the model because "here is what you said" is the cheapest
// possible proof that the format, not the content, was the problem.
export function strictSchemaReminder(previousReply) {
  const excerpt = String(previousReply || '').trim().slice(0, 600);
  const lines = [
    '',
    '--- STRICT FORMAT RETRY ---',
    'Your previous reply could not be used: it did not contain a parseable JSON array of proposals,',
    'so nothing in it could be grounded on the mesh and the round was about to end empty-handed.',
  ];
  if (excerpt) {
    lines.push('Your previous reply began:');
    lines.push('"""');
    lines.push(excerpt);
    lines.push('"""');
  }
  lines.push(
    'Answer again for the SAME frames, with ONLY the JSON array the schema above asks for —',
    'no prose before or after it. Keep every part you identified: each one becomes an object with',
    '{"op":"new","type":...,"frameId":...,"regionBox":[x0,y0,x1,y1] as fractions,...} exactly as specified.',
    'If you truly see no moving parts at all, reply with an empty array: []',
  );
  return lines.join('\n');
}

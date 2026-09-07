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
import { constraintSummary } from './manifest.mjs';

export const MAX_VISION_FRAMES = 12;
// A colour legend beyond this stops being readable and starts costing more tokens
// than the grounding it saves; the model can still report a hex it sees.
export const MAX_LEGEND = 40;

const MODE_EXPLAINS = {
  photo: 'an ordinary opaque render — what a photograph of the assembly would show',
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
  if (s.kind === 'cell') bits.push(`zoomed into one region of ${s.members ?? '?'} parts`);
  else if (s.kind === 'close-up') bits.push('close-up of one region');
  else bits.push('whole-model view');
  // `covers` is a NAME LIST on a plan view and a COUNT on a stored frame entry.
  // Both shapes reach here, and printing an array would read as "~[object Array]".
  const n = Array.isArray(frame.covers) ? frame.covers.length : frame.covers;
  if (Number.isFinite(n)) bits.push(`shows ~${n} parts`);
  if (Array.isArray(frame.focus) && frame.focus.length) bits.push(`focused on: ${frame.focus.slice(0, 6).join(', ')}`);
  return bits.join(', ');
}

// The colour legend for a mask frame. Kept beside the frame it belongs to so the
// model does not have to hold one global table in mind across twelve images.
function legendLine(frame) {
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

// Build the turn. Returns { text, images, frames, warnings } where `images` is
// exactly the shape agent.send() wants: [{ mediaType, dataBase64, name }].
//
// `frames` in: [{ id, mode, spec, pose, covers, focus, colorMap, mediaType,
//                dataBase64 }] — i.e. observation entries joined with the bytes
//                read back off disk and, where available, the plan view that
//                asked for them.
export function buildVisionPrompt({
  manifest = null, frames = [], plan = null, maxFrames = MAX_VISION_FRAMES, question = null,
} = {}) {
  const warnings = [];
  const wanted = Array.isArray(frames) ? frames : [];
  if (wanted.length > maxFrames) warnings.push(`truncated ${wanted.length} frames to ${maxFrames}`);
  const used = wanted.slice(0, Math.max(0, maxFrames | 0));

  // Join each frame to the plan view that produced it, so the manifest line can
  // say how many parts the planner expected to be visible. That number is what
  // makes a hallucination detectable later: a part named from a frame whose pose
  // cannot show it is not a discovery, it is an invention.
  const viewById = new Map((plan?.views || []).map((v) => [v.id, v]));
  const enriched = used.map((f) => {
    const v = viewById.get(f.viewId || f.id) || null;
    return {
      ...f,
      covers: f.covers ?? v?.covers ?? null,
      sees: f.sees ?? v?.sees ?? null,
      spec: f.spec ?? v?.spec ?? null,
    };
  });

  const constraints = constraintSummary(manifest);
  const lines = [];
  lines.push('You are the VISION producer in a rigged-mesh joint-discovery loop.');
  lines.push('You are looking at RENDERED FRAMES of one 3D CAD assembly (a machine with moving');
  lines.push('parts), drawn by us from poses we chose. They are not photographs: there is no');
  lines.push('lighting realism, no branding, and some frames are deliberately altered — each');
  lines.push('frame below says exactly how.');
  lines.push('');
  lines.push(question || 'TASK: identify the parts of this machine that MOVE RELATIVE to the rest,');
  lines.push('and say what kind of motion each has.');
  lines.push('  rotor  - spins continuously about one axis (propeller, fan, motor, gimbal roll)');
  lines.push('  gimbal - pivots about a point over a limited range (camera mount, turret)');
  lines.push('  hinge  - rotates about an axis over a limited range (folding arm, landing gear,');
  lines.push('           control surface, bay door)');
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
  lines.push('   "type": "rotor|gimbal|hinge",');
  lines.push('   "frameId": "<frame id>", "regionBox": [x0,y0,x1,y1], "regionColors": ["#rrggbb"],');
  lines.push('   "nodeIds": ["<only if we gave you names below>"],');
  lines.push('   "axis": [x,y,z], "anchor": [x,y,z],');
  lines.push('   "reasoning": "what you see that makes this a moving part",');
  lines.push('   "uncertainties": ["what you are NOT sure about, stated plainly"],');
  lines.push('   "suggestView": { "target": "what to look at", "reason": "why it would settle it" } }]');
  lines.push('');
  lines.push('Rules:');
  lines.push('- The scene is Z-UP. A rotor\'s spin axis is usually [0,0,1]; a folding arm\'s');
  lines.push('  hinge is usually horizontal. axis and anchor are in MODEL world units.');
  lines.push('- anchor is the point the part rotates ABOUT (a rotor hub, not a blade tip).');
  lines.push('- Report the MOVING GROUP, not one fastener: all blades of one propeller belong');
  lines.push('  to one rotor. Use several regionColors or a box around the whole hub.');
  lines.push('- Parts listed in VALIDATED CONSTRAINTS are already claimed. Do not re-propose');
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
  lines.push(constraints.length ? 'VALIDATED CONSTRAINTS (already claimed - subtract from your search):' : 'VALIDATED CONSTRAINTS: (none yet - nothing is claimed)');
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
    warnings,
  };
}

// Motion prompt — the multi-image turn that asks a VLM what a MOVING joint IS,
// and whether its motion is sensible. Phase 3, task 18.
//
// This is NOT the vision prompt with a fan of pictures. The difference is the
// QUESTION, and the question is different because the measurement already
// happened:
//
//   vision-prompt  "what parts MOVE, and where are they?"  — discovery. The model
//                   POINTS (frame + region/colour) and grounding resolves names,
//                   because nothing is known yet.
//   motion-prompt  "this joint is already found and already measured; is the way
//                   it moves SENSIBLE, and what is the moving thing?" — semantics.
//
// Which nodes move, and by how much, is measured exactly by the rigidity gate and
// the preview pivot long before this turn exists. So nothing here is a measurement
// and the model is told so explicitly: it is given the type, the axis and the node
// count as FACTS, and asked only for the judgement a picture can inform and a
// covariance matrix cannot — "does that look like a propeller spinning, or like a
// panel tearing itself off the wing?".
//
// The frames are ONE joint driven through a fan of angles from a FIXED camera, so
// the only thing that changes between them is this joint's own rotation. Text says
// "frame 2 = 30 deg" AUTHORITATIVELY; the small burned-in corner tag is redundancy
// against a model that reorders the images, never the primary annotation.
//
// Pure: builds strings and an image list. vision-provider.mjs does the transport,
// so this is testable headless with no agent and no model.

// A fan is small BY DESIGN — a few poses plus one swept composite. Capping here
// rather than trusting the caller keeps a stray large `angles` array from turning a
// semantic check into a twelve-frame survey that answers a question nobody asked.
export const MAX_MOTION_FRAMES = 8;

// The claimed type in plain mechanical language, so the model judges the motion
// against what we say it is rather than guessing our vocabulary. A joint whose
// type is somehow unknown still gets a neutral frame — the question "is this
// motion sensible" is answerable without it.
const TYPE_EXPLAINS = {
  rotor: 'a part that SPINS CONTINUOUSLY about one axis (a propeller, fan, motor, or gimbal roll)',
  gimbal: 'a part that PIVOTS about a point over a LIMITED range (a camera mount or turret)',
  hinge: 'a part that ROTATES about an axis over a LIMITED range (a folding arm, landing gear, control surface, or bay door)',
};

// Round a measured vector for display without implying more precision than the
// render has. The model is told these are facts, so they must read as facts.
const axis = (v) => (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
  ? `[${[v.x, v.y, v.z].map((n) => Number(n).toFixed(2)).join(', ')}]`
  : null);

// One authoritative line per frame. The angle is the annotation that matters; the
// corner tag is named so the model knows the burned-in text is ours, not the
// machine's, and is only a reordering aid.
function motionFrameLine(f, i) {
  const deg = Number.isFinite(f.angle) ? `${f.angle}\u00b0` : '?';
  const tag = f.tag ? ` (corner tag reads "${f.tag}")` : '';
  return `frame ${i + 1} = pose ${f.index ?? i + 1}, joint driven to ${deg}${tag}`;
}

// Build the turn. Returns { text, images, frames, composite, warnings } where
// `images` is exactly the shape vision-provider.send() wants:
// [{ mediaType, dataBase64, name }].
//
// in:
//   joint      the EXISTING record being characterised: { id, type, label, axis,
//              anchor, nodes } — its geometry is stated as measured fact.
//   frames     [{ index, angle, tag, id, mediaType, dataBase64 }] the fan poses,
//              bytes already read back off disk.
//   composite  { id, kind, mediaType, dataBase64 } the swept onion-skin, or null.
export function buildMotionPrompt({ joint = null, frames = [], composite = null, mode = 'photo' } = {}) {
  const warnings = [];
  const wanted = Array.isArray(frames) ? frames : [];
  if (!wanted.length) warnings.push('motion fan carried no pose frames');
  const used = wanted.slice(0, MAX_MOTION_FRAMES);
  if (wanted.length > used.length) warnings.push(`truncated ${wanted.length} motion frames to ${used.length}`);

  const type = joint?.type || null;
  const typeLine = TYPE_EXPLAINS[type] || 'a part whose motion type we are not certain of';
  const axisText = axis(joint?.axis);
  const nodeCount = Array.isArray(joint?.nodes) ? joint.nodes.length : null;

  const lines = [];
  lines.push('You are the MOTION producer in a rigged-mesh joint-discovery loop.');
  lines.push('You are looking at a SHORT SEQUENCE OF RENDERED FRAMES of one 3D CAD assembly.');
  lines.push('They are not a video and not photographs: we drew them ourselves by driving ONE');
  lines.push('joint through a fan of angles from a SINGLE FIXED CAMERA. The camera never moves,');
  lines.push('the rest of the machine never moves — the ONLY thing that changes between frames');
  lines.push('is this one joint\'s own rotation. The last image, if present, overlays every pose');
  lines.push('into one swept picture (earliest pose faintest) so the arc of motion is visible at once.');
  lines.push('Each pose also carries a small burned-in corner tag repeating its angle. That tag is ONLY');
  lines.push('a reordering aid: if the images reach you out of order, trust the tag and the authoritative');
  lines.push('text lines below over the arrival order. Never describe the tag back to us.');
  lines.push('');
  lines.push('WHAT WE ALREADY KNOW (measured exactly — do NOT re-measure or second-guess these):');
  lines.push(`  - joint id: ${joint?.id || '(unknown)'}`);
  lines.push(`  - claimed motion type: ${type || '(none)'} — ${typeLine}`);
  if (axisText) lines.push(`  - rotation axis (model world units, Z is UP): ${axisText}`);
  if (Number.isFinite(nodeCount)) lines.push(`  - the moving group is ${nodeCount} mesh node(s), already selected and rigidity-checked`);
  lines.push('  Which nodes move, and by how much, has already been measured. That is settled.');
  lines.push('');
  lines.push('YOUR TASK IS SEMANTIC ONLY. Look at the motion and answer two things:');
  lines.push('  1. WHAT is this moving thing, in plain mechanical terms? (e.g. "a two-blade');
  lines.push('     propeller", "a camera gimbal yaw stage", "a folding landing-gear leg",');
  lines.push('     "a hinged bay door"). Name the FUNCTION you see, not our internal ids.');
  lines.push('  2. IS THE MOTION SENSIBLE for that thing? Judge only what a picture can show:');
  lines.push('     - does the part rotate cleanly about its axis, or does it appear to shear,');
  lines.push('       detach, or intersect the rest of the machine as it moves?');
  lines.push('     - does the ARC match the claimed type? (a rotor should look able to keep');
  lines.push('       spinning; a hinge or gimbal should sweep a limited, purposeful range)');
  lines.push('     - does the moving group look like ONE coherent assembly, or does it seem to');
  lines.push('       drag along parts that clearly should stay put?');
  lines.push('');
  lines.push('Reply with JSON ONLY (no prose, no code fences), ONE object:');
  lines.push('{ "label": "<short plain-English name for the moving thing>",');
  lines.push('  "observedType": "rotor|gimbal|hinge|static",');
  lines.push('  "motionSensible": true|false,');
  lines.push('  "reasoning": "<what you SEE that makes the motion sensible or not>",');
  lines.push('  "uncertainties": ["<what you are NOT sure about, stated plainly>"],');
  lines.push('  "confidence": 0.0 }');
  lines.push('');
  lines.push('Rules:');
  lines.push('- "observedType" is what the motion LOOKS LIKE, which may differ from the claimed');
  lines.push('  type above — that disagreement is exactly the signal we want, so report it');
  lines.push('  honestly rather than echoing our claim. Use "static" if nothing appears to move.');
  lines.push('- "motionSensible" is a judgement about the MOTION, not about our measurements. If');
  lines.push('  the part visibly tears away from or clips through the machine, say false and say');
  lines.push('  why in "reasoning".');
  lines.push('- If you genuinely cannot tell from these frames, set "motionSensible" to false is');
  lines.push('  WRONG — instead put the doubt in "uncertainties" and lower "confidence". An');
  lines.push('  honest "I cannot tell" is useful; a confident guess is not.');
  lines.push('- Never describe the render itself (background, colours, the corner tag, the');
  lines.push('  overlay). Describe the MACHINE and its MOTION.');
  lines.push('');
  lines.push(`FRAMES (${used.length} pose${used.length === 1 ? '' : 's'} attached, in angle order):`);
  used.forEach((f, i) => lines.push(`  ${motionFrameLine(f, i)}`));
  if (composite) lines.push(`  frame ${used.length + 1} = swept composite (all poses overlaid, earliest faintest)`);
  else lines.push('  (no swept composite was attached — judge from the individual poses)');

  const images = [];
  for (const f of used) {
    if (!f.dataBase64) { warnings.push(`motion frame ${f.index ?? '?'} has no image bytes; described in text but not attached`); continue; }
    images.push({ mediaType: f.mediaType || 'image/png', dataBase64: f.dataBase64, name: String(f.id ?? `pose_${f.index}`) });
  }
  if (composite?.dataBase64) {
    images.push({ mediaType: composite.mediaType || 'image/png', dataBase64: composite.dataBase64, name: String(composite.id ?? 'sweep') });
  } else if (composite) {
    warnings.push('swept composite had no image bytes; described in text but not attached');
  }
  if (!images.length) warnings.push('no motion frame carried image bytes - the model will be reasoning from text alone');

  return {
    text: lines.join('\n'),
    images,
    // What was actually sent, so the persisted record can be read back against the
    // frames it was produced from — the same falsifiability a vision round has.
    frames: used.map((f, i) => ({
      index: f.index ?? i + 1, angle: Number.isFinite(f.angle) ? f.angle : null,
      id: f.id ?? null, tag: f.tag ?? null, mode: mode || 'photo',
      attached: images.some((im) => im.name === String(f.id ?? `pose_${f.index}`)),
    })),
    composite: composite ? { id: composite.id ?? null, kind: composite.kind || 'sweep', attached: !!composite.dataBase64 } : null,
    joint: { id: joint?.id ?? null, type, axisText, nodeCount },
    warnings,
  };
}

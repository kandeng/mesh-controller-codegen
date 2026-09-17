// The scope audit — the EYE that inspects the cut.
//
// Geometry is the carver: grounding.mjs projects the pointed box through the
// frame's camera and keeps every mesh node whose box lands inside it. That is
// correct and stays. But "lands inside the box" is a geometric fact, not a
// semantic one — a wheel-face disc authored at the hub is physically inside any
// truthful wheel box, so the carver keeps it, and nothing downstream ever LOOKS
// at the cut to ask whether it is actually one wheel. The marussia's front-left
// wheel carried a skull this way: the node `rim_wheeldark_0` IS a skull-and-jaw
// disc, the box contains it, every prune rule correctly keeps it, and the
// highlight showed a skull at the hub.
//
// This module is the missing eye. It runs AFTER the carve and BEFORE the
// battery/manifest, and it never carves: geometry keeps that job. Vision only
// INSPECTS, in two bounded turns:
//
//   STEP 2  solo-render the whole carved scope (the renderer already hides
//           everything outside a focus set) and ask ONE question: "this is
//           supposed to be exactly one <part>; is everything here part of a
//           <part>? Name anything that is not." A clean answer changes nothing.
//   STEP 3  only when step 2 objects: solo-render EACH member node alone, ask
//           which single picture is the foreign thing it named, and drop exactly
//           that node. The drop is geometric and deterministic again — vision
//           picked a node, the code removes it — and it is announced as an
//           uncertainty, never applied silently.
//   STEP 4  the ADD direction: the carve can also be too SMALL (a door scope
//           holding only the glass). Unclaimed neighbour nodes near the scope
//           are solo-rendered ALONGSIDE the scope and the model is asked which
//           pictures are missing members of the <part>; the picks are added by
//           the caller, deterministically, announced as uncertainties.
//
// The prompt builders and parsers are PURE (no capture, no model) so they are
// testable headless with a faked reply; `auditScope` is the thin orchestrator
// that injects the same `capture`/`propose` effects every other turn uses.
//
// Cost: ONE vision call per dictionary-named joint for step 2, one more when
// step 4 has neighbour candidates, plus member renders ONLY when step 2
// objects or step 4 runs. A record with no dictionary part name is never
// audited — there is no word to audit it against.
import { neighborsOf } from './scope-slots.mjs';

export const SCOPE_AUDIT_MARK = 'SCOPE AUDIT step';
export const isScopeAuditPrompt = (text) => String(text || '').includes(SCOPE_AUDIT_MARK);

// A one-node scope has nothing to drop without emptying the joint, so it is
// never sent to step 3. Step 2 still runs on it (a lone node can be the wrong
// part entirely), but an objection there is recorded as doubt, not as a drop.
export const MIN_AUDIT_NODES = 2;

// Fence-tolerant extraction of the FIRST JSON OBJECT from a raw reply. The
// proposal channel's parseReply is array-shaped; an audit reply is one object,
// so it gets its own tiny extractor with the same tolerance for a model that
// wraps its answer in prose or ```json fences despite being told not to.
function firstObject(reply) {
  const text = String(reply || '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return { obj: null, warning: 'no JSON object found in reply' };
  try {
    const parsed = JSON.parse(body.slice(a, b + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { obj: null, warning: 'parsed value is not an object' };
    }
    return { obj: parsed, warning: null };
  } catch (e) {
    return { obj: null, warning: `JSON parse failed: ${e.message}` };
  }
}

// One image attachment in the shape propose(text, images) already uses.
function image(frame, name) {
  return {
    mediaType: frame?.mediaType || 'image/png',
    dataBase64: frame?.dataBase64,
    name: String(name),
  };
}

// STEP 2 — "is this exactly one <part>?" over a solo render of the whole scope.
// Returns { text, images, warnings }. `frame` is the solo capture of the scope.
export function buildScopeAuditPrompt({ part, frame = null } = {}) {
  const warnings = [];
  const word = String(part || 'part');
  if (!frame?.dataBase64) {
    return { text: null, images: [], warnings: ['no solo render of the scope to audit'] };
  }
  const lines = [];
  lines.push(`You are the ${SCOPE_AUDIT_MARK} of a rigged-mesh joint-discovery loop.`);
  lines.push('An earlier step cut what it believes is ONE moving part out of a 3D CAD');
  lines.push('assembly, by geometry. We then rendered ONLY that cut from the same camera');
  lines.push('that pointed at it: every other piece of the model is hidden, so everything');
  lines.push('you can see in the attached picture IS the scope we cut — no background, no');
  lines.push('neighbouring parts.');
  lines.push('');
  lines.push(`The cut is supposed to be exactly ONE ${word} — nothing else.`);
  lines.push('');
  lines.push('QUESTION: is everything in this picture part of a single ' + word + '?');
  lines.push(`If something in it is NOT part of a ${word}, name that thing in plain words`);
  lines.push('(for example "a skull", "a seat", "a headlight", "a suspension spring"). If it');
  lines.push(`is all ${word}, say it is clean.`);
  lines.push('');
  lines.push('Reply with JSON ONLY (no prose, no code fences):');
  lines.push('{ "allPart": true | false, "notPart": ["<plain-word name of each thing that is not a ' + word + '>"] }');
  lines.push('');
  lines.push('Rules:');
  lines.push('- "notPart" is EMPTY when "allPart" is true.');
  lines.push('- Name a foreign thing by what it LOOKS LIKE. You do NOT know our internal');
  lines.push('  mesh/node names and must NOT invent or guess one.');
  lines.push('- Judge only the SOLID geometry shown. Ignore transparency, the background,');
  lines.push('  any grid, and the rendering style — describe the OBJECT, not the render.');
  lines.push('- A wheel/rim/tyre, a brake disc and caliper, a hub are all part of a wheel.');
  lines.push('  A skull, a face, a body panel, a light are not.');
  return { text: lines.join('\n'), images: [image(frame, frame.id || 'scope')], warnings };
}

// Parse the step-2 reply. Returns { clean, foreign[], warnings }.
// `clean` is true when the model said the scope is all <part> (or named nothing);
// otherwise `foreign` carries the plain-word names of the things it objected to.
export function parseScopeAudit(reply) {
  const warnings = [];
  const { obj, warning } = firstObject(reply);
  if (!obj) {
    // An unreadable audit is NOT a clean bill of health and NOT an objection we
    // can act on: report it and leave the scope exactly as geometry carved it.
    warnings.push(`the scope-audit reply was unreadable (${warning}) — the scope was left as carved`);
    return { clean: true, foreign: [], warnings };
  }
  const foreign = Array.isArray(obj.notPart)
    ? obj.notPart.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
    : [];
  const allPart = obj.allPart === true || obj.allPart === 'true';
  const clean = allPart || foreign.length === 0;
  if (!clean && !foreign.length) warnings.push('the audit objected but named nothing — treated as clean');
  return { clean, foreign, warnings };
}

// STEP 3 — "which single piece is the foreign thing?" over one solo render per
// member node. `members` is [{ name, frame }] in the order the pictures are
// attached. The model is shown PICTURE NUMBERS only and never our node names
// (it does not know them, and a name like "brake_Material #149_0" invites a
// mistyped answer); we map the chosen number back to a node ourselves, which is
// what keeps the drop deterministic.
// Returns { text, images, warnings }.
export function buildMemberAuditPrompt({ part, foreign = '', members = [] } = {}) {
  const warnings = [];
  const word = String(part || 'part');
  const usable = (members || []).filter((m) => m?.frame?.dataBase64);
  if (!usable.length) {
    return { text: null, images: [], warnings: ['no member solo renders to choose between'] };
  }
  if (usable.length !== (members || []).length) {
    warnings.push(`${(members || []).length - usable.length} member(s) produced no solo render and are not shown`);
  }
  const obj = String(foreign || 'the thing that is not part of it');
  const lines = [];
  lines.push(`You are the ${SCOPE_AUDIT_MARK} of a rigged-mesh joint-discovery loop, continuing.`);
  lines.push(`The scope we cut for ONE ${word} contains something that is not a ${word}: you`);
  lines.push(`named it "${obj}".`);
  lines.push('');
  lines.push(`We have now rendered EACH piece of that cut ALONE — one picture per piece, in`);
  lines.push(`the order below. Exactly one of these pieces is the "${obj}"; the rest are`);
  lines.push(`genuine parts of a ${word}.`);
  lines.push('');
  usable.forEach((m, i) => lines.push(`  Picture ${i + 1} = piece ${i + 1}`));
  lines.push('');
  lines.push(`QUESTION: which picture is the "${obj}"? Reply with its picture NUMBER.`);
  lines.push('');
  lines.push('Reply with JSON ONLY (no prose, no code fences):');
  lines.push(`{ "impostor": <an integer from 1 to ${usable.length}> }`);
  lines.push('');
  lines.push('Rules:');
  lines.push('- Pick exactly ONE number: the picture that IS the "' + obj + '".');
  lines.push('- If NONE of the pieces is the "' + obj + '" on its own (it only appeared when');
  lines.push('  they were shown together), reply { "impostor": 0 } and we will drop nothing.');
  lines.push('- Judge only the SOLID geometry; ignore transparency, background and render style.');
  return {
    text: lines.join('\n'),
    images: usable.map((m, i) => image(m.frame, m.frame.id || `piece_${i + 1}`)),
    warnings,
  };
}

// Parse the step-3 reply. `names` is the member node names in the SAME order the
// pictures were attached (only the members that rendered — the caller passes the
// usable list). Returns { impostor: name|null, index, warnings }. An impostor of
// 0, an out-of-range number, or an unreadable reply all yield null: nothing is
// dropped unless the model pointed at exactly one real piece.
export function parseMemberAudit(reply, names = []) {
  const warnings = [];
  const list = (names || []).map(String);
  const { obj, warning } = firstObject(reply);
  if (!obj) {
    warnings.push(`the member-audit reply was unreadable (${warning}) — nothing was dropped`);
    return { impostor: null, index: null, warnings };
  }
  const raw = Number(obj.impostor);
  if (!Number.isFinite(raw)) {
    warnings.push('the member audit named no picture number — nothing was dropped');
    return { impostor: null, index: null, warnings };
  }
  const idx = Math.trunc(raw);
  if (idx === 0) {
    warnings.push('the member audit could not isolate the foreign thing in any single piece — nothing was dropped');
    return { impostor: null, index: 0, warnings };
  }
  if (idx < 1 || idx > list.length) {
    warnings.push(`the member audit picked picture ${idx}, which is out of range (1..${list.length}) — nothing was dropped`);
    return { impostor: null, index: null, warnings };
  }
  return { impostor: list[idx - 1], index: idx, warnings };
}

// STEP 4 — the add direction. `neighbours` is [{ name, frame }]: unclaimed
// nodes sitting just outside the carved scope, each rendered ALONE. Picture 1
// is ALWAYS the current scope (rendered whole) so the model knows what it is
// looking at; pictures 2..N are the candidates. Like step 3 the model sees
// PICTURE NUMBERS only and never our node names; we map its picks back, which
// is what keeps the add deterministic.
// Returns { text, images, warnings }.
export function buildMemberAddPrompt({ part, scopeFrame = null, neighbours = [] } = {}) {
  const warnings = [];
  const word = String(part || 'part');
  const usable = (neighbours || []).filter((m) => m?.frame?.dataBase64);
  if (!usable.length) {
    return { text: null, images: [], warnings: ['no neighbour solo renders to offer'] };
  }
  if (!scopeFrame?.dataBase64) {
    return { text: null, images: [], warnings: ['no solo render of the scope to offer beside the candidates'] };
  }
  const lines = [];
  lines.push(`You are the ${SCOPE_AUDIT_MARK} of a rigged-mesh joint-discovery loop, continuing.`);
  lines.push(`We cut what we believe is ONE ${word} out of a 3D CAD assembly. The cut may be`);
  lines.push('INCOMPLETE: mesh nodes are often split (a panel in one node, its window trim in');
  lines.push('another), and geometry alone can leave a genuine piece outside the cut.');
  lines.push('');
  lines.push('  Picture 1 = the cut we have so far, rendered ALONE (everything else hidden).');
  usable.forEach((m, i) => lines.push(`  Picture ${i + 2} = a neighbouring piece that is NOT in the cut, rendered ALONE.`));
  lines.push('');
  lines.push(`QUESTION: which of the neighbouring pieces (pictures 2 to ${usable.length + 1}) are`);
  lines.push(`missing members of the SAME single ${word} shown in picture 1?`);
  lines.push('');
  lines.push('Reply with JSON ONLY (no prose, no code fences):');
  lines.push(`{ "belongs": [<picture numbers, each an integer from 2 to ${usable.length + 1}>] }`);
  lines.push('');
  lines.push('Rules:');
  lines.push(`- Include a piece ONLY if it is physically part of the SAME single ${word} —`);
  lines.push('  the same door as the door, the same wheel as the wheel. When in doubt, leave');
  lines.push('  it out: a missing piece is cheaper than a wrong one.');
  lines.push('- NEVER include picture 1 in "belongs"; it is the cut itself, not a candidate.');
  lines.push('- If no piece belongs, reply { "belongs": [] }.');
  lines.push('- Judge only the SOLID geometry; ignore transparency, background and render style.');
  return {
    text: lines.join('\n'),
    images: [
      image(scopeFrame, scopeFrame.id || 'scope'),
      ...usable.map((m, i) => image(m.frame, m.frame.id || `candidate_${i + 1}`)),
    ],
    warnings,
  };
}

// Parse the step-4 reply. `names` is the candidate node names in the SAME order
// the candidate pictures were attached (picture 2 = names[0], …). Returns
// { belongs: name[], warnings }. Unreadable replies, non-integers, out-of-range
// numbers and picture 1 all yield nothing: we add only what the model pointed
// at, exactly.
export function parseMemberAdd(reply, names = []) {
  const warnings = [];
  const list = (names || []).map(String);
  const { obj, warning } = firstObject(reply);
  if (!obj) {
    warnings.push(`the add-turn reply was unreadable (${warning}) — nothing was added`);
    return { belongs: [], warnings };
  }
  if (!Array.isArray(obj.belongs)) {
    warnings.push('the add turn returned no "belongs" list — nothing was added');
    return { belongs: [], warnings };
  }
  const belongs = [];
  for (const raw of obj.belongs) {
    const idx = Math.trunc(Number(raw));
    if (!Number.isFinite(idx)) continue;
    if (idx < 2 || idx > list.length + 1) {
      warnings.push(`the add turn picked picture ${idx}, which is not a candidate (2..${list.length + 1}) — that pick was ignored`);
      continue;
    }
    const name = list[idx - 2];
    if (name && !belongs.includes(name)) belongs.push(name);
  }
  return { belongs, warnings };
}

// The orchestrator: steps 2 and 3 over one carved scope, with the capture and
// propose effects injected exactly as every other turn injects them.
//
// `record`  a grounded proposal/record carrying `.part`, `.nodes`, `.id`.
// `view`    the camera to re-render the scope from — the pose the box was
//           pointed in, so the audit sees the cut from the angle it was found.
// `g`       the parsed geometry and `claimed` the set of node names already
//           owned by ANY record — both required for the step-4 add turn; when
//           absent only the drop direction runs.
// Returns { audited, clean, foreign[], dropped[], added[], reason, warnings }.
//   audited=false  the audit could not run (no part name, no capture/
//                  propose, no pose, a failed render) — the scope is untouched.
//   dropped        the node names removed (0 or 1); added  the neighbour node
//                  names step 4 recognised (0..cap). The CALLER applies both
//                  to record.nodes and records the uncertainty, so this stays a
//                  pure read of the model plus a deterministic pick.
export async function auditScope(record, {
  capture = null, propose = null, view = null, emit = null, persist = null,
  g = null, claimed = null,
} = {}) {
  const res = await dropPass(record, { capture, propose, view, emit, persist });
  res.added = [];
  if (!res.audited) return res;
  const add = await addTurn(record, res, { capture, propose, view, emit, persist, g, claimed });
  res.added = add.added;
  res.warnings.push(...add.warnings);
  return res;
}

// Steps 2–3: the drop direction, exactly as before — solo-render the scope,
// ask the one question, and only on objection isolate and drop the impostor.
async function dropPass(record, {
  capture = null, propose = null, view = null, emit = null, persist = null,
} = {}) {
  const say = typeof emit === 'function' ? emit : () => {};
  const warnings = [];
  const id = record?.id || '(record)';
  const part = record?.part || null;
  const nodes = (record?.nodes || []).map(String);
  const none = (reason) => ({ audited: false, clean: null, foreign: [], dropped: [], reason, warnings });

  if (!part) return none('no dictionary part name to audit the scope against');
  if (typeof capture !== 'function' || typeof propose !== 'function') {
    return none('no capture/propose effect is wired, so the scope was never looked at');
  }
  if (!view?.pose) return none('no camera pose to re-render the scope from');

  // STEP 2 — solo-render the whole scope and ask the one question.
  let scopeFrame = null;
  try {
    scopeFrame = await capture(view, 'solo', nodes);
  } catch (e) {
    warnings.push(`scope audit: the solo render of ${id} failed (${e.message}) — the scope was left as carved`);
    return { audited: false, clean: null, foreign: [], dropped: [], reason: 'the scope solo render failed', warnings };
  }
  if (!scopeFrame?.dataBase64) {
    warnings.push(`scope audit: the solo render of ${id} returned no image bytes — the scope was left as carved`);
    return { audited: false, clean: null, foreign: [], dropped: [], reason: 'the scope solo render was empty', warnings };
  }

  const p2 = buildScopeAuditPrompt({ part, frame: scopeFrame });
  warnings.push(...p2.warnings.map((w) => `scope audit: ${w}`));
  if (!p2.text) return { audited: false, clean: null, foreign: [], dropped: [], reason: 'no scope-audit prompt could be built', warnings };
  say('vision:scope-audit', { id, part, step: 2, nodes: nodes.length });

  let turn2 = null;
  try {
    turn2 = await propose(p2.text, p2.images);
  } catch (e) {
    warnings.push(`scope audit: the step-2 model call for ${id} failed (${e.message}) — the scope was left as carved`);
    return { audited: false, clean: null, foreign: [], dropped: [], reason: 'the step-2 model call failed', warnings };
  }
  const a2 = parseScopeAudit(turn2?.reply || '');
  warnings.push(...a2.warnings.map((w) => `scope audit: ${w}`));
  persist?.scopeAudit?.({
    id, part, step: 2, frameId: scopeFrame.id || null,
    prompt: { text: p2.text, images: p2.images.length },
    reply: turn2?.reply ?? null, model: turn2?.model ?? null,
    verdict: a2.clean ? 'clean' : 'objection', foreign: a2.foreign,
  });

  if (a2.clean) {
    say('vision:scope-clean', { id, part });
    return { audited: true, clean: true, foreign: [], dropped: [], reason: null, warnings };
  }

  const foreign = a2.foreign.join(', ');
  // An objection we cannot act on (a one-node scope) is recorded as doubt, never
  // as a drop: emptying the joint would be worse than leaving the skull in it.
  if (nodes.length < MIN_AUDIT_NODES) {
    warnings.push(`scope audit: the model named "${foreign}" inside the ${part} scope of ${id}, but it is a ${nodes.length}-node scope with nothing to drop — the doubt is recorded`);
    say('vision:scope-objection', { id, part, foreign: a2.foreign, dropped: [] });
    return { audited: true, clean: false, foreign: a2.foreign, dropped: [], reason: 'objection on a one-node scope', warnings };
  }

  // STEP 3 — solo-render each member alone, ask which single piece is the intruder.
  const members = [];
  for (const name of nodes) {
    let f = null;
    try {
      f = await capture(view, 'solo', [name]);
    } catch { f = null; }
    if (f?.dataBase64) members.push({ name, frame: f });
    else warnings.push(`scope audit: the solo render of member "${name}" of ${id} produced no image — it cannot be picked as the impostor`);
  }
  if (members.length < MIN_AUDIT_NODES) {
    warnings.push(`scope audit: only ${members.length} member(s) of ${id} could be rendered alone, so the "${foreign}" could not be isolated — the objection is recorded but nothing was dropped`);
    say('vision:scope-objection', { id, part, foreign: a2.foreign, dropped: [] });
    return { audited: true, clean: false, foreign: a2.foreign, dropped: [], reason: 'too few members rendered alone', warnings };
  }

  const p3 = buildMemberAuditPrompt({ part, foreign, members });
  warnings.push(...p3.warnings.map((w) => `scope audit: ${w}`));
  say('vision:scope-audit', { id, part, step: 3, members: members.map((m) => m.name) });

  let turn3 = null;
  try {
    turn3 = await propose(p3.text, p3.images);
  } catch (e) {
    warnings.push(`scope audit: the step-3 model call for ${id} failed (${e.message}) — the objection is recorded but nothing was dropped`);
    say('vision:scope-objection', { id, part, foreign: a2.foreign, dropped: [] });
    return { audited: true, clean: false, foreign: a2.foreign, dropped: [], reason: 'the step-3 model call failed', warnings };
  }
  const a3 = parseMemberAudit(turn3?.reply || '', members.map((m) => m.name));
  warnings.push(...a3.warnings.map((w) => `scope audit: ${w}`));
  persist?.scopeAudit?.({
    id, part, step: 3, foreign,
    members: members.map((m) => ({ name: m.name, frameId: m.frame.id || null })),
    prompt: { text: p3.text, images: p3.images.length },
    reply: turn3?.reply ?? null, model: turn3?.model ?? null,
    impostor: a3.impostor,
  });

  const dropped = a3.impostor ? [a3.impostor] : [];
  if (dropped.length) {
    warnings.push(`scope audit: the model named "${foreign}" inside the ${part} scope of ${id} and identified "${dropped[0]}" as it — that node was dropped from the joint`);
  } else {
    warnings.push(`scope audit: the model named "${foreign}" inside the ${part} scope of ${id}, but no single piece could be identified as it — nothing was dropped, and the doubt is recorded`);
  }
  say('vision:scope-objection', { id, part, foreign: a2.foreign, dropped });
  return { audited: true, clean: false, foreign: a2.foreign, dropped, reason: null, warnings };
}

// STEP 4 — the add direction. The carve can be too small as well as too big:
// on the marussia a door scope held only the glass nodes while the door panel
// sat unclaimed beside it. Unclaimed neighbours within reach of the scope are
// solo-rendered, shown beside the cut, and the model picks which are missing
// members. Neighbours are OFFERED IN ONE TURN (no fixed iteration count): each
// pass re-reads the claimed set, so a node handed to an earlier record is
// never offered again, and a record only ever grows by what the model
// recognises — a wrong add stays legible as an uncertainty, exactly like a
// wrong drop.
async function addTurn(record, dropRes, {
  capture = null, propose = null, view = null, emit = null, persist = null,
  g = null, claimed = null,
} = {}) {
  const say = typeof emit === 'function' ? emit : () => {};
  const warnings = [];
  const none = () => ({ added: [], warnings });
  if (!g || !(claimed instanceof Set)) return none();
  const id = record?.id || '(record)';
  const part = record?.part || null;

  // The effective scope: what the record holds AFTER the drop direction ran.
  const effNodes = (record?.nodes || []).map(String)
    .filter((n) => !(dropRes.dropped || []).includes(n));
  if (!effNodes.length) return none();

  const eff = { ...record, nodes: effNodes };
  const neighbours = neighborsOf(eff, g, null, claimed);
  if (!neighbours.length) return none();

  // Re-render the effective scope solo: the step-2 frame predates any drop and
  // would show the impostor as a member.
  let scopeFrame = null;
  try {
    scopeFrame = await capture(view, 'solo', effNodes);
  } catch { scopeFrame = null; }
  if (!scopeFrame?.dataBase64) {
    warnings.push(`scope audit: the add turn could not re-render the scope of ${id} — nothing was offered for addition`);
    return none();
  }

  const cands = [];
  for (const name of neighbours) {
    let f = null;
    try {
      f = await capture(view, 'solo', [name]);
    } catch { f = null; }
    if (f?.dataBase64) cands.push({ name, frame: f });
    else warnings.push(`scope audit: the add turn could not render neighbour "${name}" of ${id} alone — it was not offered`);
  }
  if (!cands.length) return none();

  const p4 = buildMemberAddPrompt({ part, scopeFrame, neighbours: cands });
  warnings.push(...p4.warnings.map((w) => `scope audit: ${w}`));
  if (!p4.text) return none();
  say('vision:scope-audit', { id, part, step: 4, candidates: cands.map((m) => m.name) });

  let turn4 = null;
  try {
    turn4 = await propose(p4.text, p4.images);
  } catch (e) {
    warnings.push(`scope audit: the step-4 model call for ${id} failed (${e.message}) — nothing was added`);
    return none();
  }
  const a4 = parseMemberAdd(turn4?.reply || '', cands.map((m) => m.name));
  warnings.push(...a4.warnings.map((w) => `scope audit: ${w}`));
  persist?.scopeAudit?.({
    id, part, step: 4,
    candidates: cands.map((m) => ({ name: m.name, frameId: m.frame.id || null })),
    prompt: { text: p4.text, images: p4.images.length },
    reply: turn4?.reply ?? null, model: turn4?.model ?? null,
    added: a4.belongs,
  });

  // A pick the caller cannot use (claimed by another record mid-audit) is not
  // ours to hand out.
  const added = a4.belongs.filter((n) => !claimed.has(String(n)));
  if (added.length) {
    warnings.push(`scope audit: the model recognised ${added.join(', ')} as missing member(s) of the ${part} scope of ${id} — offered to the caller for addition`);
    say('vision:scope-add', { id, part, added });
  }
  return { added, warnings };
}

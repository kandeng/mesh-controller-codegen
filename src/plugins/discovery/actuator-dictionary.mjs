// The actuator dictionary — a STATIC, deterministic answer to "what does a
// machine of this kind usually move?", asked of qwen3.8-max once and frozen
// here as data.
//
// Why data and not a runtime model call: the category prior (expectation.mjs)
// already asks the model what a machine usually has, and the answer changes
// run to run — the same Porsche was expected to have 4 doors on one run and 2
// on the next, which made the expected-vs-found gap check unrepeatable. A
// dictionary makes the EXPECTED side of that check a constant, so the only
// variable left is what the discovery turn actually grounded. The model still
// does what only it can: recognize the category from pixels, and point at the
// places each kind of part lives.
//
// Two consumers, one boundary each:
//
//   1. THE EXPECTATION LANE reconciles its counts against this table
//      (reconcileExpectation): the dictionary's per-motion totals are the
//      counts to falsify, and its names are the reference list the discovery
//      turn is shown as a hypothesis. NOTHING here mints a record — the lane's
//      hard boundary (no path to mergeProposals) is unchanged.
//
//   2. THE RECOGNITION GATE (applyRecognitionGate) is the second half of the
//      dual admission rule: a candidate is LISTED only when physics grounded
//      it AND the vision lane could name what it is from ACTUATOR_VOCABULARY.
//      A named part the category does not usually have is an EXTRA — listed,
//      but flagged, because the dictionary may simply not know this machine.
//      An UNNAMED candidate is excluded from the actuator list, because a
//      joint nobody can name cannot get a meaningful controller — the record
//      stays in the manifest as evidence, only the listing is withheld.
//
// Pure data + pure functions: no I/O, no imports, so every lane can use it.

// motion is the IR's only vocabulary: rotor | gimbal | hinge (propose-core).
// `soft` marks actuators a 3D model may fuse into the body or skip entirely
// (lights, mirrors) — expected, but their absence is not a discovery failure.
//
// VEHICLES LIST NO HINGE-PANEL ACTUATORS. A hinge is an internal component
// of an assembly, not a drivable actuator in its own right, and a panel's
// scope (which nodes belong to the door/hood/wiper) is the most error-prone
// grounding in the table — removing the class beats mis-scoping every run.
// Working machines keep their hinge entries because those ARE what you
// drive on them: a robot arm's elbow, an excavator's boom, an airplane's
// control surfaces, a tank's gun barrel, a boat's rudder.
export const DICTIONARY = {
  car: {
    match: ['car', 'sedan', 'coupe', 'sports car', 'sportscar', 'suv', 'hatchback', 'convertible', 'race car', 'racing car', 'supercar'],
    actuators: [
      { name: 'wheel', motion: 'rotor', count: 4, where: 'four corners of chassis', soft: false },
      { name: 'mirror', motion: 'gimbal', count: 2, where: 'exterior sides of cabin', soft: true },
      { name: 'headlight', motion: 'gimbal', count: 2, where: 'front fascia', soft: true },
    ],
  },
  truck: {
    match: ['truck', 'pickup', 'lorry', 'semi truck', 'box truck', 'van'],
    actuators: [
      { name: 'wheel', motion: 'rotor', count: 6, where: 'axles along chassis', soft: false },
      { name: 'mirror', motion: 'gimbal', count: 2, where: 'exterior sides of cab', soft: true },
    ],
  },
  bus: {
    match: ['bus', 'coach', 'minibus'],
    actuators: [
      { name: 'wheel', motion: 'rotor', count: 6, where: 'axles along chassis', soft: false },
      { name: 'mirror', motion: 'gimbal', count: 2, where: 'exterior front corners', soft: true },
    ],
  },
  motorbike: {
    match: ['motorbike', 'motorcycle', 'scooter', 'moped', 'dirt bike'],
    actuators: [
      { name: 'wheel', motion: 'rotor', count: 2, where: 'front and rear forks', soft: false },
      { name: 'mirror', motion: 'gimbal', count: 2, where: 'ends of handlebars', soft: true },
    ],
  },
  bicycle: {
    match: ['bicycle', 'bike', 'road bike', 'mountain bike'],
    actuators: [
      { name: 'wheel', motion: 'rotor', count: 2, where: 'front and rear forks', soft: false },
      { name: 'pedal', motion: 'rotor', count: 2, where: 'bottom bracket crank arms', soft: false },
    ],
  },
  'quadrotor-drone': {
    match: ['quadrotor drone', 'quadrotor', 'quadcopter', 'drone', 'multirotor', 'uav', 'quad'],
    actuators: [
      { name: 'rotor', motion: 'rotor', count: 4, where: 'ends of arms', soft: false },
      { name: 'gimbal_mount', motion: 'gimbal', count: 1, where: 'underside center body', soft: false },
    ],
  },
  helicopter: {
    match: ['helicopter', 'heli', 'chopper', 'gyrocopter'],
    actuators: [
      { name: 'main_rotor', motion: 'rotor', count: 1, where: 'top of mast', soft: false },
      { name: 'tail_rotor', motion: 'rotor', count: 1, where: 'end of tail boom', soft: false },
    ],
  },
  airplane: {
    match: ['airplane', 'aeroplane', 'plane', 'aircraft', 'jet', 'fixed-wing', 'propeller plane', 'biplane', 'glider'],
    actuators: [
      { name: 'propeller', motion: 'rotor', count: 1, where: 'nose or engine nacelle', soft: false },
      { name: 'aileron', motion: 'hinge', count: 2, where: 'trailing edge of wings', soft: false },
      { name: 'elevator', motion: 'hinge', count: 2, where: 'trailing edge of tailplane', soft: false },
      { name: 'rudder', motion: 'hinge', count: 1, where: 'trailing edge of fin', soft: false },
      { name: 'flap', motion: 'hinge', count: 2, where: 'inner trailing wing edge', soft: false },
    ],
  },
  tank: {
    match: ['tank', 'main battle tank', 'battle tank', 'armoured vehicle', 'armored vehicle'],
    actuators: [
      { name: 'track_sprocket', motion: 'rotor', count: 2, where: 'rear of track assemblies', soft: false },
      { name: 'turret', motion: 'rotor', count: 1, where: 'top of hull', soft: false },
      { name: 'gun_barrel', motion: 'hinge', count: 1, where: 'front of turret', soft: false },
    ],
  },
  boat: {
    match: ['boat', 'ship', 'yacht', 'vessel', 'speedboat', 'sailboat'],
    actuators: [
      { name: 'propeller', motion: 'rotor', count: 1, where: 'stern below waterline', soft: false },
      { name: 'rudder', motion: 'hinge', count: 1, where: 'stern behind propeller', soft: false },
    ],
  },
  'robot-arm': {
    match: ['robot arm', 'robotic arm', 'robot-arm', 'manipulator', 'robot manipulator', 'industrial arm'],
    actuators: [
      { name: 'base_joint', motion: 'rotor', count: 1, where: 'bottom mounting plate', soft: false },
      { name: 'shoulder_joint', motion: 'hinge', count: 1, where: 'base to upper arm', soft: false },
      { name: 'elbow_joint', motion: 'hinge', count: 1, where: 'upper to lower arm', soft: false },
      { name: 'wrist_joint', motion: 'rotor', count: 1, where: 'lower arm to end effector', soft: false },
      { name: 'gripper_jaw', motion: 'hinge', count: 2, where: 'end effector tip', soft: false },
    ],
  },
  excavator: {
    match: ['excavator', 'digger', 'backhoe', 'tracked excavator'],
    actuators: [
      { name: 'track_sprocket', motion: 'rotor', count: 2, where: 'rear of track assemblies', soft: false },
      { name: 'cab_turret', motion: 'rotor', count: 1, where: 'top of undercarriage', soft: false },
      { name: 'boom', motion: 'hinge', count: 1, where: 'front of cab body', soft: false },
      { name: 'stick', motion: 'hinge', count: 1, where: 'end of boom arm', soft: false },
      { name: 'bucket', motion: 'hinge', count: 1, where: 'end of stick arm', soft: false },
    ],
  },
};

export const CATEGORY_KEYS = Object.keys(DICTIONARY);

// The closed naming vocabulary the recognition gate judges against — every
// actuator name the dictionary uses, plus nothing else. A vision proposal's
// `part` is valid only when it is one of these words: a fixed vocabulary is
// what turns "the model called it something" into a checkable fact rather
// than a synonym puzzle ("wing flap" vs "flap").
export const ACTUATOR_VOCABULARY = new Set(
  Object.values(DICTIONARY).flatMap((e) => e.actuators.map((a) => a.name)),
);

// Normalize a free-text part name the way the model is told to write it:
// lowercase, snake_case, singular. A plural is rescued only when its singular
// is a vocabulary word — "doors" becomes "door", but "bus" is never cut to
// "bu", because the rescue fires only on a vocabulary hit.
export function normPartName(v) {
  let s = String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (ACTUATOR_VOCABULARY.has(s)) return s;
  if (s.endsWith('s') && ACTUATOR_VOCABULARY.has(s.slice(0, -1))) return s.slice(0, -1);
  return null;
}

const normCategory = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Free-text category ("a quadrotor drone, likely a DJI-style UAV") -> the
// dictionary entry, or null. Longest alias wins, so "quadrotor drone" settles
// on the drone entry even though "drone" alone would also match, and a
// category the table does not know ("submarine") stays a clean miss — the
// expectation lane then keeps its model-generated counts, which is the exact
// behaviour it had before this table existed.
export function lookupDictionary(category) {
  const text = normCategory(category);
  if (!text) return null;
  let best = null;
  for (const [key, entry] of Object.entries(DICTIONARY)) {
    for (const alias of [key, ...(entry.match || [])]) {
      const a = normCategory(alias);
      if (!a) continue;
      if (text === a || text.includes(a)) {
        if (!best || a.length > best.alias.length) best = { key, entry, alias: a };
      }
    }
  }
  return best ? { key: best.key, entry: best.entry } : null;
}

// Expected totals per IR motion type, for the category the table knows. This
// is the DETERMINISTIC half of the expected-vs-found check: the model's own
// per-type counts vary run to run, these do not.
export function countsByMotion(entry) {
  const out = {};
  for (const a of entry?.actuators || []) {
    out[a.motion] = (out[a.motion] || 0) + Math.max(0, a.count | 0);
  }
  return out;
}

// Attach the dictionary's verdict to a parsed category prior, in place:
//   exp.dictKey     which table entry the category resolved to
//   exp.dictCounts  per-motion expected totals (expectationGap prefers them)
//   exp.dictRef     one human line naming the whole expected list, so the
//                   discovery turn's hypothesis can say "4x wheel, 4x door…"
//                   instead of leaving the names implicit in the counts
// A miss changes nothing and says so — an unknown category keeps the prior
// exactly as the model wrote it.
export function reconcileExpectation(exp) {
  const warnings = [];
  if (!exp?.category) return { dict: null, warnings };
  const hit = lookupDictionary(exp.category);
  if (!hit) {
    warnings.push(`category "${exp.category}" is not in the actuator dictionary — the expected counts stay the model's own`);
    return { dict: null, warnings };
  }
  exp.dictKey = hit.key;
  exp.dictCounts = countsByMotion(hit.entry);
  exp.dictRef = hit.entry.actuators
    .map((a) => `${a.count}x ${a.name} (${a.where})${a.soft ? ' [soft — may be fused or cosmetic]' : ''}`)
    .join(', ');
  const modelCounts = {};
  for (const ins of exp.instances || []) {
    if (ins?.type) modelCounts[ins.type] = (modelCounts[ins.type] || 0) + (Number(ins.count) || 0);
  }
  for (const [type, n] of Object.entries(exp.dictCounts)) {
    if (modelCounts[type] != null && modelCounts[type] !== n) {
      warnings.push(`a ${hit.key} usually has ${n} ${type}(s); the first look said ${modelCounts[type]} — the dictionary count is the one the gap check falsifies`);
    }
  }
  return { dict: hit, warnings };
}

// THE RECOGNITION GATE — the second half of the dual admission rule.
//
// For every live record:
//   part named and in the vocabulary   -> listed; `expected` when the
//                                         category's entry knows that name,
//                                         `extra` when it does not (the
//                                         dictionary is a prior, not a cage:
//                                         a recognized turret on a car is
//                                         listed AND flagged)
//   part missing or not a known word   -> NOT listed: the discovery system
//                                         found motion but could not say what
//                                         the part IS, and a controller for
//                                         "something that moves" is no
//                                         controller at all. The record and
//                                         its evidence stay; only the listing
//                                         is withheld, and the exclusion is
//                                         announced so a human can rescue it.
//
// With no dictionary match there is no predefined set to be beyond, so the
// gate is a clean no-op and every record keeps the pre-dictionary behaviour.
// Rejected records are skipped: a human already disposed of them.
export function applyRecognitionGate(records, { category = null } = {}) {
  const notes = [];
  const out = { dict: null, listed: 0, extras: 0, excluded: 0, notes };
  const hit = lookupDictionary(category);
  if (!hit) return out;
  out.dict = hit.key;
  const expectedNames = new Set(hit.entry.actuators.map((a) => a.name));
  for (const rec of records || []) {
    if (!rec || rec.status === 'rejected') continue;
    const part = normPartName(rec.part);
    if (part) {
      rec.part = part;
      rec.listed = true;
      rec.expected = expectedNames.has(part);
      rec.extra = !rec.expected;
      out.listed += 1;
      if (rec.extra) {
        out.extras += 1;
        notes.push(`${rec.id} moves and was recognized as a "${part}" — not something a ${hit.key} usually has, so it is listed as an EXTRA`);
      }
    } else {
      rec.listed = false;
      rec.expected = false;
      rec.extra = false;
      out.excluded += 1;
      notes.push(`${rec.id} (${rec.type}, ${(rec.nodes || []).length} part(s)) moves, but the vision look could not name what it is — EXCLUDED from the actuator list; its evidence is kept`);
    }
  }
  return out;
}

// The actuator list proper: the records a controller may be generated for.
// `listed === false` is the only exclusion — a record the gate has never
// judged (no category was recognized, or no vision round has run) keeps the
// pre-dictionary behaviour, because the gate's rule is "unrecognized extras
// are withheld", never "everything is guilty until categorized".
export function actuatorList(manifest) {
  return (manifest || []).filter((r) => r && r.status !== 'rejected' && r.listed !== false);
}

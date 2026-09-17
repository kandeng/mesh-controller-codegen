// The actuator dictionary — the deterministic answer to "what does a machine
// of this kind usually move?", living in a PLAIN JSON FILE
// (config/actuator-dictionary.json, overridable via MCC_DICTIONARY) so a
// human — or the DSH — can add or fix a category without touching any script.
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
// The file is re-read whenever its mtime changes (refreshDictionary runs on
// every public read path), so a hand-edit takes effect without a restart. A
// file that is broken AT BOOT is a hard failure (nothing starts with a table
// it cannot trust); a file that breaks MID-SESSION keeps the last good table
// and reports through dictionaryStatus() until it parses again.
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// motion is the MODEL-FACING vocabulary: rotor | gimbal. The IR keeps a
// third type, hinge, as an internal structural name (propose-core admits it
// for manual records), but no prompt offers it and nothing in this table
// uses it — a part that swings over a limited arc (a door, a boom, a control
// surface) is a gimbal here.
// `soft` marks actuators a 3D model may fuse into the body or skip entirely
// (lights, mirrors) — expected, but their absence is not a discovery failure.
//
// DOORS ARE LISTED, OTHER HINGED PANELS ARE NOT. A door is a drivable
// actuator of its own — named `door`, typed gimbal (it swings over a limited
// arc about its edge). Hoods, hatches and trunks stay unlisted: their scope
// (which nodes belong to the panel) is the most error-prone grounding in the
// table, and removing the class beats mis-scoping every run. Working
// machines' swing joints are gimbals too: a robot arm's elbow, an
// excavator's boom, an airplane's control surfaces, a tank's gun barrel, a
// boat's rudder.

// Where the table lives. MCC_DICTIONARY overrides the path (tests point it at
// a temp file; deployment can point it at an ops-editable location).
export const DICTIONARY_FILE = process.env.MCC_DICTIONARY
  || fileURLToPath(new URL('../../../config/actuator-dictionary.json', import.meta.url));

const MOTIONS = new Set(['rotor', 'gimbal']);

// The file's contract with every lane that reads it: a category key is a
// lowercase dash word; each actuator names a part (snake_case), one of the
// two model-facing motions, a count, and a "where" hint. Validation normalizes
// what it safely can (name casing, soft's default) and refuses the rest — bad
// data must never quietly degrade discovery.
function validateDictionary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the dictionary file must hold an object of categories');
  const out = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`category key "${key}" must be lowercase dash-case`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`category "${key}" must be an object`);
    if (!Array.isArray(entry.actuators) || !entry.actuators.length) throw new Error(`category "${key}" lists no actuators`);
    const seen = new Set();
    const actuators = entry.actuators.map((a, i) => {
      if (!a || typeof a !== 'object') throw new Error(`${key}.actuators[${i}] must be an object`);
      const name = String(a.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (!name) throw new Error(`${key}.actuators[${i}] has no part name`);
      if (!MOTIONS.has(a.motion)) throw new Error(`${key}.actuators[${i}] ("${name}") motion must be rotor|gimbal, got "${a.motion}"`);
      const count = Math.round(Number(a.count));
      if (!Number.isFinite(count) || count < 1 || count > 64) throw new Error(`${key}.actuators[${i}] ("${name}") count must be 1..64`);
      if (seen.has(name)) throw new Error(`category "${key}" lists "${name}" twice`);
      seen.add(name);
      return { name, motion: a.motion, count, where: String(a.where || '').trim(), soft: !!a.soft };
    });
    out[key] = {
      match: (Array.isArray(entry.match) ? entry.match : []).map((m) => String(m || '').trim()).filter(Boolean),
      actuators,
    };
  }
  if (!Object.keys(out).length) throw new Error('the dictionary file holds no categories');
  return out;
}

export const DICTIONARY = {};
export const CATEGORY_KEYS = [];
// The closed naming vocabulary the recognition gate judges against — every
// actuator name the dictionary uses, plus nothing else. A vision proposal's
// `part` is valid only when it is one of these words: a fixed vocabulary is
// what turns "the model called it something" into a checkable fact rather
// than a synonym puzzle ("wing flap" vs "flap").
export const ACTUATOR_VOCABULARY = new Set();

let dictMtime = 0;
let dictError = null;

// Re-derive every exported snapshot IN PLACE: importers hold references to
// these exact objects, so swapping in fresh objects would strand every lane
// on the old table while only new lookups saw the edit.
function adopt(data, mtimeMs) {
  for (const k of Object.keys(DICTIONARY)) delete DICTIONARY[k];
  Object.assign(DICTIONARY, data);
  CATEGORY_KEYS.splice(0, CATEGORY_KEYS.length, ...Object.keys(data));
  ACTUATOR_VOCABULARY.clear();
  for (const e of Object.values(data)) for (const a of e.actuators) ACTUATOR_VOCABULARY.add(a.name);
  dictMtime = mtimeMs;
  dictError = null;
}

function loadFromDisk() {
  const st = statSync(DICTIONARY_FILE);
  adopt(validateDictionary(JSON.parse(readFileSync(DICTIONARY_FILE, 'utf8'))), st.mtimeMs);
}

// Boot load: a broken file throws here and nothing starts — fail loud, by design.
loadFromDisk();

// The mtime check behind every public read path: a hand-edit (or the DSH's)
// takes effect without a restart. A broken edit mid-session is NOT fatal the
// way a broken boot file is — the last good table stays in force and the
// error rides dictionaryStatus() until the file parses again (each read
// retries, so a fix is picked up on the next lookup).
export function refreshDictionary() {
  let st = null;
  try { st = statSync(DICTIONARY_FILE); } catch (e) { dictError = e.message; return false; }
  if (st.mtimeMs === dictMtime) return false;
  try { loadFromDisk(); return true; } catch (e) { dictError = e.message; return false; }
}

// What's in force right now — the route and the chat ask both read this, so a
// human can see which file to edit and whether the last edit took.
export function dictionaryStatus() {
  return { file: DICTIONARY_FILE, categories: CATEGORY_KEYS.length, mtimeMs: dictMtime, error: dictError };
}

// Add ONE category and persist the whole table atomically (tmp + rename, so a
// crash mid-write cannot truncate the file every lane reads). The candidate
// matches the shape of the model's unknown-category proposal —
// { key, match, actuators } — and is validated by the SAME contract as the
// file, so a confirmed proposal can never put data on disk that a boot would
// reject. An existing key is refused: changing a category is a hand-edit,
// not a confirmation.
export function addDictionaryEntry(candidate) {
  refreshDictionary();
  const key = String(candidate?.key || candidate?.category || '')
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!key) return { ok: false, code: 'BAD_KEY', error: 'a category key is required' };
  if (DICTIONARY[key]) return { ok: false, code: 'EXISTS', error: `"${key}" is already in the dictionary — edit ${DICTIONARY_FILE} directly to change it` };
  let entry = null;
  try {
    entry = validateDictionary({ [key]: { match: candidate?.match || candidate?.aliases || [], actuators: candidate?.actuators } })[key];
  } catch (e) {
    return { ok: false, code: 'INVALID', error: e.message };
  }
  const tmp = `${DICTIONARY_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...DICTIONARY, [key]: entry }, null, 2)}\n`);
  renameSync(tmp, DICTIONARY_FILE);
  loadFromDisk();
  return { ok: true, key, entry, file: DICTIONARY_FILE };
}

// Normalize a free-text part name the way the model is told to write it:
// lowercase, snake_case, singular. A plural is rescued only when its singular
// is a vocabulary word — "doors" becomes "door", but "bus" is never cut to
// "bu", because the rescue fires only on a vocabulary hit.
export function normPartName(v) {
  let s = String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (ACTUATOR_VOCABULARY.has(s)) return s;
  if (s.endsWith('s') && ACTUATOR_VOCABULARY.has(s.slice(0, -1))) return s.slice(0, -1);
  // A phrase the model wrote despite the VERBATIM rule ("wheel 1 of 4",
  // "front wheel"): rescued only when EXACTLY ONE vocabulary word appears in it
  // as a whole word. Two different vocabulary words ("door mirror") are an
  // ambiguous answer, and an ambiguous name is worse than no name — the record
  // then reads as UNRECOGNIZED to the listing gate instead of wearing a guess.
  const hits = [...new Set(s.split('_').filter((w) => ACTUATOR_VOCABULARY.has(w)))];
  if (hits.length === 1) return hits[0];
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
  refreshDictionary();
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
  refreshDictionary();
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
  refreshDictionary();
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

// THE STEP-2 HARDLINE — a record may be SHOWN as an actuator (the app's
// step-2 list) only when its part is one of the pre-defined category names in
// ACTUATOR_VOCABULARY. The recognition gate already withholds the listing from
// movers nobody could name (listed === false); this predicate is the stricter
// UI-facing half: a record the gate never judged (no category recognized, or
// no vision round has run yet) is ALSO not shown until it carries a vocabulary
// name. Nothing is deleted — the record, its evidence, and the chat
// announcement all stay; only the listing is withheld.
export function actuatorVisible(rec) {
  if (!rec || rec.status === 'rejected') return false;
  if (rec.listed === false) return false;
  return normPartName(rec.part) != null;
}

// The actuator list proper: the records a controller may be generated for.
// `listed === false` is the only exclusion — a record the gate has never
// judged (no category was recognized, or no vision round has run) keeps the
// pre-dictionary behaviour, because the gate's rule is "unrecognized extras
// are withheld", never "everything is guilty until categorized".
export function actuatorList(manifest) {
  return (manifest || []).filter((r) => r && r.status !== 'rejected' && r.listed !== false);
}

// Observation store — the durable evidence layer for vision rounds.
//
// A vision round produces three kinds of artefact and all three are kept:
//   plan.json       the poses the planner chose, and why (marginal gain, mode)
//   <id>.png        the rendered frames themselves
//   <id>.colors.json the colour-id → node map for that frame (ground truth)
//   reply.json      the exact prompt sent and the exact reply received
//   proposals.json  what the validator accepted from that reply
//
// Persisting the frames and the raw reply is not bookkeeping. It is what makes a
// vision claim FALSIFIABLE LATER: when a generated controller misbehaves, the
// question "what did the model actually see when it named this joint?" has a
// file answer instead of a memory. It is also what makes a round resumable after
// a server restart, matching the manifest's own discipline.
//
// Layout: <runDir>/observations/r<round>/. One directory per round so a second
// active round never overwrites the evidence of the first.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A round is bounded: the plan already picks the fewest frames that cover, and
// an unbounded frame count turns one vision round into a multi-megabyte upload.
export const MAX_FRAMES_PER_ROUND = 24;
// Mirrors the Fastify bodyLimit — a frame the server would refuse to accept must
// also be refused here, so the caller gets one clear error instead of two.
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export const observationsRoot = (runDir) => resolve(runDir, 'observations');
export const roundDir = (runDir, round) => resolve(observationsRoot(runDir), `r${Number(round) || 0}`);

// A caller-supplied id must never be able to escape the round directory: it
// arrives over HTTP and lands in a path. Whitelist, then bound the length.
const safeId = (s) => String(s ?? 'frame').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'frame';

// The five things one pose can legitimately be drawn as:
//   photo    the model as it is — what a human would photograph
//   clay     every part in ONE bright neutral matte material: colour and texture
//            hidden on purpose so scoping reads shape only — a gloss-black hull
//            photographs as a silhouette, clay does not
//   ghost    shell translucent, so the parts enclosed by a closed hull (which no
//            opaque external viewpoint can ever show) become visible
//   solo     only the focused sub-assembly draws — the cheapest way to ground
//            what e.g. a gimbal is actually made of
//   colorId  flat unique colour per part, giving an exact pixel->name map, so
//            grounding needs no model inference at all
export const FRAME_MODES = ['photo', 'clay', 'ghost', 'solo', 'colorId'];

// The storage key of a frame. A frame is identified by the POSE that produced it
// AND the mode it was drawn in, because re-saving a key REPLACES it — which is
// what makes a retry cheap, but only if the key distinguishes the modes.
//
// Getting this wrong is silent and total: with the bare view id as the key, a
// round that draws one pose in four modes keeps only the last frame and reports
// one entry, so the ghost/solo/mask evidence vanishes with no error anywhere.
// The server composes this key rather than the renderer, because the server owns
// the directory and the replacement rule.
export function frameKey(viewId, mode = 'photo') {
  const m = FRAME_MODES.includes(mode) ? mode : 'photo';
  return `${safeId(viewId)}.${m}`;
}

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2));

function ensure(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- plan -------------------------------------------------------------------

export function savePlan(runDir, round, plan) {
  if (!runDir) return null;
  const dir = ensure(roundDir(runDir, round));
  const file = resolve(dir, 'plan.json');
  writeJson(file, { ts: new Date().toISOString(), round: Number(round) || 0, plan });
  return file;
}

export function loadPlan(runDir, round) {
  const rec = readJson(resolve(roundDir(runDir, round), 'plan.json'));
  return rec ? rec.plan : null;
}

// ---- frames -----------------------------------------------------------------

// Index of the round's frames. Kept as its own file so a listing never has to
// stat every PNG, and so the colour maps (which are large) stay out of it.
function indexPath(dir) { return resolve(dir, 'frames.json'); }

function readIndex(dir) {
  const idx = readJson(indexPath(dir));
  return Array.isArray(idx?.frames) ? idx.frames : [];
}

// Store one rendered frame. `frame`:
//   { id, mode: 'photo'|'clay'|'ghost'|'solo'|'colorId', spec, pose,
//     dataBase64, mediaType, width, height, colorMap?, focus?, note? }
// `id` here is the STORAGE KEY (see frameKey) — callers that want mode-aware keys
// compose them with frameKey rather than passing a bare view id.
// Returns { ok, file, entry } or { ok: false, error } — never throws, because a
// dropped frame must degrade the round, not crash the request handler.
export function saveFrame(runDir, round, frame) {
  if (!runDir) return { ok: false, error: 'no run directory' };
  if (!frame || !frame.dataBase64) return { ok: false, error: 'frame has no image data' };

  const dir = ensure(roundDir(runDir, round));
  const index = readIndex(dir);
  const id = safeId(frame.id);

  // Re-rendering the same view id is legitimate (a retry after a lost socket),
  // so an existing id is replaced rather than counted twice against the cap.
  const existing = index.findIndex((f) => f.id === id);
  if (existing < 0 && index.length >= MAX_FRAMES_PER_ROUND) {
    return { ok: false, error: `frame budget exhausted (${MAX_FRAMES_PER_ROUND} per round)` };
  }

  const mediaType = EXT[frame.mediaType] ? frame.mediaType : 'image/png';
  const raw = Buffer.from(frame.dataBase64, 'base64');
  if (!raw.length) return { ok: false, error: 'image data did not decode' };
  if (raw.length > MAX_FRAME_BYTES) return { ok: false, error: `frame exceeds ${MAX_FRAME_BYTES} bytes` };

  const rel = `${id}.${EXT[mediaType]}`;
  const file = resolve(dir, rel);
  writeFileSync(file, raw);

  // The colour map is ground truth for grounding: pixel colour -> node name.
  // Stored beside the frame and referenced, never inlined, so frames.json stays
  // small enough to hand to a prompt.
  let colorMapFile = null;
  if (frame.colorMap && typeof frame.colorMap === 'object') {
    colorMapFile = `${id}.colors.json`;
    writeJson(resolve(dir, colorMapFile), frame.colorMap);
  }

  const entry = {
    id,
    mode: frame.mode || 'photo',
    file: rel,
    bytes: raw.length,
    mediaType,
    width: frame.width ?? null,
    height: frame.height ?? null,
    spec: frame.spec ?? null,
    pose: frame.pose ?? null,
    focus: frame.focus ?? null,
    note: frame.note ?? null,
    colorMap: colorMapFile,
    ts: new Date().toISOString(),
  };
  if (existing >= 0) index[existing] = entry; else index.push(entry);
  writeJson(indexPath(dir), { round: Number(round) || 0, frames: index });
  return { ok: true, file, entry };
}

// Absolute path of a stored frame, or null. Used by the viewer-URL mapper so the
// browser can display exactly the frame the model was shown.
export function framePath(runDir, round, id) {
  const entry = readIndex(roundDir(runDir, round)).find((f) => f.id === safeId(id));
  if (!entry) return null;
  const file = resolve(roundDir(runDir, round), entry.file);
  return existsSync(file) ? file : null;
}

export function loadColorMap(runDir, round, id) {
  const entry = readIndex(roundDir(runDir, round)).find((f) => f.id === safeId(id));
  if (!entry?.colorMap) return null;
  return readJson(resolve(roundDir(runDir, round), entry.colorMap));
}

// ---- motion fans (task 18) --------------------------------------------------

// The storage ids of a motion fan's images. They live in the SAME round directory
// and the SAME frames.json index as vision frames, so every existing read path —
// the frame URL mapper, the evidence browser, MAX_FRAMES_PER_ROUND — already works
// on them. The `mot_` prefix and the pose index keep a fan from colliding with a
// plan view id, and route the composite to its own key.
//
// Both go through frameKey(), so a fan drawn in `solo` and the same fan in `photo`
// are two sets of evidence rather than one silently overwriting the other.
export const motionFrameId = (jointId, index, mode = 'photo') => frameKey(`mot_${safeId(jointId)}_p${Number(index) || 0}`, mode);
export const motionSweepId = (jointId, mode = 'photo') => frameKey(`mot_${safeId(jointId)}_sweep`, mode);

// The fan's own record: which joint was driven, through which angles, in which
// mode, what the model made of it, and the frame ids behind each pose. The BYTES
// are not here — they are the PNGs saveFrame wrote, referenced by id — so this file
// stays small enough to hand back in an API response.
//
// Persisted for the same reason a vision round is: a motion claim must be
// falsifiable later. "We drove rotor_fl through 0/30/60 and the model said the
// spin looked sensible" has a file answer, with the exact frames, or it is a
// memory.
export function saveMotion(runDir, round, {
  jointId = null, angles = [], mode = 'photo', view = null, focusNodes = null,
  frames = [], composite = null, prompt = null, reply = null,
  assessment = null, model = null, ms = null, warnings = null,
} = {}) {
  if (!runDir) return null;
  const dir = ensure(roundDir(runDir, round));
  const file = resolve(dir, 'motion.json');
  writeJson(file, {
    ts: new Date().toISOString(),
    round: Number(round) || 0,
    jointId,
    angles,
    mode,
    view,
    focusNodes,
    // Frame references (ids), not bytes: the pixels are the PNGs saveFrame wrote.
    frames,
    composite,
    prompt,
    reply,
    assessment,
    model,
    ms,
    warnings,
  });
  return file;
}

export function loadMotion(runDir, round) { return readJson(resolve(roundDir(runDir, round), 'motion.json')); }

// ---- model exchange ---------------------------------------------------------

// The prompt/reply pair, verbatim. Kept even when validation rejects every
// proposal — a rejected proposal is still evidence about what the model saw.
// `retry` is the strict-schema second turn (loop.mjs step 5): when the first
// reply carried nothing parseable, BOTH exchanges belong in the one file, so a
// reader sees the prose and the recovery beside each other.
export function saveReply(runDir, round, { prompt = null, reply = null, model = null, ms = null, warnings = null, retry = null } = {}) {
  if (!runDir) return null;
  const dir = ensure(roundDir(runDir, round));
  const file = resolve(dir, 'reply.json');
  writeJson(file, {
    ts: new Date().toISOString(), model, ms, warnings, prompt, reply, retry,
  });
  return file;
}

export function loadReply(runDir, round) { return readJson(resolve(roundDir(runDir, round), 'reply.json')); }

// The CATEGORY PRIOR turn, kept beside the frames that produced it.
//
// A prior is not evidence and it never becomes a manifest record, which is
// exactly why it has its own file rather than a line in proposals.json: the
// question a human asks of it is different. proposals.json answers "what did the
// model claim"; expectation.json answers "what did we GUESS the machine was
// before we asked, and was the guess wrong". A round whose discovery turn found
// three rotors is only auditable if the four the prior expected is on the record
// too — including the prompt that asked for it and the gaps computed afterwards.
//
// `expectation` is the PARSED prior (see expectation.mjs parseExpectation) and
// `gaps` the expected-vs-grounded comparison after the round merged. Both may be
// null: a round that ran without the prior, or a prior the model declined to
// give, is recorded as such rather than as an absent file.
export function saveExpectation(runDir, round, {
  prompt = null, reply = null, expectation = null, gaps = null,
  model = null, ms = null, warnings = null,
} = {}) {
  if (!runDir) return null;
  const dir = ensure(roundDir(runDir, round));
  const file = resolve(dir, 'expectation.json');
  writeJson(file, {
    ts: new Date().toISOString(), model, ms, warnings, prompt, reply, expectation, gaps,
    counts: {
      instances: Array.isArray(expectation?.instances) ? expectation.instances.length : 0,
      gaps: Array.isArray(gaps) ? gaps.length : 0,
      warnings: Array.isArray(warnings) ? warnings.length : 0,
    },
  });
  return file;
}

export function loadExpectation(runDir, round) { return readJson(resolve(roundDir(runDir, round), 'expectation.json')); }

// What the validator made of that reply: accepted records, confirms, and the
// reasons anything was dropped. Dropping is recorded because "the model said X
// and we refused it because Y" is the audit trail a human gate needs.
export function saveProposals(runDir, round, {
  records = [], confirms = [], warnings = [], rejected = [],
  grounded = [], suggestViews = [],
} = {}) {
  if (!runDir) return null;
  const dir = ensure(roundDir(runDir, round));
  const file = resolve(dir, 'proposals.json');
  writeJson(file, {
    ts: new Date().toISOString(),
    records, confirms, warnings, rejected,
    // `grounded` is how each region resolved (which channel, how the channels
    // agreed) and `suggestViews` is where round 2 should look next. Both are
    // persisted because the active loop is driven entirely from disk: a run has
    // to be replayable and resumable with no browser and no model attached.
    grounded, suggestViews,
    counts: {
      records: records.length, confirms: confirms.length,
      warnings: warnings.length, rejected: rejected.length,
      suggestViews: suggestViews.length,
    },
  });
  return file;
}

export function loadProposals(runDir, round) { return readJson(resolve(roundDir(runDir, round), 'proposals.json')); }

// ---- listing ----------------------------------------------------------------

// Every round that has evidence on disk, newest last. Cheap: one readdir plus a
// frames.json read per round, no image decoding.
export function listRounds(runDir) {
  const root = observationsRoot(runDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => (/^r(\d+)$/.exec(name) || [])[1])
    .filter((n) => n != null)
    .map(Number)
    .sort((a, b) => a - b)
    .map((round) => {
      const dir = roundDir(runDir, round);
      const frames = readIndex(dir);
      return {
        round,
        dir,
        frames: frames.length,
        bytes: frames.reduce((a, f) => a + (f.bytes || 0), 0),
        hasPlan: existsSync(resolve(dir, 'plan.json')),
        hasExpectation: existsSync(resolve(dir, 'expectation.json')),
        hasReply: existsSync(resolve(dir, 'reply.json')),
        hasProposals: existsSync(resolve(dir, 'proposals.json')),
        hasMotion: existsSync(resolve(dir, 'motion.json')),
        modes: [...new Set(frames.map((f) => f.mode))],
      };
    });
}

// Full evidence for one round, ready to hand to an API response. Frame contents
// are NOT inlined — the caller maps `entry.file` through the viewer-URL helper.
export function loadRound(runDir, round) {
  const dir = roundDir(runDir, round);
  if (!existsSync(dir)) return null;
  return {
    round: Number(round) || 0,
    dir,
    plan: loadPlan(runDir, round),
    frames: readIndex(dir),
    expectation: loadExpectation(runDir, round),
    reply: loadReply(runDir, round),
    proposals: loadProposals(runDir, round),
    motion: loadMotion(runDir, round),
  };
}

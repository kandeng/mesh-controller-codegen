// Grounding — turning what a vision model POINTS AT into graph node names.
//
// A VLM is good at "there is a two-blade rotor here" and bad at "its node is
// named 63_3_104". So the model never has to name nodes at all. It reports a
// region, and this file resolves that region against geometry the server already
// knows exactly. Two independent channels, because they fail differently:
//
//   BOX      the model draws a normalized box over a photo. Resolved by
//            projecting every part's world bbox through the SAME camera the frame
//            was drawn from and scoring containment. Approximate by nature.
//   COLORID  the model reads a colour off the colorId mask. Resolved by an exact
//            table lookup against the colour->name map Task 4 stored beside the
//            frame. No geometry, no inference, no ambiguity.
//
// Both are pure functions over data already on disk (plan.json + <id>.colors.json),
// so grounding is testable headless with no browser and no model.
//
// The discipline this file exists to enforce: when the two channels DISAGREE that
// is evidence, not an error to be averaged away. reconcile() reports the
// disagreement and groundRegion() carries it into the record's uncertainties, so a
// wrong grounding is legible to the human instead of silently becoming a joint.
import { VIEWPORT, makeCamera, namedIndex, rectOf, renderTargets, nodeBox } from './views.mjs';

// VLM boxes are the least reliable part of their output: 10% slop is normal and
// thin parts (blades, arms, gimbal yokes) are worse. Boxes therefore give a COARSE
// region and the deterministic battery does the pruning.
export const BOX_DILATE = 0.1;

// Below this a candidate is noise: a part clipping the very edge of a dilated box.
export const MIN_BOX_SCORE = 0.12;
export const MAX_CANDIDATES = 24;

// ---- box normalization -------------------------------------------------------

// Accept a box in any of the shapes a model actually emits and return normalized
// frame coordinates {x0,y0,x1,y1} with y DOWN (matching project()).
//
// Models switch between 0..1 fractions and pixel counts without warning, so the
// convention is inferred. The two are decidable because their ranges barely
// overlap: no fractional box exceeds 2.0 even with generous slop and dilation, and
// no pixel box exceeds the frame it was drawn on. The one genuinely ambiguous case
// is a region a couple of pixels wide, which is degenerate for grounding anyway.
export function normBox(box, viewport = VIEWPORT) {
  let a = null;
  if (Array.isArray(box) && box.length === 4) a = box.map(Number);
  else if (box && typeof box === 'object') {
    const { x0, y0, x1, y1 } = box;
    if ([x0, y0, x1, y1].every(Number.isFinite)) a = [x0, y0, x1, y1].map(Number);
    else if ([box.x, box.y, box.w, box.h].every(Number.isFinite)) {
      a = [box.x, box.y, box.x + box.w, box.y + box.h].map(Number);
    }
  }
  if (!a || a.some((v) => !Number.isFinite(v))) return null;

  const mag = Math.max(...a.map((v) => Math.abs(v)));
  // Beyond the frame it was drawn on, the numbers are neither convention. Refuse
  // rather than clamp: clamping would turn junk into a full-frame box, which
  // grounds to every part in the model and looks like a confident answer.
  if (mag > Math.max(viewport.w, viewport.h) * 1.5) return null;
  const px = mag > 2;
  if (px) a = [a[0] / viewport.w, a[1] / viewport.h, a[2] / viewport.w, a[3] / viewport.h];
  // Sort so a model that emits (x1,y0,x0,y1) still grounds, then clamp.
  const cl = (v) => Math.max(0, Math.min(1, v));
  const x0 = cl(Math.min(a[0], a[2])); const x1 = cl(Math.max(a[0], a[2]));
  const y0 = cl(Math.min(a[1], a[3])); const y1 = cl(Math.max(a[1], a[3]));
  if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4) return null;   // degenerate: a point, not a region
  return { x0, y0, x1, y1, pixels: px };
}

// Grow a box by `d` of its own width/height on every side. Proportional rather
// than absolute: a 20px box over a blade needs the same relative slop as a 600px
// box over a fuselage.
export function dilateBox(b, d = BOX_DILATE) {
  const k = Math.max(0, Number(d) || 0);
  const dx = (b.x1 - b.x0) * k; const dy = (b.y1 - b.y0) * k;
  const cl = (v) => Math.max(0, Math.min(1, v));
  return { x0: cl(b.x0 - dx), y0: cl(b.y0 - dy), x1: cl(b.x1 + dx), y1: cl(b.y1 + dy) };
}

// The camera a frame was drawn from. Accepts either a plan view ({pose:{eye,
// target}}) or an already-built camera, so grounding works on a stored frame
// entry (which carries `pose`) as well as on a live plan view.
export function cameraOf(view, viewport = VIEWPORT) {
  if (!view) return null;
  if (view.f && view.r && view.u) return view;                    // already a camera
  const pose = view.pose || view;
  if (!Array.isArray(pose?.eye) || !Array.isArray(pose?.target)) return null;
  return makeCamera(pose.eye, pose.target, viewport);
}

// ---- channel 1: box -> nodes -------------------------------------------------

// Which parts does this box denote? Each part's placed world bbox is projected
// through the frame's own camera and scored against the box:
//
//   inside = overlap / part area    is the part ENCLOSED by the box?
//   fill   = overlap / box area     does the part OCCUPY the box?
//
// Both terms are needed, and their product is not used: a big background part
// behind the one being pointed at has fill≈1 but inside≈0, while the pointed-at
// part has inside≈1 and moderate fill. Weighting inside higher makes the subject
// win over its own backdrop, which is the single most common box-grounding error.
// Candidates are then depth-sorted, because a model points at a VISIBLE surface.
//
// Returns { box, dilated, candidates:[{name,i,score,inside,fill,depth}], warnings }.
export function boxToNodes(box, view, g, {
  dilate = BOX_DILATE, viewport = VIEWPORT, minScore = MIN_BOX_SCORE, maxResults = MAX_CANDIDATES,
} = {}) {
  const warnings = [];
  const nb = normBox(box, viewport);
  if (!nb) return { box: null, dilated: null, candidates: [], warnings: ['box missing or degenerate'] };
  const cam = cameraOf(view, viewport);
  if (!cam) return { box: nb, dilated: null, candidates: [], warnings: ['view has no usable pose'] };
  if (!g?.nodes?.length) return { box: nb, dilated: null, candidates: [], warnings: ['no parse table'] };

  const d = dilateBox(nb, dilate);
  const bx0 = d.x0 * cam.w; const by0 = d.y0 * cam.h;
  const bx1 = d.x1 * cam.w; const by1 = d.y1 * cam.h;
  const boxArea = Math.max(1e-9, (bx1 - bx0) * (by1 - by0));

  const named = namedIndex(g);
  const best = new Map();      // name -> strongest mesh node behind it
  for (const n of renderTargets(g)) {
    const r = rectOf(nodeBox(n), cam);
    if (!r) continue;
    const ox = Math.min(r.x1, bx1) - Math.max(r.x0, bx0);
    const oy = Math.min(r.y1, by1) - Math.max(r.y0, by0);
    if (ox <= 0 || oy <= 0) continue;
    const overlap = ox * oy;
    const inside = overlap / Math.max(1e-9, r.area);
    const fill = overlap / boxArea;
    const score = 0.65 * inside + 0.35 * fill;
    if (score < minScore) continue;

    // A named part is often several mesh nodes; the manifest speaks names, so
    // collapse to the best-scoring node per name rather than returning fragments.
    const name = named.get(n.i) || n.name;
    const prev = best.get(name);
    if (!prev || score > prev.score) {
      best.set(name, { name, i: n.i, score, inside, fill, depth: r.depth, rect: r });
    }
  }

  const candidates = [...best.values()]
    .sort((a, b) => (b.score - a.score) || (a.depth - b.depth))
    .slice(0, Math.max(1, maxResults | 0));
  if (!candidates.length) warnings.push('no part projects inside this box');
  return { box: nb, dilated: d, candidates, warnings };
}

// ---- channel 2: colour id -> nodes -------------------------------------------

// The colour ids captureAt() painted, in every shape a model reports them.
// '#9EC091', '9ec091', '0x9ec091' and '#9e9' all normalize; anything else is
// unknown rather than approximated. Antialiased edges blend two ids into a colour
// that is NOT a valid id, and approximating it would silently ground the wrong
// part — so a near-miss is reported as unknown and becomes an uncertainty.
export function normalizeColor(c) {
  let s = String(c ?? '').trim().toLowerCase().replace(/^#|^0x/, '');
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map((x) => x + x).join('');
  return /^[0-9a-f]{6}$/.test(s) ? `#${s}` : null;
}

// Exact lookup against the frame's stored colour->name map.
// `query` may be one colour, an array, or {colors:[...]}.
export function colorIdToNodes(colorMap, query) {
  const map = {};
  for (const [k, v] of Object.entries(colorMap || {})) {
    const c = normalizeColor(k);
    if (c && v) map[c] = String(v);
  }
  const list = Array.isArray(query) ? query
    : typeof query === 'string' ? [query]
      : Array.isArray(query?.colors) ? query.colors
        : query?.color ? [query.color] : [];

  const matched = []; const unknown = [];
  for (const raw of list) {
    const c = normalizeColor(raw);
    if (!c) { unknown.push({ asked: String(raw), reason: 'not a colour' }); continue; }
    if (map[c]) matched.push({ color: c, name: map[c] });
    else unknown.push({ asked: String(raw), color: c, reason: 'not painted in this frame' });
  }
  return {
    matched,
    unknown,
    names: [...new Set(matched.map((m) => m.name))],
    painted: Object.keys(map).length,
  };
}

// ---- reconcile ---------------------------------------------------------------

const asNames = (x) => new Set(Array.isArray(x) ? x.map(String) : x instanceof Set ? [...x].map(String) : []);

// Agreement between the two channels. ASYMMETRIC by design, because the channels
// are not symmetric:
//
//   boxNodes    a COARSE hypothesis set — dilated on purpose, expected to
//               over-include, because the deterministic battery does the pruning
//   colorNodes  a PRECISE claim — an exact table lookup, one name per colour read
//
// So the question is not "are the sets equal" but "is the precise claim CONTAINED
// in the coarse region". Jaccard would answer the wrong question: 14 box
// candidates against the 1 correct colour name scores 0.07 and reads as a clash
// even when that name is the box channel's own top candidate. Containment scores
// it 1.0, which is the truth.
//
// Both numbers are returned. `score` drives the verdict; `jaccard` is reported
// because a coarse set that balloons is worth seeing even when it still contains
// the claim. And `colorOnly` — a precisely-identified part lying OUTSIDE the
// pointed-at region — is the disagreement that actually matters: it means the
// model read a colour somewhere other than where it drew its box.
export function reconcile(boxNodes, colorNodes) {
  const A = asNames(boxNodes); const B = asNames(colorNodes);
  const both = [...B].filter((n) => A.has(n));
  const boxOnly = [...A].filter((n) => !B.has(n));     // coarse extras: expected
  const colorOnly = [...B].filter((n) => !A.has(n));   // precise claim missed: signal
  const union = new Set([...A, ...B]).size;
  const jaccard = union ? both.length / union : 0;

  if (!A.size && !B.size) return { score: 0, jaccard, verdict: 'empty', both, boxOnly, colorOnly, union };
  if (!B.size) return { score: 0, jaccard, verdict: 'box-only', both, boxOnly, colorOnly, union };
  // Distinguished from a clash: here the box grounded NOTHING, so there is no
  // competing hypothesis to disagree with — the colour claim simply stands alone.
  if (!A.size) return { score: 0, jaccard, verdict: 'color-only', both, boxOnly, colorOnly, union };

  const score = both.length / B.size;
  const verdict = score >= 1 ? 'agree' : score > 0 ? 'partial' : 'disagree';
  return { score, jaccard, verdict, both, boxOnly, colorOnly, union };
}

// ---- combined entry point ----------------------------------------------------

// Resolve one model-reported region to node names, using both channels and
// recording how well they agreed.
//
// Resolution rule: a non-empty colour channel WINS, because an exact table lookup
// beats geometric containment however well scored. The box candidates are still
// returned in full — they are the fallback when the colour channel is absent, and
// they are the evidence a human reads when the two disagree.
export function groundRegion({
  box = null, colors = null, view = null, g = null, colorMap = null,
  dilate = BOX_DILATE, viewport = VIEWPORT, minScore = MIN_BOX_SCORE, maxResults = MAX_CANDIDATES,
} = {}) {
  const warnings = [];
  const viaBox = box && view && g ? boxToNodes(box, view, g, { dilate, viewport, minScore, maxResults }) : null;
  const viaColor = colors && colorMap ? colorIdToNodes(colorMap, colors) : null;
  warnings.push(...(viaBox?.warnings || []));
  for (const u of viaColor?.unknown || []) warnings.push(`colour ${u.asked} ${u.reason}`);

  const boxNames = (viaBox?.candidates || []).map((c) => c.name);
  const colorNames = viaColor?.names || [];
  const agreement = reconcile(boxNames, colorNames);

  // The colour channel is authoritative when present; otherwise the box channel
  // stands alone with its score as the only confidence signal available.
  const names = colorNames.length ? colorNames : boxNames;
  const source = colorNames.length ? (boxNames.length ? 'colorId+box' : 'colorId') : (boxNames.length ? 'box' : 'none');

  // Uncertainties travel ONTO the record (Task 10) so the UI can show why the
  // model is unsure instead of only that it is.
  const uncertainties = [];
  if (agreement.verdict === 'disagree') {
    uncertainties.push(`grounding clash: the box denotes [${agreement.boxOnly.slice(0, 6).join(', ')}] but the painted colours denote [${agreement.colorOnly.slice(0, 6).join(', ')}]`);
  } else if (agreement.verdict === 'partial') {
    uncertainties.push(`grounding partial: ${agreement.colorOnly.length} of ${agreement.both.length + agreement.colorOnly.length} colour-identified parts lie outside the box the model drew — [${agreement.colorOnly.slice(0, 6).join(', ')}]`);
  } else if (agreement.verdict === 'color-only') {
    uncertainties.push('grounding by colour only: no part projects inside the box the model drew, so the box itself is unverified');
  }
  if (source === 'box') uncertainties.push('grounded by box only — no colour ids were read, so node identity is geometric, not exact');
  if (!names.length) uncertainties.push('region could not be grounded to any node');

  return {
    names, source, agreement,
    candidates: viaBox?.candidates || [],
    colors: viaColor?.matched || [],
    box: viaBox?.dilated || null,
    uncertainties, warnings,
  };
}

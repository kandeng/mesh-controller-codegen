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
import {
  AZIMUTH_RETRY, REGION_MAX_R, REGION_MIN_R, REGION_PAD, VIEWPORT, makeCamera,
  modelRadius, namedBoxes, namedIndex, nodeBox, rectOf, renderTargets, slug, unionBoxes,
} from './views.mjs';
import {
  carveEvidence, floodPatch, patchMetrics, registerCarve, seedFromRegion, worldScaleOf,
} from './carve.mjs';

// VLM boxes are the least reliable part of their output: 10% slop is normal and
// thin parts (blades, arms, gimbal yokes) are worse. Boxes therefore give a COARSE
// region and the deterministic battery does the pruning.
export const BOX_DILATE = 0.1;

// Below this a candidate is noise: a part clipping the very edge of a dilated box.
export const MIN_BOX_SCORE = 0.12;
export const MAX_CANDIDATES = 24;

// Subject-anchored pruning: a model points at ONE visible surface, so the top
// candidate IS the subject and every other kept candidate must still look like
// it belongs to the same surface. Three independent rejections, because each
// catches a mixture the other two cannot:
//   INSIDE  a part the box barely clips is background (the door under the
//           pointed-at wheel): the overlap is a small fraction of ITS area.
//   REL     a near-tie of the subject's score reads as a sibling of the same
//           part (tire/rim/spokes); much weaker reads as a different part the
//           dilated box happens to cover.
//   DEPTH   a part sitting beyond the subject's own depth extent plus its own
//           cannot be the surface the model saw — the steering wheel behind
//           the door glass grounded as part of the wheel until this band
//           existed. The band is the sum of the two parts' box half-diagonals,
//           so it scales with the parts, not with the model.
export const SUBJECT_MIN_INSIDE = 0.5;
export const SUBJECT_MIN_REL_SCORE = 0.5;

// Fused-shell trigger: the subject's box half-diagonal is at least 45% of the
// model's (the subject IS the shell) and the pointed box covers under 40% of
// its projection (a sliver — the part, not the shell). When both hold, the
// part the model pointed at was never exported as its own node, and the only
// honest scope is the surface itself: carve it (carve.mjs). A node-normal
// mesh — the drone sample — never satisfies the pair, so its grounding is
// bit-for-bit what it was before carving existed.
export const SHELL_MIN_SHARE = 0.45;
export const SHELL_MAX_INSIDE = 0.4;
// Patch sanity bounds: a cut worth making is at least 30 triangles, between 1%
// and 40% of the shell's area, and no wider than 1.5x the box's own world size
// (the radius the flood is allowed to reach is 1.3x the box's footprint).
export const CARVE_MIN_TRIS = 30;
export const CARVE_AREA_RANGE = [0.01, 0.4];
export const CARVE_MAX_BOX_SCALE = 1.5;
export const CARVE_RADIUS_SCALE = 1.3;

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
// target, up}}) or an already-built camera, so grounding works on a stored frame
// entry (which carries `pose`) as well as on a live plan view.
//
// `pose.up` is NOT optional detail. The omni survey tier shoots a true top-down and
// a true bottom-up frame, and at those poses the model's Z-up is the view axis: the
// basis is decided by whichever up vector the renderer was told to use. Rebuilding
// the camera with the default here would roll the projection relative to the pixels
// the model actually looked at, and every regionBox drawn on a pole frame would then
// resolve to plausible, wrong parts. Absent an `up` (a plan persisted before the
// field existed) makeCamera falls back to Z-up, which is what those poses were
// drawn with.
export function cameraOf(view, viewport = VIEWPORT) {
  if (!view) return null;
  if (view.f && view.r && view.u) return view;                    // already a camera
  const pose = view.pose || view;
  if (!Array.isArray(pose?.eye) || !Array.isArray(pose?.target)) return null;
  return makeCamera(pose.eye, pose.target, viewport, pose.up || null);
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
  carver,
} = {}) {
  // The carver is ON whenever the graph can decode geometry, unless the caller
  // explicitly disables it (carver: null) or injects its own reader — which is
  // how tests carve synthetic geometry without a GLB buffer.
  const carveRead = carver === undefined
    ? (typeof g?.readGeometry === 'function' ? (mi) => g.readGeometry(mi) : null)
    : (carver && typeof carver.readGeometry === 'function' ? carver.readGeometry : null);
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
    const b = nodeBox(n);
    const r = rectOf(b, cam);
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
      best.set(name, { name, i: n.i, score, inside, fill, depth: r.depth, rect: r, hd: b ? Math.hypot(b.h[0], b.h[1], b.h[2]) : 0 });
    }
  }

  const ranked = [...best.values()]
    .sort((a, b) => (b.score - a.score) || (a.depth - b.depth));

  // Prune around the subject BEFORE capping: the head of the ranking is where
  // the pointed-at part is, and the cap must not spend its slots on background
  // the prune already identified. Pruned names stay on the result as audit
  // evidence — a wrong prune must be as legible as a wrong grounding.
  const subject = ranked[0] || null;
  let candidates = ranked;
  const pruned = [];
  const carves = [];
  if (subject) {
    candidates = [subject];
    for (const c of ranked.slice(1)) {
      let why = null;
      if (c.inside < SUBJECT_MIN_INSIDE) why = `mostly outside the box (inside=${c.inside.toFixed(2)}) — background, not the subject`;
      else if (c.score < SUBJECT_MIN_REL_SCORE * subject.score) why = `score ${c.score.toFixed(2)} is less than half the subject's ${subject.score.toFixed(2)}`;
      else if (c.depth > subject.depth + subject.hd + c.hd) why = 'sits behind the subject — the box denotes the visible surface';
      if (why) pruned.push({ name: c.name, why }); else candidates.push(c);
    }
  }

  // ---- fused-shell carve ------------------------------------------------------
  // The subject is the whole shell and the box covers a sliver of it: the part
  // the model pointed at is FUSED into a bigger mesh and node-granular
  // grounding cannot name it — the best node answer is the shell, which is
  // exactly the scope-mixing failure (wheel + steering wheel + door in one
  // joint). So cut the pointed surface out and answer THAT. On any failure the
  // whole-node answer stands, with the reason carried as a warning.
  if (subject && g.bounds && carveRead) {
    const modelHd = 0.5 * Math.hypot(
      g.bounds.max[0] - g.bounds.min[0],
      g.bounds.max[1] - g.bounds.min[1],
      g.bounds.max[2] - g.bounds.min[2]);
    if (subject.hd >= SHELL_MIN_SHARE * modelHd && subject.inside < SHELL_MAX_INSIDE) {
      const src = g.nodes[subject.i];
      let why = null;
      let spec = null;
      if (!src || src.mi == null) {
        why = 'the subject has no mesh of its own';
      } else {
        const rd = carveRead(src.mi);
        if (!rd) {
          why = 'geometry unavailable (external or missing buffer)';
        } else {
          // The soup is mesh-local, the camera world: seed rays are cast
          // through src.wm's inverse, and the radius — derived from the box's
          // WORLD footprint — is converted into soup units for the flood. The
          // LOCAL radius is what the spec persists, because applyCarves
          // re-floods in soup units on reload; the world value rides along as
          // human-legible evidence.
          const seed = seedFromRegion(rd, cam, nb, { wm: src.wm });
          if (!seed) {
            why = 'no surface under the pointed box';
          } else {
            const worldW = (nb.x1 - nb.x0) * 2 * subject.depth * cam.tanHalfY * cam.aspect;
            const worldH = (nb.y1 - nb.y0) * 2 * subject.depth * cam.tanHalfY;
            const boxDiag = Math.hypot(worldW, worldH);
            const maxRadiusWorld = CARVE_RADIUS_SCALE * (boxDiag / 2);
            const maxRadius = maxRadiusWorld / worldScaleOf(src.wm);
            const patch = floodPatch(rd.positions, rd.index, seed.tri, { maxRadius, seedPoint: seed.point });
            if (!patch || !patch.tris.length) {
              why = 'the seed flooded nothing';
            } else if (patch.tris.length < CARVE_MIN_TRIS) {
              why = `only ${patch.tris.length} triangles flooded — too small to rig`;
            } else {
              patch.mi = src.mi;
              const m = patchMetrics(rd, patch.tris, src.wm);
              const shellArea = patchMetrics(
                rd, Array.from({ length: Math.floor(rd.index.length / 3) }, (_, k) => k), src.wm,
              ).area;
              const share = shellArea > 1e-12 ? m.area / shellArea : 0;
              const patchDiag = 2 * Math.hypot(m.wb.h[0], m.wb.h[1], m.wb.h[2]);
              if (share < CARVE_AREA_RANGE[0] || share > CARVE_AREA_RANGE[1]) {
                why = `patch is ${(share * 100).toFixed(1)}% of the shell — outside the 1..40% a part should be`;
              } else if (patchDiag > CARVE_MAX_BOX_SCALE * boxDiag) {
                why = 'the flood ran past what the box could denote';
              } else {
                try {
                  spec = registerCarve(g, subject.name, patch, { maxRadius, maxRadiusWorld });
                } catch (e) { why = e.message; }
              }
            }
          }
        }
      }
      if (spec) {
        const cnode = g.nodes.find((n) => n.carve === spec.id);
        carves.push(carveEvidence(spec));
        warnings.push(`carved ${spec.triCount} triangles out of "${subject.name}" as ${spec.id} — the pointed part is fused into the shell`);
        candidates = [{
          name: spec.id,
          i: cnode ? cnode.i : subject.i,
          score: subject.score,
          inside: 1,
          fill: subject.fill,
          depth: subject.depth,
          rect: subject.rect,
          hd: Math.hypot(spec.wb.h[0], spec.wb.h[1], spec.wb.h[2]),
          carved: subject.name,
        }];
      } else if (why) {
        warnings.push(`carve failed: ${why} — keeping whole-node scope`);
      }
    }
  }

  candidates = candidates.slice(0, Math.max(1, maxResults | 0));
  if (!candidates.length) warnings.push('no part projects inside this box');
  return { box: nb, dilated: d, candidates, pruned, carves, warnings };
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
  carver,
} = {}) {
  const warnings = [];
  const viaBox = box && view && g ? boxToNodes(box, view, g, { dilate, viewport, minScore, maxResults, carver }) : null;
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
    carves: viaBox?.carves || [],
    uncertainties, warnings,
  };
}

// ---- a category prior's places, resolved to somewhere a camera can aim --------

// The mirror of views.mjs `regionsFromSuggestViews`, and the reason it lives HERE
// rather than beside it: that function turns a NAME into a region, this one turns
// a BOX into one, and box→part is grounding's job. views.mjs already imports this
// module, so putting it there would close a cycle between the two files that do
// all the projection maths.
//
// It resolves an expectation's instances to regions `planCloseUps` can aim at, and
// it ADMITS NOTHING. An expectation is a hypothesis about a CATEGORY; the only
// route into the manifest is a proposal that grounding resolved and the physics
// battery scored (see expectation.mjs). What this function produces is therefore
// strictly a place to look, plus an honest report of every place it could not
// resolve — never an approximation of one, for the same reason
// `regionsFromSuggestViews` refuses to guess: a close-up aimed at a
// plausible-looking part spends the round-2 budget producing a confident answer to
// a question nobody asked.
//
// in:  g, exp  { category, instances: [{ type, count, frameId, regionBox }] }
//      opts   plan, frames  the round that produced the expectation, so a frameId
//                           resolves to the pose that drew it
//             verified     INDICES of instances the discovery turn already pointed
//                          at (expectation.mjs `verifiedInstances`) — not worth a
//                          second look
//             gaps         optional `expectationGap` output; an instance whose type
//                          has no missing count is skipped rather than aimed at
// out: { regions, unresolved, skipped } — regions shaped exactly like
//      `regionsFromSuggestViews`' output, so both feed one `planCloseUps` call.
export function regionsFromExpectations(g, exp, {
  plan = null, frames = [], verified = null, gaps = null,
  maxRegions = 3, viewport = VIEWPORT, dilate = BOX_DILATE, minScore = MIN_BOX_SCORE,
  maxResults = MAX_CANDIDATES,
} = {}) {
  const unresolved = [];
  const skipped = [];
  const regions = [];
  const instances = Array.isArray(exp?.instances) ? exp.instances : [];
  if (!instances.length || !g?.nodes?.length) return { regions, unresolved, skipped };

  const verifiedSet = new Set((verified || []).map((v) => String(v)));
  const gapOf = new Map((gaps || []).filter((x) => x?.type).map((x) => [x.type, x]));

  // A frame reference may be the FRAME id (`v4.photo`) or the VIEW id (`v4`),
  // exactly as in regionsFromSuggestViews, so index both.
  const viewById = new Map((plan?.views || []).map((v) => [String(v.id), v]));
  const frameToView = new Map();
  for (const f of frames || []) {
    const v = viewById.get(String(f?.viewId ?? '')) || viewById.get(String(f?.id ?? ''));
    if (!v) continue;
    if (f.id != null) frameToView.set(String(f.id), v);
    if (f.viewId != null) frameToView.set(String(f.viewId), v);
  }
  const lookup = (ref) => (ref == null || ref === '' ? null
    : viewById.get(String(ref)) || frameToView.get(String(ref)) || null);

  const named = namedIndex(g);
  const boxes = namedBoxes(g, renderTargets(g), (n) => named.get(n.i));
  const R = modelRadius(g);
  const clampR = (r) => Math.max(REGION_MIN_R * R, Math.min(REGION_MAX_R * R, r));
  const category = exp?.category ? `"${exp.category}"` : 'the category prior';

  instances.forEach((ins, i) => {
    const why = (msg) => unresolved.push({
      index: i, type: ins?.type ?? null, frameId: ins?.frameId ?? null,
      origin: 'expectation', why: msg,
    });
    if (!ins || typeof ins !== 'object') return why('the expectation instance was not an object');
    if (verifiedSet.has(String(i))) {
      skipped.push({ index: i, type: ins.type, origin: 'expectation', why: 'the discovery turn already pointed at this place' });
      return;
    }
    const gap = gapOf.get(ins.type);
    if (gap && !(gap.missing > 0)) {
      skipped.push({ index: i, type: ins.type, origin: 'expectation', why: `${gap.found} of ${gap.expected} ${ins.type}(s) are already grounded — nothing missing to aim at` });
      return;
    }
    const view = lookup(ins.frameId);
    if (!view) {
      return why(`frame "${ins.frameId ?? '(none)'}" is not among the frames that round shot`);
    }
    // The SAME channel a proposal is grounded through, at the same settings: an
    // expectation resolved by a looser rule than a claim would aim round 2 at a
    // place no claim could ever be grounded to.
    const gr = groundRegion({ box: ins.regionBox, view, g, viewport, dilate, minScore, maxResults });
    const names = [...new Set((gr.names || []).filter((nm) => boxes.has(nm)))].sort();
    if (!names.length) return why('the expected place grounded to no part of the model');
    const box = unionBoxes(names.map((nm) => boxes.get(nm)));
    if (!box || !box.c.every(Number.isFinite)) return why('the expected place resolved to parts with no finite centre');

    regions.push({
      id: `ex${i}_${slug(ins.type)}`,
      index: i,
      type: ins.type,
      expectedCount: ins.count,
      names,
      anchor: box.c.slice(),
      radius: clampR(Math.hypot(...box.h) * REGION_PAD),
      // A different bearing than the survey frame the expectation was read from,
      // for the reason AZIMUTH_RETRY exists: the same azimuth reproduces the same
      // occlusion, and therefore the same ambiguity.
      azimuth: Number.isFinite(view.spec?.azimuth) ? (view.spec.azimuth + AZIMUTH_RETRY) % 360 : 0,
      reason: `${category} expects ${ins.count} ${ins.type}${ins.symmetry ? ` (${ins.symmetry})` : ''}; ${names.length} part(s) sit where one should be`,
      origin: 'expectation',
      frameId: ins.frameId ?? null,
      grounding: { source: gr.source, candidates: gr.candidates.length, kept: names.length },
    });
  });

  // Two instances that ground to the same parts are one place; buying both would
  // spend the budget on the same close-up from two nearby bearings.
  const byKey = new Map();
  for (const r of regions) {
    const key = r.names.join('|');
    const prev = byKey.get(key);
    if (prev) { skipped.push({ ...r, why: `same parts as ${prev.id}` }); continue; }
    byKey.set(key, r);
  }
  const deduped = [...byKey.values()];
  const cap = Math.max(1, maxRegions | 0);
  for (const r of deduped.slice(cap)) skipped.push({ ...r, why: `over the ${cap}-region cap` });
  return { regions: deduped.slice(0, cap), unresolved, skipped };
}

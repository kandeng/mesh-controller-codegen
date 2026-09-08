// L2-vision producer — turns one multi-image VLM reply into validated candidates.
//
// PURE like ai-propose.mjs: the model call and the frame capture are injected by
// the caller. What lives here is the part that is genuinely new in phase 3 —
// turning a model that POINTS into a node set the graph can hold.
//
// The asymmetry with the text producer is the whole design:
//
//   TEXT   is handed real node names and returns them. Validation is a lookup.
//   VISION is handed pixels and returns a region. The names do not exist in its
//          output at all, so they must be RESOLVED — grounding.mjs projects the
//          geometry through the frame's own camera and reads the colour table.
//          That resolution is itself uncertain, and the uncertainty is evidence
//          that must travel onto the record, not be averaged away.
//
// Two further things a vision model is asked for that a text model is not:
// `reasoning`/`uncertainties` (what it saw, and what it is not sure of) and
// `suggestView` (where to look next). suggestView is collected from EVERY item
// including dropped ones — a proposal that failed grounding is precisely the one
// whose region deserves another frame, and round 2 is driven by this list.
//
// Discipline held: `p.confidence` from the model is carried as `modelConfidence`
// for ROUTING only. The gate forces `confidence: L2_VISION_BASE_CONFIDENCE`
// after spreading extra, so no self-report can ever reach rec.confidence. Only
// the deterministic battery lifts a record (see loop.mjs).
import { VIEWPORT, namedIndex, nodeBox, renderTargets } from './views.mjs';
import { BOX_DILATE, MAX_CANDIDATES, MIN_BOX_SCORE, groundRegion } from './grounding.mjs';
import { createProposalGate, parseReply, vec3, TYPES } from './propose-core.mjs';

export const L2_VISION_BASE_CONFIDENCE = 0.7;

// A box is a COARSE hypothesis: dilated by design and depth-sorted, so its tail
// is background. Admitting all 24 candidates as one joint would hand the battery
// a set containing the fuselage, which discCoherence then fails — correct, but
// wasteful, and it burns one of only six proposal slots. The head of the ranking
// is where the pointed-at part is; the battery prunes the rest.
export const MAX_BOX_NODES = 8;

// Below this ratio of smallest-to-middle principal variance the part cloud is a
// flat disc or plate, so its least-variance direction really is a spin axis
// rather than an arbitrary perpendicular. Above it the cloud is blobby and the
// "axis" would be noise presented as geometry — refuse instead.
export const AXIS_FLATNESS = 0.15;

// The axis convention geometry discovery already commits to (see geometry.mjs):
// these meshes are Z-up, a rotor spins about the vertical, a camera cradle tilts
// about the lateral X. Used as a LAST RESORT and only for a converted confirm —
// a reply that was never asked for an axis, because the prompt asks for one only
// of op:"new". Refusing such a record for a missing field we never requested
// would discard the only evidence about a mesh whose node names are numeric and
// whose rotors therefore arrive exclusively as confirms. The assumption is
// written into the record's doubts, so a human sees exactly what was assumed.
const CONVENTIONAL_AXIS = { rotor: [0, 0, 1], gimbal: [1, 0, 0] };

// name -> placed world box, unioned over the mesh nodes that name resolves to.
// Union rather than first-match: a named part is often several mesh nodes (a
// rotor = hub + N blades), and the anchor of a group is the centre of the GROUP.
function nameBoxes(g) {
  const named = namedIndex(g);
  const out = new Map();
  for (const n of renderTargets(g)) {
    const b = nodeBox(n);
    if (!b) continue;
    const nm = named.get(n.i) || n.name;
    const prev = out.get(nm);
    if (!prev) { out.set(nm, { c: b.c.slice(), h: b.h.slice() }); continue; }
    for (let k = 0; k < 3; k += 1) {
      const lo = Math.min(prev.c[k] - prev.h[k], b.c[k] - b.h[k]);
      const hi = Math.max(prev.c[k] + prev.h[k], b.c[k] + b.h[k]);
      prev.c[k] = (lo + hi) / 2;
      prev.h[k] = (hi - lo) / 2;
    }
  }
  return out;
}

// Jacobi eigen-decomposition of a real symmetric 3x3 (flat, row-major).
// Returns eigenvalues ASCENDING with their unit eigenvectors as columns.
// Jacobi rather than the analytic trigonometric form because it yields the
// VECTORS as well as the values, and rotating to zero off-diagonals is stable
// for the badly-scaled covariances a CAD assembly produces (metres of fuselage
// against millimetres of fastener).
function jacobi3(m) {
  const a = m.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const pairs = [[0, 1], [0, 2], [1, 2]];
  for (let sweep = 0; sweep < 24; sweep += 1) {
    let p = 0; let q = 1; let mag = 0;
    for (const [i, j] of pairs) {
      const x = Math.abs(a[i * 3 + j]);
      if (x > mag) { mag = x; p = i; q = j; }
    }
    if (mag < 1e-14) break;
    const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * a[p * 3 + q]);
    // The smaller-magnitude root, chosen without dividing by zero when theta is 0.
    const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1);
    const s = t * c;
    for (let k = 0; k < 3; k += 1) {
      const akp = a[k * 3 + p]; const akq = a[k * 3 + q];
      a[k * 3 + p] = c * akp - s * akq;
      a[k * 3 + q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k += 1) {
      const apk = a[p * 3 + k]; const aqk = a[q * 3 + k];
      a[p * 3 + k] = c * apk - s * aqk;
      a[q * 3 + k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k += 1) {
      const vkp = v[k * 3 + p]; const vkq = v[k * 3 + q];
      v[k * 3 + p] = c * vkp - s * vkq;
      v[k * 3 + q] = s * vkp + c * vkq;
    }
  }
  const vals = [a[0], a[4], a[8]];
  const cols = [0, 1, 2].map((j) => [v[j], v[3 + j], v[6 + j]]);
  const order = [0, 1, 2].sort((x, y) => vals[x] - vals[y]);
  return { values: order.map((i) => vals[i]), vectors: order.map((i) => cols[i]) };
}

// The centroid of the grounded parts, in model world units.
//
// This REPLACES the model's `anchor` whenever grounding produced names, and that
// is not distrust for its own sake: an anchor is a 3D point and the model is
// looking at a 2D projection, so depth along the view ray is unrecoverable from
// the image. Its box tells us WHERE in the frame; our geometry tells us how far
// away. The model's own number is kept as `modelAnchor` for comparison.
export function cloudAnchor(boxes, names) {
  const pts = names.map((n) => boxes.get(n)).filter(Boolean);
  if (!pts.length) return null;
  const c = [0, 0, 0];
  for (const b of pts) for (let k = 0; k < 3; k += 1) c[k] += b.c[k];
  return c.map((x) => x / pts.length);
}

// The least-variance principal direction of the grounded parts' box CORNERS.
//
// Corners rather than centres: a two-blade rotor has only two centres, which is a
// degenerate line whose perpendicular plane is entirely ambiguous, so the answer
// would be a coin toss. Its blade boxes are flat plates, and the corners of
// plates resolve the normal even at n=2.
//
// Returns null when the cloud is not flat enough to have a meaningful axis —
// guessing here would produce a confident wrong spin axis, which is the single
// most damaging error this producer could make.
export function cloudAxis(boxes, names, { flatness = AXIS_FLATNESS } = {}) {
  const pts = [];
  for (const n of names) {
    const b = boxes.get(n);
    if (!b) continue;
    for (let k = 0; k < 8; k += 1) {
      pts.push([
        b.c[0] + (k & 1 ? b.h[0] : -b.h[0]),
        b.c[1] + (k & 2 ? b.h[1] : -b.h[1]),
        b.c[2] + (k & 4 ? b.h[2] : -b.h[2]),
      ]);
    }
  }
  if (pts.length < 8) return null;
  const mean = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k += 1) mean[k] += p[k];
  for (let k = 0; k < 3; k += 1) mean[k] /= pts.length;

  const cov = new Array(9).fill(0);
  for (const p of pts) {
    const d = [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]];
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) cov[i * 3 + j] += d[i] * d[j];
  }
  for (let i = 0; i < 9; i += 1) cov[i] /= pts.length;

  const { values, vectors } = jacobi3(cov);
  if (!(values[1] > 0) || values[0] / values[1] > flatness) return null;
  const a = vectors[0];
  const len = Math.hypot(a[0], a[1], a[2]);
  if (!(len > 1e-9)) return null;
  const u = a.map((x) => x / len);
  // Orient to the dominant positive hemisphere. A spin axis and its negation
  // describe the same rotation, and the prompt states the Z-up convention, so
  // [0,0,-1] is reported as [0,0,1] for consistency with the text producer.
  const dom = Math.abs(u[0]) >= Math.abs(u[1]) && Math.abs(u[0]) >= Math.abs(u[2]) ? 0
    : Math.abs(u[1]) >= Math.abs(u[2]) ? 1 : 2;
  return u[dom] < 0 ? u.map((x) => -x) : u;
}

// Index the frames a reply may refer to, joining each stored entry to the plan
// view that asked for it so a frame whose entry lost its pose can still ground.
function frameIndex(frames, plan) {
  const viewById = new Map((plan?.views || []).map((v) => [v.id, v]));
  const out = new Map();
  for (const f of frames || []) {
    if (!f?.id) continue;
    const v = viewById.get(f.viewId || f.id) || null;
    const cm = f.colorMap;
    out.set(String(f.id), {
      id: String(f.id),
      mode: f.mode || v?.mode || 'photo',
      pose: f.pose || v?.pose || null,
      spec: f.spec || v?.spec || null,
      covers: f.covers ?? v?.covers ?? null,
      // A stored entry carries the colour map's FILENAME, not its contents. A
      // string here means the caller forgot to load it, and treating that string
      // as a map would silently resolve every colour to nothing.
      colorMap: cm && typeof cm === 'object' ? cm : null,
      colorMapMissing: typeof cm === 'string' && cm.length > 0,
    });
  }
  return out;
}

// Resolve one proposal's locator to node names.
// Returns { names, grounding, uncertainties, warnings } — `names` may be empty.
function resolveNodes(p, frame, g, opts, maxBoxNodes) {
  const warnings = [];
  const uncertainties = [];

  // The rare case the prompt allows: real names were handed to the model.
  if (Array.isArray(p.nodeIds) && p.nodeIds.length) {
    return {
      names: p.nodeIds.map(String),
      grounding: { source: 'nodeIds', frameId: frame?.id ?? null, mode: frame?.mode ?? null },
      uncertainties,
      warnings,
    };
  }

  const box = p.regionBox ?? p.box ?? null;
  const colors = p.regionColors ?? p.regionColour ?? p.colors ?? null;
  if (!box && !colors) {
    return { names: [], grounding: null, uncertainties: ['no locator: needs regionBox, regionColors or nodeIds'], warnings };
  }
  if (!frame) {
    // Do NOT ground against some other frame's camera: the box is a fraction of
    // an image, so it is meaningless without the exact pose that drew it.
    warnings.push(`frameId "${p.frameId ?? '(none)'}" is not among the frames sent`);
    return { names: [], grounding: null, uncertainties: ['locator names a frame that was not sent, so it cannot be grounded'], warnings };
  }

  const gr = groundRegion({
    box, colors, view: frame, g,
    colorMap: frame.colorMap,
    viewport: opts.viewport, dilate: opts.dilate, minScore: opts.minScore, maxResults: opts.maxResults,
  });
  warnings.push(...gr.warnings);
  uncertainties.push(...gr.uncertainties);

  // Colours reported against a frame with no mask are not a soft failure. The
  // model identified a part EXACTLY and we threw the identification away; saying
  // so is what makes the resulting box-only grounding legible as weaker.
  if (colors && !frame.colorMap) {
    const why = frame.colorMapMissing
      ? 'its colour table was not loaded'
      : `frame "${frame.id}" is a ${frame.mode} render, not a colorId mask`;
    warnings.push(`regionColors ignored: ${why}`);
    uncertainties.push(`reported colours were unreadable because ${why}, so this part is grounded geometrically instead of exactly`);
  }

  let names = gr.names;
  let truncated = 0;
  if (gr.source === 'box' && names.length > maxBoxNodes) {
    truncated = names.length - maxBoxNodes;
    names = names.slice(0, maxBoxNodes);
    uncertainties.push(`box grounding was coarse: kept the ${maxBoxNodes} best-scoring of ${names.length + truncated} candidates, dropped ${truncated} (the battery prunes the rest)`);
  }

  return {
    names,
    grounding: {
      source: gr.source,
      frameId: frame.id,
      mode: frame.mode,
      agreement: gr.agreement.verdict,
      score: Number(gr.agreement.score.toFixed(3)),
      jaccard: Number(gr.agreement.jaccard.toFixed(3)),
      candidates: gr.candidates.length,
      kept: names.length,
      truncated,
      box: gr.box,
      colors: gr.colors.map((c) => c.color),
    },
    uncertainties,
    warnings,
  };
}

// Build the suggestView for round 2. The model's own request wins; when it gave
// none but the grounding was weak, we synthesize one, because "the box channel
// had to guess" is exactly the condition another frame can fix.
function suggestFor(p, grounding, names) {
  const sv = p.suggestView;
  if (sv && typeof sv === 'object' && (sv.target || sv.reason)) {
    return { target: String(sv.target || '').slice(0, 160), reason: String(sv.reason || '').slice(0, 240), origin: 'model' };
  }
  if (!grounding) return null;
  if (grounding.source === 'box') {
    return {
      target: names[0] || grounding.frameId || 'the same region',
      reason: 'grounding was geometric only — a colorId mask of this region would replace it with an exact colour lookup',
      origin: 'derived',
    };
  }
  if (grounding.agreement === 'disagree' || grounding.agreement === 'partial') {
    return {
      target: grounding.frameId,
      reason: `the drawn box and the reported colours disagreed (${grounding.agreement}) — a close-up would settle which part was meant`,
      origin: 'derived',
    };
  }
  return null;
}

// Validate a vision reply.
//
// in:  { reply, g, manifest, frames, plan, viewport, dilate, minScore, maxResults,
//        maxBoxNodes, independent }
//      `frames` entries must carry `pose` and, for masks, a RESOLVED `colorMap`
//      object (loadColorMap, not the stored filename).
//      `independent` marks a lane that must not inherit another producer's
//      conclusions: the gate keeps the whole manifest for identity (ids, dedupe,
//      confirm targets) but only a HUMAN-confirmed record still blocks a proposal
//      for the same parts. Two producers that agree then become one reconciled
//      record with corroboration instead of one dropped proposal.
// out: { records, confirms, warnings, grounded, admitted, suggestViews }
//      `grounded` is one entry per proposal — including the dropped ones — so the
//      UI can show why a claim did or did not become a record, and `admitted`
//      says which of them survived. The complement of the two is the audit trail.
export function visionPropose({
  reply, g, manifest, frames = [], plan = null,
  viewport = VIEWPORT, dilate = BOX_DILATE, minScore = MIN_BOX_SCORE,
  maxResults = MAX_CANDIDATES, maxBoxNodes = MAX_BOX_NODES, independent = false,
} = {}) {
  const gate = createProposalGate({
    g,
    manifest,
    idTag: 'vis',
    label: (t) => `${t} (vision proposal)`,
    evidenceTag: 'l2-vision',
    baseConfidence: L2_VISION_BASE_CONFIDENCE,
    origin: 'L2-vision',
    independent,
  });
  const opts = { viewport, dilate, minScore, maxResults };
  const byFrame = frameIndex(frames, plan);
  const boxes = nameBoxes(g);
  const grounded = [];
  const suggestViews = [];
  const admitted = [];

  const { items, warnings } = parseReply(reply);
  gate.warnings.push(...warnings);

  items.forEach((p, idx) => {
    const frameId = p?.frameId != null ? String(p.frameId) : null;
    const frame = frameId ? byFrame.get(frameId) : null;
    if (p && typeof p === 'object' && frameId && !frame) {
      gate.warnings.push(`proposal[${idx}] names unknown frameId "${frameId}" (sent: ${[...byFrame.keys()].slice(0, 8).join(', ') || 'none'})`);
    }

    // A confirm whose target is NOT on the books is still an OBSERVATION: the
    // model is pointing at a part the manifest has no record for — typically a
    // mesh the geometry heuristics found nothing in, where every rotor arrives
    // as a "confirm" of an id the model invented from the naming convention.
    // Dropping those would throw away the only evidence we have; re-routing them
    // to `new` keeps the trust boundary exactly where it always was — grounding
    // resolves the nodes, the battery disposes the confidence, a human holds the
    // verdict. A confirm of a KNOWN id stays a confirm and changes nothing here.
    let item = p;
    let convertedFrom = null;
    if (p && typeof p === 'object' && p.op === 'confirm' && p.targetId && !gate.has(p.targetId)
      && TYPES.has(p.type) && (p.regionBox || p.regionColors || p.regionColour || p.colors || p.nodeIds)) {
      convertedFrom = String(p.targetId);
      item = { ...p, op: 'new' };
    }

    // suggestView is collected BEFORE validation and regardless of outcome: a
    // proposal dropped for bad grounding is the strongest possible argument for
    // spending another frame on that region.
    const resolved = resolveNodes(item, frame, g, opts, maxBoxNodes);
    gate.warnings.push(...resolved.warnings);

    const sv = suggestFor(item, resolved.grounding, resolved.names);
    if (sv) suggestViews.push({ index: idx, frameId, ...sv });

    const uncertainties = [
      ...resolved.uncertainties,
      ...(convertedFrom ? [`reported as op:"confirm" of "${convertedFrom}", which is not in the current joint map — treated as a NEW proposal and grounded from its region`] : []),
      ...(Array.isArray(p?.uncertainties) ? p.uncertainties.map((u) => String(u).slice(0, 240)) : []),
    ];

    grounded.push({
      index: idx, frameId, names: resolved.names, grounding: resolved.grounding, uncertainties,
    });

    // Geometry supplies anchor and axis when it can, because both are 3D facts
    // and the model saw a 2D projection. Its own numbers are preserved for
    // comparison rather than discarded — a large gap between them is itself a
    // signal worth showing a human.
    let anchor = vec3(p?.anchor) ? p.anchor.map(Number) : null;
    let anchorSource = anchor ? 'model' : null;
    let axis = vec3(p?.axis) ? p.axis.map(Number) : null;
    let axisSource = axis ? 'model' : null;

    if (resolved.names.length) {
      const geo = cloudAnchor(boxes, resolved.names);
      if (geo) {
        if (anchor) {
          const d = Math.hypot(anchor[0] - geo[0], anchor[1] - geo[1], anchor[2] - geo[2]);
          if (d > 0.25 * (g.wradius || g.radius || 1)) {
            uncertainties.push(`reported anchor is ${d.toFixed(1)} units from the centroid of the parts it denotes — the geometry centroid was used instead`);
          }
        }
        anchor = geo;
        anchorSource = 'geometry';
      }
      if (!axis) {
        const derived = cloudAxis(boxes, resolved.names);
        if (derived) {
          axis = derived;
          axisSource = 'geometry';
          uncertainties.push('spin axis was derived from the shape of the grounded part cloud, not reported by the model');
        }
      }
      if (!axis && convertedFrom && CONVENTIONAL_AXIS[item.type]) {
        axis = CONVENTIONAL_AXIS[item.type].slice();
        axisSource = 'convention';
        uncertainties.push(`no axis was reported (a "confirm" is never asked for one) and the grounded cloud is too blobby to derive one — assumed the ${item.type} convention [${axis.join(', ')}] that geometry discovery uses; the spin direction needs a human check`);
      }
    }
    if (!anchor) uncertainties.push('no anchor: the model gave none and grounding produced no parts to centroid');
    if (!axis) uncertainties.push('no axis: the model gave none and the part cloud is not flat enough to derive one');

    const extra = {
      reasoning: p?.reasoning ? String(p.reasoning).slice(0, 480) : undefined,
      uncertainties: uncertainties.length ? uncertainties : undefined,
      suggestView: sv || undefined,
      grounding: resolved.grounding || undefined,
      frameId: frameId || undefined,
      anchorSource: anchorSource || undefined,
      axisSource: axisSource || undefined,
      modelAnchor: vec3(p?.anchor) ? p.anchor.map(Number) : undefined,
      // ROUTING ONLY. The gate forces `confidence` after spreading this object,
      // so a model's self-assessment can never become a record's confidence.
      modelConfidence: Number.isFinite(p?.confidence) ? Number(p.confidence) : undefined,
      evidence: [
        frameId ? `frame:${frameId}` : null,
        resolved.grounding ? `grounded-by:${resolved.grounding.source}` : null,
        convertedFrom ? `confirm-converted:${convertedFrom}` : null,
      ].filter(Boolean),
    };

    const verdict = gate.admit({ ...item, anchor, axis }, idx, { names: resolved.names, extra });
    // Which proposals survived, by index. Recovering this from the record ids
    // would mean parsing an id format, so it is reported directly instead — the
    // complement is the audit trail of what we refused and why.
    if (verdict) admitted.push({ index: idx, verdict, id: verdict === 'record' ? gate.records[gate.records.length - 1].id : p.targetId });
  });

  return {
    records: gate.records,
    confirms: gate.confirms,
    warnings: gate.warnings,
    grounded,
    admitted,
    suggestViews,
  };
}

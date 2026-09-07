// Symmetry peers — the LATERAL edge in the justification graph.
//
// Every other relation in this codebase is vertical: a producer makes a record, a
// test scores it, a split subtracts from a parent, a human disposes of the result.
// None of them can say "these two joints are the same part in two places".
// Symmetry can, and it matters for cost: on a quadrotor one human verdict on the
// front-left rotor is evidence about the other three, because they are the same
// part mirrored — and asking a person to press the same button four times is how a
// human gate ends up being waved through instead of read.
//
// Two design rules follow from that, and both are load-bearing:
//
//   1. It is an OFFER, never an automatic application. A quad with one bent arm
//      is still a quad, and the mirror of a correct judgement can be wrong.
//      Geometry proposes the peer set; a human accepts each member of it.
//
//   2. Peers are found by GEOMETRY, not by id string-matching. Matching
//      `rotor_fl` to `rotor_fr` by name is tempting and works on exactly one
//      model — the one whose ids happen to encode a quadrant. It finds nothing on
//      the ids a proposal producer mints (`rotor_vis_2`), and it would happily
//      pair two joints that are nowhere near mirror images if someone named them
//      that way. A mirrored anchor is a fact about the mesh; a name is a habit.
//
// Model space is Z-up (XY horizontal, Z vertical), the same convention parseGlb,
// the joint anchors and the viewer scene all use — so the glosses below speak of
// port/starboard and fore/aft rather than left/right, which would be ambiguous
// about whose left.

// The seven non-identity sign flips of a point about the model centre. A mirror
// across a principal plane negates one coordinate; a 180° turn about an axis
// negates the other two; negating all three is a point reflection.
//
// Enumerated rather than special-cased to "the two mirrors a drone has", because
// the module has no business assuming how many axes of symmetry its subject has —
// a gimbal on a pan-tilt head has different ones from a quad's arms, and a
// landing gear has none of the ones a rotor has.
const FLIPS = [
  { key: 'x', s: [-1, 1, 1], gloss: 'mirrored across the fore–aft centreline (port ↔ starboard)' },
  { key: 'y', s: [1, -1, 1], gloss: 'mirrored across the lateral centreline (fore ↔ aft)' },
  { key: 'z', s: [1, 1, -1], gloss: 'mirrored across the horizontal plane (above ↔ below)' },
  { key: 'xy', s: [-1, -1, 1], gloss: 'turned 180° about the vertical axis (the diagonal pair)' },
  { key: 'xz', s: [-1, 1, -1], gloss: 'mirrored fore–aft and flipped over' },
  { key: 'yz', s: [1, -1, -1], gloss: 'mirrored lateral and flipped over' },
  { key: 'xyz', s: [-1, -1, -1], gloss: 'point-reflected through the model centre' },
];

// Only a whole judgement travels. An `edit` verdict carries corrections expressed
// in THIS joint's node names, and a mirror's nodes are different nodes — copying
// the edit across would claim the source's parts on the peer, which is not a
// weakened version of the verdict but a different and wrong one.
export const AMORTIZABLE = new Set(['accept', 'reject']);

const v3 = (a) => (a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z) ? [a.x, a.y, a.z] : null);

// Peer tolerances, as fractions of the model radius so they scale with the mesh.
//
// `tol` is how far a mirrored anchor may miss the other joint's anchor. It has to
// be loose enough for a real model (an arm that is a millimetre out of true, a
// rotor whose hub node sits slightly off the disc centre) and tight enough that
// two adjacent parts are never called mirrors of each other.
//
// `minSeparation` is the guard against the degenerate case the mirror test
// otherwise walks straight into: a joint whose anchor lies ON a principal plane
// mirrors onto itself, so any two co-located joints of the same type — a gimbal
// and the camera hanging off it — would come out as "mirrors" at zero gap. They
// are not symmetric, they are in the same place, and offering one verdict on both
// would be offering a verdict on a part against itself.
//
// `axisDot` treats a spin axis as a LINE, not a ray: FL and BR counter-rotate, so
// their recorded axes may point in opposite directions and still be the same axis.
// Comparing with sign would break exactly the diagonal pair the feature is for.
//
// `familySpread` is the looser test for the second tier, see peersOf. Relative
// rather than absolute because it compares two radii, and an absolute number would
// mean something different on every model.
export const SYMMETRY_TOLERANCE = 0.06;
export const SYMMETRY_MIN_SEPARATION = 2 * SYMMETRY_TOLERANCE;
export const SYMMETRY_AXIS_DOT = Math.cos(10 * Math.PI / 180);
export const SYMMETRY_FAMILY_SPREAD = 0.15;

// Peers of one record, each with the reason it qualifies.
//
// Two tiers, and the tier is always reported rather than folded away:
//
//   'mirror'  the anchor really is a sign-flipped image of this one about the
//             model centre. The strongest claim available, and the one the plan
//             means by a lateral edge — one verdict on rotor_fl genuinely is
//             evidence about rotor_fr because they are the same part reflected.
//
//   'family'  same type, same node count, same axis, at a comparable distance
//             from the model centre, but NOT a mirror image. Weaker, and offered
//             because the alternative is worse: a real mesh is rarely symmetric
//             enough for every sibling to mirror. The sample drone's placed bbox
//             is symmetric in X to four decimal places and in neither Y nor Z, so
//             a mirror-only rule finds two pairs of rotors where there are four
//             of the same part — and the human ends up pressing the button twice
//             for a judgement they have already made.
//
// Sorting mirrors first means a panel that shows the list top-down puts the
// strongest evidence where the reader looks first, and `basis` lets it draw the
// two tiers differently. Neither tier is ever applied automatically.
//
// Returns [] rather than throwing for an unknown id, a record with no usable
// anchor, or a manifest with one entry: "this joint has no peer" and "you asked
// about a joint that does not exist" are the same thing to a caller that only
// wants to know whom to offer the button to, and the route already 404s the
// second case before it gets here.
//
// opts: { center:[x,y,z], radius, tol, minSeparation, axisDot, familySpread }
export function peersOf(manifest, id, {
  center = [0, 0, 0], radius = 1,
  tol = SYMMETRY_TOLERANCE, minSeparation = SYMMETRY_MIN_SEPARATION,
  axisDot = SYMMETRY_AXIS_DOT, familySpread = SYMMETRY_FAMILY_SPREAD,
} = {}) {
  const recs = (manifest || []).filter((r) => r && r.id != null);
  const me = recs.find((r) => r.id === id);
  if (!me) return [];
  const mine = v3(me.anchor);
  if (!mine) return [];

  const R = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const gapTol = Math.max(0, tol) * R;
  const minSep = Math.max(0, minSeparation) * R;
  const c = Array.isArray(center) && center.length === 3 ? center : [0, 0, 0];
  const myNodes = (me.nodes || []).length;
  const myAxis = v3(me.axis);
  const dist = (p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
  const myDist = dist(mine);

  const peers = [];
  for (const other of recs) {
    if (other.id === me.id) continue;
    // Same kind of joint, or the relation is a coincidence of position: a rotor
    // and a gimbal placed symmetrically are not the same part in two places, and
    // amortizing a verdict across them would claim a person had judged a joint type
    // they never looked at.
    if (other.type !== me.type) continue;
    const theirs = v3(other.anchor);
    if (!theirs) continue;

    const sep = Math.hypot(mine[0] - theirs[0], mine[1] - theirs[1], mine[2] - theirs[2]);
    if (sep < minSep) continue;

    // Axis parallel-or-antiparallel, on the same reasoning as `minSeparation`: a
    // rotor whose neighbour spins about a perpendicular axis is a different
    // mechanism even if the hubs mirror perfectly. Skipped when either axis is
    // missing rather than treated as a failure — an axis-less record is a phase-1
    // artefact, not evidence of a different mechanism.
    const theirAxis = v3(other.axis);
    if (myAxis && theirAxis) {
      const m = Math.hypot(...myAxis) || 1;
      const t = Math.hypot(...theirAxis) || 1;
      const dot = Math.abs((myAxis[0] * theirAxis[0] + myAxis[1] * theirAxis[1] + myAxis[2] * theirAxis[2]) / (m * t));
      if (dot < axisDot) continue;
    }

    // Which flips land on this joint, and how far off each one is. Several can
    // match (a part on a diagonal is both an x-mirror of one peer and a y-mirror of
    // another); all matches are reported, best first, because the gloss is what a
    // human reads to decide whether the offer makes sense.
    const hits = [];
    for (const f of FLIPS) {
      const gap = Math.hypot(
        (c[0] + (mine[0] - c[0]) * f.s[0]) - theirs[0],
        (c[1] + (mine[1] - c[1]) * f.s[1]) - theirs[1],
        (c[2] + (mine[2] - c[2]) * f.s[2]) - theirs[2],
      );
      if (gap <= gapTol) hits.push({ flip: f.key, gloss: f.gloss, gap: gap / R });
    }

    const theirNodes = (other.nodes || []).length;
    let basis;
    let flip = null;
    let gloss;
    let gap = null;
    if (hits.length) {
      hits.sort((a, b) => a.gap - b.gap);
      basis = 'mirror';
      flip = hits[0].flip;
      gloss = hits[0].gloss;
      gap = +hits[0].gap.toFixed(4);
    } else {
      // The family tier leans entirely on structure, so the node count has to
      // match exactly: with no geometry to corroborate it, "same number of parts"
      // is the only evidence that these are the same part rather than two joints
      // that happen to share a type. Size is then compared as a RADIUS from the
      // model centre, which is the invariant that says "same role on the machine"
      // — every rotor of a quad sits at the same reach from the body, whether or
      // not the export is symmetric enough to prove it by reflection.
      if (theirNodes !== myNodes) continue;
      const theirDist = dist(theirs);
      const spread = Math.abs(myDist - theirDist) / Math.max(1e-9, Math.max(myDist, theirDist));
      if (spread > familySpread) continue;
      basis = 'family';
      gloss = `same ${other.type} with the same ${theirNodes} part(s) at a comparable reach from the model centre (${(spread * 100).toFixed(1)}% apart) — not a mirror image`;
    }

    peers.push({
      id: other.id,
      label: other.label ?? null,
      type: other.type,
      basis,
      flip,
      gloss,
      gap,
      flips: hits.map((h) => h.flip),
      nodeCount: theirNodes,
      // Reported, never used as a gate on the mirror tier. A real machine can have
      // a mirror with one blade missing, and the human is precisely the right
      // person to decide whether that one still deserves the same verdict —
      // hiding the peer would take the question away from the only party who can
      // answer it. On the family tier it IS a gate, because there it is the only
      // structural evidence there is.
      sameNodeCount: theirNodes === myNodes,
      status: other.status ?? null,
      verdict: other.verdict ?? null,
      separation: +(sep / R).toFixed(4),
    });
  }
  // Mirrors before family, then best-fitting first, then by id so the order is
  // stable between calls — a panel that reshuffles its checkboxes every time it is
  // opened is a panel nobody trusts.
  const rank = { mirror: 0, family: 1 };
  return peers.sort((a, b) => rank[a.basis] - rank[b.basis]
    || (a.gap ?? 1) - (b.gap ?? 1)
    || String(a.id).localeCompare(String(b.id)));
}

// The whole peer relation as a map, for an overview the panel can render at once.
export function symmetryPeers(manifest, opts = {}) {
  const out = new Map();
  for (const rec of manifest || []) {
    if (!rec || rec.id == null) continue;
    out.set(rec.id, peersOf(manifest, rec.id, opts));
  }
  return out;
}

// Connected components of the peer relation — the sets of joints a single verdict
// can be offered to. Useful to a caller that wants to show "these four are one
// symmetric family" without walking the map itself.
//
// Union-find over the map rather than a second geometric pass, so the grouping is
// guaranteed to agree with peersOf: a group computed by its own criteria could
// drift from the peer list shown next to it. Components are transitive, so two
// mirrors plus a family link come out as one group of four.
export function symmetryGroups(manifest, opts = {}) {
  const ids = (manifest || []).filter((r) => r && r.id != null).map((r) => r.id);
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); return r; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const map = symmetryPeers(manifest, opts);
  for (const [id, peers] of map) for (const p of peers) union(id, p.id);

  const groups = new Map();
  for (const id of ids) {
    const root = find(id);
    const arr = groups.get(root) || [];
    arr.push(id);
    groups.set(root, arr);
  }
  // Only families, not singletons: a joint with no mirror has nothing to amortize
  // to, and listing it would make the group count say "5 symmetric families" about
  // a manifest that has one.
  return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
}

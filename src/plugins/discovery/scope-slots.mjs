// Scope slots — the deterministic reconcile pass that runs over every produced
// record BEFORE the visual scope audit and again (exclusivity only) after it.
//
// Why this exists: box grounding on a baked-vertex export returns a COARSE
// candidate set, and on that mesh class the parse table contains two kinds of
// node a joint scope must never own:
//
//   CONTAINERS — one node whose placed bbox is the whole machine or a
//     both-sides band (Body, interior, the windshield glass, a light bar that
//     spans left AND right). Such a node projects over almost any pointed box,
//     so it survives every score-based prune and drags both sides into
//     whatever scope admitted it.
//   CROSS-SIDE SLABS — a genuine part, but of the OTHER side (the right door
//     slab inside a left-door or wheel scope).
//
// and two record-level defects:
//
//   DUPLICATE SLOTS — two producers describe the same physical actuator (an
//     expectation hint and a vision proposal both mean "the left door") with
//     DISJOINT node sets, so a node-overlap merge never fires and the machine
//     ends up with two left doors.
//   SHARED NODES — the same node admitted into two scopes at once.
//
// Every rule here reads PLACED boxes (n.wb), never node origins: baked-vertex
// exports keep dozens of nodes at one shared origin while their geometry sits
// metres away, so origin-based side/quadrant tests are blind on that class.
//
// The pass is pure: records in, records out, every mutation recorded as a
// history entry + uncertainty + warning so a wrong reconcile is as legible as
// a wrong grounding.
import { placedPt, quadrantLabel } from './geometry.mjs';

// A node is a both-sides BAND only when its placed bbox extends a substantial
// share of the model's half-span on BOTH sides of the left/right centreline —
// a car's light bar or body reaches well past centre both ways. This is NOT the
// same as merely crossing the centreline: a drone arm radiates from the hub out
// to one rotor, so it crosses the centre but sits almost entirely on one side,
// and must NOT be mistaken for a band. 0.5 of the half-span separates the two.
export const CONTAINER_BOTH_SIDES_SHARE = 0.5;
// A node whose placed-bbox diagonal is at least this share of the model's is
// the shell/interior itself, whichever side it leans to.
export const CONTAINER_DIAG_SHARE = 0.7;
// Two records share a slot key (part@quadrant) but a quadrant is a COARSE
// bucket — on a symmetric machine several distinct actuators can land in the
// same one, and a bloated "monster" scope can sit beside compact neighbours.
// They merge into a single actuator only when their scopes genuinely COINCIDE,
// measured by the GEOMETRIC MEAN of their radii: sqrt(rA*rB) is large only when
// BOTH scopes are substantial and their centroids are close, so a big cluster
// merely touching a near-point neighbour (geometric mean ~0) never absorbs it,
// while two real descriptions of one part (a door's glass and its panel) do.
export const SLOT_MERGE_REACH = 1.25;
// A record whose containers are MORE than this share of its nodes (but not all
// of them) is a whole-machine grab, not a part with a stray shell node — see
// step A. Left intact so the battery's spread ruler still rejects it.
export const SHELL_DOMINANT_SHARE = 0.5;

// ---- model frame -------------------------------------------------------------

// Union of every placed mesh box: the machine's own world bbox.
export function modelBox(g) {
  let mn = null; let mx = null;
  for (const n of (g?.nodes || [])) {
    if (!n.wb) continue;
    if (!mn) { mn = n.wb.min.slice(0, 3); mx = n.wb.max.slice(0, 3); continue; }
    for (let k = 0; k < 3; k += 1) {
      mn[k] = Math.min(mn[k], n.wb.min[k]); mx[k] = Math.max(mx[k], n.wb.max[k]);
    }
  }
  if (!mn) return null;
  return { min: mn, max: mx, span: mx.map((v, k) => v - mn[k]), center: mx.map((v, k) => (v + mn[k]) / 2) };
}

// The left/right axis and its centre, in the model's ground plane. ringAxes is
// [FB, LR]; the car export is Y-up and its LR axis is world X, the drone's is
// world Y — reading it from the ring keeps both right.
function lrAxisOf(g) {
  const ax = g?.ringAxes || [0, 1];
  const c = g?.ringCenter || g?.center || [0, 0];
  return { axis: ax[1] ?? 1, center: c[1] ?? 0 };
}

// ---- container predicate -----------------------------------------------------

export function isContainerNode(n, g, {
  bothSidesShare = CONTAINER_BOTH_SIDES_SHARE, diagShare = CONTAINER_DIAG_SHARE,
} = {}) {
  if (!n?.wb || !g) return false;
  const mb = modelBox(g);
  if (!mb) return false;
  const { axis, center } = lrAxisOf(g);
  // Both-sides BAND: substantial extent past the centreline on EACH side. An
  // arm/strut that only crosses the centre (big on one side, ~0 on the other)
  // is a legitimate part, not a band.
  const need = bothSidesShare * ((mb.span[axis] || 0) / 2);
  const leftExtent = center - n.wb.min[axis];
  const rightExtent = n.wb.max[axis] - center;
  if (need > 0 && leftExtent >= need && rightExtent >= need) return true;
  const diag = Math.hypot(
    n.wb.max[0] - n.wb.min[0], n.wb.max[1] - n.wb.min[1], n.wb.max[2] - n.wb.min[2],
  );
  const modelDiag = Math.hypot(mb.span[0], mb.span[1], mb.span[2]);
  return modelDiag > 0 && diag >= diagShare * modelDiag;
}

// +1 / -1 for the side a world point sits on, 0 when it is on the centreline.
export function sideSign(point, g) {
  if (!point || !g) return 0;
  const { axis, center } = lrAxisOf(g);
  const mb = modelBox(g);
  const tol = 0.02 * ((mb && mb.span[axis]) || 0);
  const d = point[axis] - center;
  if (Math.abs(d) <= tol) return 0;
  return d > 0 ? 1 : -1;
}

// ---- record geometry -----------------------------------------------------------

export function nameMap(g) {
  const by = new Map();
  for (const n of (g?.nodes || [])) if (n.name != null && !by.has(n.name)) by.set(n.name, n);
  return by;
}

export function recordCentroid(rec, byName) {
  const pts = (rec?.nodes || []).map((nm) => byName.get(String(nm))).filter((n) => n && (n.wb || n.wp)).map(placedPt);
  if (!pts.length) return null;
  const out = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k += 1) out[k] += p[k] / pts.length;
  return out;
}

export function scopeRadius(rec, byName) {
  const c = recordCentroid(rec, byName);
  if (!c) return 0;
  let r = 0;
  for (const nm of (rec?.nodes || [])) {
    const n = byName.get(String(nm));
    if (!n || !(n.wb || n.wp)) continue;
    const p = placedPt(n);
    r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  }
  return r;
}

// The slot a record occupies: its dictionary part at its quadrant. Two records
// with the same slot are two descriptions of ONE physical actuator and must
// merge; a machine with one record per slot has no duplicate doors.
export function slotKeyOf(rec, g, byName) {
  if (!rec?.part) return null;
  const c = recordCentroid(rec, byName);
  if (!c) return null;
  return `${rec.part}@${quadrantLabel(c, g)}`;
}

// Unclaimed nodes near a record's scope — the candidates the add-direction
// refine turn offers the vision model. Reach scales with the scope's own size,
// floored by a share of the model diagonal so a SMALL, INCOMPLETE scope (a door
// caught as glass only) still looks a typical part-width around itself instead
// of finding nothing. Only same-side neighbours are offered: a left door must
// never be handed the right door's panel.
export const NEIGHBOR_FLOOR_SHARE = 0.08;
export function neighborsOf(rec, g, byName = null, claimed = new Set(), { cap = 4, reachScale = 1.6, floorShare = NEIGHBOR_FLOOR_SHARE } = {}) {
  const by = byName || nameMap(g);
  const c = recordCentroid(rec, by);
  if (!c) return [];
  const mb = modelBox(g);
  const modelDiag = mb ? Math.hypot(mb.span[0], mb.span[1], mb.span[2]) : 0;
  const reach = Math.max(scopeRadius(rec, by) * reachScale, floorShare * modelDiag, 1e-6);
  const side = sideSign(c, g);
  const own = new Set((rec.nodes || []).map(String));
  const out = [];
  for (const n of (g?.nodes || [])) {
    if (!n.name || !(n.wb || n.wp)) continue;
    if (own.has(String(n.name)) || claimed.has(String(n.name))) continue;
    if (isContainerNode(n, g)) continue; // a container is never a missing member
    const p = placedPt(n);
    // Never offer a node on the opposite side of the machine to this scope.
    const ns = sideSign(p, g);
    if (side && ns && ns !== side) continue;
    const d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
    if (d <= reach) out.push({ name: n.name, d });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, cap).map((x) => x.name);
}

// ---- the reconcile pass ----------------------------------------------------------

const note = (rec, event, text) => {
  rec.history = [...(rec.history || []), { at: new Date().toISOString(), event, note: text }];
  rec.uncertainties = [...(rec.uncertainties || []), text];
};

// Step D alone, exported so the loop can re-assert exclusivity after the visual
// audit's add turn hands a neighbour to a record.
export function exclusivityPass(records, g, byName = nameMap(g)) {
  const changes = [];
  const owner = new Map(); // node name -> record that keeps it
  const cent = new Map(records.map((r) => [r, recordCentroid(r, byName)]));
  for (const rec of records) {
    for (const nm of (rec.nodes || []).map(String)) {
      const cur = owner.get(nm);
      if (!cur) { owner.set(nm, rec); continue; }
      const n = byName.get(nm);
      const p = n ? placedPt(n) : null;
      const dist = (r) => {
        const c = cent.get(r);
        if (!p || !c) return Infinity;
        return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
      };
      const keep = dist(rec) < dist(cur) ? rec : cur;
      const lose = keep === rec ? cur : rec;
      owner.set(nm, keep);
      lose.nodes = (lose.nodes || []).filter((x) => String(x) !== nm);
      const text = `exclusivity: ${nm} is owned by ${keep.id} (its scope centre is nearer the node) — removed from this record`;
      note(lose, 'scope-exclusivity', text);
      changes.push({ kind: 'exclusivity', node: nm, kept: keep.id, droppedFrom: lose.id });
    }
  }
  return { records: records.filter((r) => (r.nodes || []).length), changes };
}

export function reconcileSlots(records, g, opts = {}) {
  const byName = opts.byName || nameMap(g);
  const warnings = [];
  const changes = [];
  const recs = (records || []).map((r) => ({ ...r, nodes: [...(r.nodes || [])] }));

  // A. containers never belong to a joint scope -------------------------------
  //
  // A GOOD scope that picked up a stray shell node (headlight bar on a wheel,
  // interior on a door) is REFINED: the few containers are dropped and the real
  // members stay. But a scope that is MOSTLY container — a whole-machine grab
  // that swallowed the shell plus a few incidental nodes — is not a part with a
  // blemish, it is a bad grounding. Stripping its containers would rescue it
  // into a small plausible-looking remnant that slips under the battery's
  // spread ruler, so we LEAVE it intact and let the battery reject the grab the
  // same way it always has. A record that is ENTIRELY container has no remnant
  // to rescue, so it is dropped and falls out empty.
  for (const rec of recs) {
    const bad = rec.nodes.filter((nm) => isContainerNode(byName.get(String(nm)), g));
    if (!bad.length) continue;
    const shellDominated = bad.length > rec.nodes.length * SHELL_DOMINANT_SHARE && bad.length < rec.nodes.length;
    if (shellDominated) {
      const text = `scope reconcile: ${bad.length} of ${rec.nodes.length} nodes are machine-shell containers — this ${rec.part || rec.type} scope is a whole-machine grab, not a part; left intact for the battery to reject`;
      note(rec, 'shell-grab', text);
      warnings.push(`${rec.id}: ${text}`);
      changes.push({ kind: 'shell-grab', record: rec.id, containers: bad });
      continue;
    }
    rec.nodes = rec.nodes.filter((nm) => !bad.includes(nm));
    const text = `scope reconcile: dropped ${bad.join(', ')} — a single node spanning both sides / the whole machine is a container, not a member of the ${rec.part || rec.type}`;
    note(rec, 'scope-reconcile', text);
    warnings.push(`${rec.id}: ${text}`);
    changes.push({ kind: 'container', record: rec.id, dropped: bad });
  }

  // B. one record per slot: same part at the same quadrant merges, but only
  //    when the two scopes also physically touch (a quadrant is coarse) -------
  const bySlot = new Map();
  for (const rec of recs) {
    const key = slotKeyOf(rec, g, byName);
    if (!key) continue;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(rec);
  }
  const dead = new Set();
  const touches = (a, b) => {
    const ca = recordCentroid(a, byName); const cb = recordCentroid(b, byName);
    if (!ca || !cb) return false;
    const d = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
    // Geometric mean of the two radii: both scopes must be substantial AND
    // close. A monster beside a near-point neighbour has mean ~0 -> no merge.
    const reach = SLOT_MERGE_REACH * Math.sqrt(scopeRadius(a, byName) * scopeRadius(b, byName));
    return d <= reach;
  };
  for (const [key, group] of bySlot) {
    if (group.length < 2) continue;
    // Greedy: highest confidence anchors first; a later record joins the first
    // anchor it touches, else becomes its own anchor (a distinct actuator that
    // merely shares the coarse quadrant).
    const ordered = [...group].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const anchors = [];
    for (const rec of ordered) {
      const host = anchors.find((a) => touches(a, rec));
      if (!host) { anchors.push(rec); continue; }
      const added = rec.nodes.filter((nm) => !host.nodes.includes(nm));
      host.nodes = [...host.nodes, ...added];
      host.evidence = [...new Set([...(host.evidence || []), ...(rec.evidence || [])])];
      host.uncertainties = [...(host.uncertainties || []), ...(rec.uncertainties || [])];
      host.history = [...(host.history || []), ...(rec.history || [])];
      dead.add(rec);
      const text = `scope reconcile: merged ${rec.id} into this record — both describe the ${key.replace('@', ' at ')} slot at the same place`;
      note(host, 'slot-merge', text);
      warnings.push(`${host.id}: ${text}`);
      changes.push({ kind: 'slot-merge', slot: key, kept: host.id, merged: rec.id, added });
    }
  }
  let live = recs.filter((r) => !dead.has(r));

  // C. a side-scoped part owns one side: shed the other side's nodes ----------
  for (const rec of live) {
    if (!rec.part || rec.nodes.length < 2) continue;
    const signs = rec.nodes.map((nm) => {
      const n = byName.get(String(nm));
      return n ? sideSign(placedPt(n), g) : 0;
    });
    const tally = new Map();
    signs.forEach((s) => { if (s) tally.set(s, (tally.get(s) || 0) + 1); });
    if (!tally.size) continue;
    const majority = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const wrong = rec.nodes.filter((nm, i) => signs[i] !== 0 && signs[i] !== majority);
    if (!wrong.length) continue;
    // Offer them to the same part on their own side first: a right-door slab
    // shed by the left door is the right door's member if a right door exists.
    const home = new Map();
    for (const nm of wrong) {
      const s = sideSign(placedPt(byName.get(String(nm))), g);
      const target = live.find((o) => o !== rec && o.part === rec.part
        && o.nodes.length && sideSign(recordCentroid(o, byName), g) === s);
      home.set(nm, target || null);
    }
    rec.nodes = rec.nodes.filter((nm) => !wrong.includes(nm));
    for (const [nm, target] of home) {
      if (target && !target.nodes.includes(nm)) target.nodes = [...target.nodes, nm];
    }
    const moved = wrong.filter((nm) => home.get(nm));
    const text = `scope reconcile: ${wrong.join(', ')} sit on the other side of the machine than this ${rec.part}${moved.length ? ` — moved to ${[...new Set(moved.map((nm) => home.get(nm).id))].join(', ')}` : ' — dropped'}`;
    note(rec, 'side-split', text);
    warnings.push(`${rec.id}: ${text}`);
    changes.push({ kind: 'side-split', record: rec.id, moved, dropped: wrong.filter((nm) => !moved.includes(nm)) });
  }

  // D. a node belongs to exactly one joint ------------------------------------
  const ex = exclusivityPass(live, g, byName);
  live = ex.records;
  changes.push(...ex.changes);
  for (const c of ex.changes) warnings.push(`exclusivity: ${c.node} kept by ${c.kept}, removed from ${c.droppedFrom}`);

  return { records: live, warnings, changes };
}

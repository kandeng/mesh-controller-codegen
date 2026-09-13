// Staged-discovery proof — the answer to "can the one-shot post-load job be split
// so the assistant serves queued user requests before it finishes, without the
// joint list lying about what has actually been checked?"
//
// The design under test, in the order the machine runs it:
//
//   stage 0  the geometry pass ADMITS its records and defers the battery
//            (runDiscoveryLoop(..., { score: false })) — every record is a
//            `candidate`, which is the status the UI reads as "listed, dimmed,
//            NOT clickable".
//   stage 1  ONE proposals-only vision look (stopAfter:'proposals') unions with
//            those candidates through the overlap merge (reconcileLanes) and lands
//            unscored (admitCandidates). Nothing is measured before its boundary.
//   boundary the orchestrator yields to the assistant queue, then RE-READS the
//            live list — so a served request can reshape what is left to do.
//   stage 2  one joint at a time: refineJoint runs the battery + reuses the vision
//            grounding, publishes the result to the SERVED joint object, and that
//            row becomes clickable. Another boundary follows each one.
//
// Legs, exit 0 only if all hold:
//   S1) score:false admits candidates and measures nothing; score:true is the only
//       other behaviour, so the seam is exactly one flag
//   S2) stopAfter:'proposals' looks, grounds, reports — and merges NOTHING, in ONE
//       round even when more were asked for
//   S3) the stage-1 union: an overlapping claim becomes corroboration of ONE
//       candidate (never a duplicate, never a confidence lift), a disjoint claim
//       becomes a new candidate, and everything is still unscored on the wire
//   S4) refineJoint settles ONE joint, publishes it to the served object the wire
//       reads, attaches the reused grounding, and leaves every other candidate
//       exactly as it was
//   S5) the stage-2 loop is a LIVE-LIST walk: a boundary fires between joints, a
//       drop removes an upcoming candidate, a postpone reorders, and an abort keeps
//       what was refined and leaves the rest candidates
//   S6) /discovery is registered, documented, and its verbs reach the kernel hooks
//   S7) agent.idle() resolves immediately on an empty queue — a boundary yield must
//       never park discovery when nobody is waiting to be served
//   S8) a STEERED SECOND LOOK: what the human typed while stage 1 was in flight is
//       recovered from the transcript, folded into one more proposals-only look as
//       words AND pictures, still cannot bypass the grounding gate, and unions into
//       the candidate list without invalidating it
//   S9) STOP IS ONE VERB: the red button and /stop reach all four things that can be
//       running — discovery, generation, the model turn in flight, and the QUEUE,
//       whose remaining user requests are removed rather than served later
//
// Usage: node test/verify-stages.mjs
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGlb } from '../src/lib/gltf.mjs';
import { geometryDiscovery } from '../src/plugins/discovery/geometry.mjs';
import { claimedNodeSet } from '../src/plugins/discovery/manifest.mjs';
import { planViews, renderTargets, nodeBox, namedIndex } from '../src/plugins/discovery/views.mjs';
import { frameKey } from '../src/plugins/discovery/observations.mjs';
import { isExpectationPrompt } from '../src/plugins/discovery/expectation.mjs';
import {
  admitCandidates, refineJoint, reconcileLanes, runDiscoveryLoop, runVisionCampaign,
} from '../src/plugins/discovery/loop.mjs';
// Importing the server headlessly is safe: slash-commands.mjs has no imports at
// all, routes/project.mjs pulls in only slots.mjs -> src/core/registry.mjs, and
// dsh-agent.mjs boots its child process lazily (never at construction). Same for
// dsh-bridge.mjs: it spawns only inside run(), which S9 drives with a stand-in.
import { findCommand, helpText, parseSlash, slashSection, stopEverything } from '../server/slash-commands.mjs';
import { jointSummary } from '../server/routes/project.mjs';
import { createDshAgent, DROPPED_MSG } from '../server/dsh-agent.mjs';
import { userGuidanceSince } from '../server/session-store.mjs';
import { buildVisionPrompt } from '../src/plugins/discovery/vision-prompt.mjs';
import { dshBridge } from '../src/bridges/dsh-bridge.mjs';

const GLB = 'samples/drone_dji_inspire3.glb';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}${extra ? ' \u2014 ' + extra : ''}`); } else { fail += 1; console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
};
const J = (o) => JSON.stringify(o);
const clone = (joints) => joints.map((j) => ({ ...j, nodes: [...(j.nodes || [])] }));
const candidatesOf = (m) => (m || []).filter((r) => r.status === 'candidate');
// A one-frame PNG and the planner's own view list: the same fakes verify-vision
// uses, so a proposal here grounds through the real gate rather than a stub of it.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const hexOf = (i) => `#${(((i + 1) * 2654435761) % 0xffffff).toString(16).padStart(6, '0')}`;

console.log('\nProving staged discovery + the queue boundaries\n');

const g = await parseGlb(GLB);
const bigPlan = planViews(g, { maxViews: 8, allowGhost: true, ghostViews: 2 });

// ---- S1) the score:false seam ------------------------------------------------
// This is the whole of stage 0. If the geometry pass scored its records here, the
// list would arrive already clickable and stage 2 would have nothing to do — the
// staging would be cosmetic.
const raw = await geometryDiscovery.api.discover(GLB, null);
const joints0 = raw.joints;
const geo = runDiscoveryLoop(g, joints0, { score: false });
{
  ok('S1: the geometry pass admits records with the battery deferred',
    geo.manifest.length > 0 && geo.manifest.every((r) => r.status === 'candidate'),
    `${geo.manifest.length} records, statuses ${J([...new Set(geo.manifest.map((r) => r.status))])}`);
  ok('S1: nothing was measured, so no record carries a battery result',
    geo.manifest.every((r) => (r.tests || []).length === 0),
    J(geo.manifest.map((r) => (r.tests || []).length)));
  ok('S1: the SERVED joint objects say candidate too — /api/joints reads those, not the manifest',
    joints0.length === geo.manifest.length && joints0.every((j) => j.status === 'candidate')
      && joints0.every((j) => jointSummary(j).status === 'candidate'),
    `${joints0.length} served joints`);
  ok('S1: the default is unchanged — score:true is the only other behaviour',
    (() => {
      const j2 = clone(raw.joints);
      const scored = runDiscoveryLoop(g, j2, {});
      return scored.manifest.length === geo.manifest.length
        && scored.manifest.some((r) => r.status !== 'candidate')
        && scored.manifest.every((r) => (r.tests || []).length > 0);
    })(), 'same records, battery run, statuses derived');
}

// ---- S2) the proposals-only vision look --------------------------------------
// One frame, one turn, one grounded proposal — and provably NO merge. The point of
// the seam is that stage 1 owns the admission, so a look that merged on its own
// would score a joint before its boundary.
const claimed = claimedNodeSet(geo.manifest);
// The node the fake model points at MUST come from the population grounding
// resolves against: renderTargets() with a placed box. A node carrying only a
// world extent (a group, a wrapper, the scene root) grounds by colour and then
// dies in the gate with "anchor must be [x,y,z]" — cloudAnchor() has no box to
// centroid, and a proposal without an anchor is not a proposal. Selecting from
// the same list the producer uses is what keeps this fixture a test of the seam
// rather than a test of whether I guessed a good node name.
const namedIdx = namedIndex(g);
const freeName = renderTargets(g)
  .filter((n) => nodeBox(n))
  .map((n) => namedIdx.get(n.i) || n.name)
  .find((nm) => nm && !claimed.has(nm));
const pv = bigPlan.views.find((v) => Array.isArray(v.sees) && v.sees.length) || bigPlan.views[0];
ok('setup: there is a node the geometry pass never claimed, to propose from pixels',
  !!freeName, `${freeName || 'none'} / view ${pv?.id}`);

function fakes(replyOf) {
  const state = { plan: 0, capture: 0, propose: 0, saved: {} };
  return {
    state,
    plan: () => { state.plan += 1; return bigPlan; },
    capture: async (view, mode, focusNodes) => {
      state.capture += 1;
      const colorMap = {};
      if (mode === 'colorId') (focusNodes || []).forEach((nm, i) => { colorMap[hexOf(i)] = nm; });
      return {
        id: frameKey(view.id, mode), viewId: view.id, mode, pose: view.pose, spec: view.spec,
        covers: view.covers, sees: view.sees, focus: focusNodes, mediaType: 'image/png',
        dataBase64: PNG, colorMap: mode === 'colorId' ? colorMap : null,
      };
    },
    propose: async (text) => {
      if (isExpectationPrompt(text)) return { reply: '{}', model: 'fake-vlm', ms: 1, mode: 'live' };
      state.propose += 1;
      const m = text.match(/LEGEND for "([^"]+)":\s*(#[0-9a-f]{6})=(\S+)/);
      return {
        reply: replyOf(m ? { frameId: m[1], color: m[2], name: m[3] } : null),
        model: 'fake-vlm', ms: 2, mode: 'live',
      };
    },
    persist: (r = 0) => {
      state.saved[r] = state.saved[r] || { proposals: 0, reply: 0 };
      return {
        plan: () => {}, frame: () => {},
        reply: () => { state.saved[r].reply += 1; },
        proposals: () => { state.saved[r].proposals += 1; },
        expectation: () => {},
      };
    },
  };
}

// A preset frame with a ONE-entry legend: the proposal is then deterministic,
// because there is exactly one colour the reply can point at and it maps to a node
// nothing else has claimed.
const preset = [{
  id: frameKey(pv.id, 'colorId'), viewId: pv.id, mode: 'colorId', pose: pv.pose, spec: pv.spec,
  covers: 1, sees: [freeName], focus: [freeName], mediaType: 'image/png', dataBase64: PNG,
  colorMap: { [hexOf(0)]: freeName },
}];
const replyOne = (loc) => (loc ? J([{
  op: 'new', type: 'hinge', frameId: loc.frameId, regionColors: [loc.color], axis: [0, 0, 1],
  reasoning: 'a hinge the node hierarchy never named', uncertainties: ['its extent is unclear'],
}]) : '[]');

const laneM = clone(geo.manifest).map((r) => ({ ...r, history: [...(r.history || [])] }));
const laneJ = clone(joints0);
const f1 = fakes(replyOne);
const vision = await runVisionCampaign(g, laneJ, laneM, {
  plan: f1.plan, capture: f1.capture, propose: f1.propose, persist: f1.persist,
  frames: preset, rounds: 2, extraViews: 2, expectation: false, independent: true,
  stopAfter: 'proposals',
});
{
  ok('S2: a proposals-only campaign reports that it stopped before the merge',
    vision.ok === true && vision.stopped === 'proposals' && /stopped after the proposals/.test(vision.stop || ''),
    `${vision.stopped} — ${vision.stop}`);
  ok('S2: it merges NOTHING and says the manifest is untouched',
    vision.added === 0 && vision.manifestUntouched === true
      && laneM.length === geo.manifest.length && laneJ.length === joints0.length,
    `added=${vision.added} manifest=${laneM.length} joints=${laneJ.length}`);
  ok('S2: it is ONE look — asking for 2 rounds still buys 1, because round 2 exists to chase a merge that never happened',
    vision.roundCount === 1 && vision.maxRounds === 1 && f1.state.propose === 1,
    `${vision.roundCount} round(s), ${f1.state.propose} model turn(s)`);
  ok('S2: the proposals it hands back are RECORD OBJECTS, not the ids a merged round reports',
    vision.proposals.length === 1 && Array.isArray(vision.proposals[0]?.nodes)
      && vision.proposals[0].status === 'candidate',
    vision.proposals.length
      ? J(vision.proposals.map((p) => ({ id: p.id, nodes: (p.nodes || []).length, status: p.status })))
      // Nothing to report means the gate dropped it; the reason is a warning.
      : `dropped — ${J((vision.warnings || []).filter((w) => /dropped/.test(w)))}`);
  ok('S2: the grounding it computed travels with them, so stage 2 can REUSE it instead of re-grounding',
    vision.grounded.length === 1 && Array.isArray(vision.grounded[0]?.names)
      && vision.grounded[0].names.includes(freeName) && !!vision.grounded[0].grounding,
    J(vision.grounded.map((x) => ({ names: x.names, src: x.grounding?.source }))));
  ok('S2: it persisted the round\'s proposals — the evidence trail survives the deferred merge',
    f1.state.saved[0]?.proposals === 1 && f1.state.saved[0]?.reply === 1,
    J(f1.state.saved[0]));
  ok('S2: a preset frame list replays the look with no renderer touched',
    f1.state.capture === 0 && f1.state.plan >= 1 && vision.frames >= 1,
    `captures=${f1.state.capture} frames=${vision.frames}`);
}

// A look that really does capture, to prove the seam is not an artefact of the
// replay path: frames are spent, nothing is merged either way.
{
  const laneM2 = clone(geo.manifest).map((r) => ({ ...r, history: [...(r.history || [])] }));
  const laneJ2 = clone(joints0);
  const f2 = fakes(replyOne);
  const cap = await runVisionCampaign(g, laneJ2, laneM2, {
    plan: f2.plan, capture: f2.capture, propose: f2.propose, persist: f2.persist,
    rounds: 1, expectation: false, independent: true, stopAfter: 'proposals',
  });
  ok('S2: a capturing proposals-only look spends frames and still merges nothing',
    cap.ok === true && cap.stopped === 'proposals' && cap.frames > 0 && f2.state.capture > 0
      && cap.manifestUntouched === true && laneM2.length === geo.manifest.length,
    `${cap.frames} frames from ${f2.state.capture} captures, added=${cap.added}`);
}

// ---- S3) the stage-1 union ---------------------------------------------------
// The two producers must agree on ONE candidate list. A part both found is
// corroboration of one joint, never a duplicate; a part only one found coexists.
// And nothing is scored, because scoring before the boundary is what would make
// the dimmed rows a lie.
const stageM = clone(geo.manifest).map((r) => ({ ...r, history: [...(r.history || [])] }));
const stageJ = clone(joints0);
const target = stageM[0];
const confBefore = target.confidence;
const overlapRec = {
  id: 'overlap_probe', label: 'overlap probe', type: target.type,
  nodes: target.nodes.slice(0, Math.max(1, Math.ceil(target.nodes.length / 2))),
  anchor: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, evidence: [],
  confidence: 0.7, origin: 'L2-vision', tests: [], status: 'candidate', history: [],
};
const reconciled = reconcileLanes(stageM, {
  records: [...vision.proposals.map((p) => ({ ...p, history: [...(p.history || [])] })), overlapRec],
  confirms: [...(vision.confirmList || [])],
}, { origin: 'L2-vision', tag: 'cross-producer:L2-vision' });
const admitted = admitCandidates(stageJ, stageM, reconciled);
{
  ok('S3: a claim inside an existing candidate becomes CORROBORATION of it, not a second record',
    reconciled.agreed.length === 1 && reconciled.agreed[0].id === target.id
      && reconciled.agreed[0].match === 'overlap' && reconciled.agreed[0].discardedId === 'overlap_probe'
      && !stageM.some((r) => r.id === 'overlap_probe'),
    J(reconciled.agreed.map((a) => ({ id: a.id, match: a.match, shared: a.shared }))));
  ok('S3: corroboration is EVIDENCE only — it must not lift confidence before the boundary',
    target.evidence.includes('cross-producer:L2-vision') && target.confidence === confBefore,
    `conf ${confBefore} -> ${target.confidence}, evidence ${J(target.evidence)}`);
  ok('S3: a disjoint claim from pixels is admitted as its own candidate',
    admitted.added === vision.proposals.length && admitted.added >= 1
      && stageM.some((r) => r.id === vision.proposals[0].id),
    `+${admitted.added} of ${vision.proposals.length} proposed`);
  ok('S3: the served list and the manifest stay the same length, in the same order',
    stageJ.length === stageM.length
      && stageJ.every((j, i) => j.id === stageM[i].id),
    `${stageJ.length} joints / ${stageM.length} records`);
  ok('S3: EVERY record is still an unscored candidate — the wire says "listed, not clickable"',
    candidatesOf(stageM).length === stageM.length
      && stageM.every((r) => (r.tests || []).length === 0)
      && stageJ.every((j) => jointSummary(j).status === 'candidate'),
    `${candidatesOf(stageM).length}/${stageM.length} candidates`);
  ok('S3: the vision-sourced candidate keeps what the model said and what it was unsure about',
    (() => {
      const wire = jointSummary(stageJ.find((j) => j.id === vision.proposals[0].id));
      return wire.origin === 'L2-vision' && wire.reasoning === 'a hinge the node hierarchy never named'
        && (wire.uncertainties || []).includes('its extent is unclear');
    })(), J(jointSummary(stageJ.find((j) => j.id === vision.proposals[0].id)).uncertainties));
}

// ---- S4) stage 2 settles ONE joint ------------------------------------------
// The load-bearing assertion is the fourth one: /api/joints serves `joints`, not
// the manifest, so a measurement that never reaches the served object leaves the
// row a candidate on the wire forever — dimmed and unclickable no matter what the
// battery concluded.
{
  const rec = stageM.find((r) => r.id === target.id);
  const served = stageJ.find((j) => j.id === target.id);
  const grounded = vision.grounded[0];
  const beats = [];
  const out = refineJoint(g, stageJ, rec, {
    grounded: grounded ? {
      source: grounded.grounding?.source || null,
      agreement: grounded.grounding || null,
      frameId: grounded.frameId ?? grounded.id ?? null,
      uncertainties: grounded.uncertainties || [],
    } : null,
    emit: (k, p) => beats.push([k, p]),
  });
  ok('S4: refineJoint settles the record and physics alone disposes the confidence',
    out.ok === true && out.status !== 'candidate' && [0.7, 0.75, 0.8].includes(out.confidence),
    `${out.status} conf=${out.confidence}`);
  ok('S4: the battery really ran over this record (isolation holds against the whole list)',
    rec.tests.some((t) => t.name === 'isolation' && t.pass === true) && rec.tests.length > 0,
    J(rec.tests.map((t) => `${t.pass ? '✓' : '✗'}${t.name}`)));
  ok('S4: the reused grounding became evidence + a doubt a human can read',
    rec.evidence.some((e) => String(e).startsWith('vision-grounding:'))
      && !!rec.grounding && (rec.uncertainties || []).includes('its extent is unclear'),
    J({ grounding: rec.grounding, unsure: rec.uncertainties }));
  ok('S4: the measurement reached the SERVED object — the row becomes clickable on the wire',
    served.status === rec.status && served.confidence === rec.confidence
      && served.tests === rec.tests && jointSummary(served).status !== 'candidate',
    `served=${served.status} conf=${served.confidence}`);
  ok('S4: it said so, once, naming the joint and the status it earned',
    beats.length === 1 && beats[0][0] === 'joint:refined' && beats[0][1].id === rec.id
      && beats[0][1].status === rec.status, J(beats));
  ok('S4: every OTHER candidate is untouched — one boundary settles exactly one joint',
    candidatesOf(stageM).length === stageM.length - 1
      && stageJ.filter((j) => j.status === 'candidate').length === stageM.length - 1
      && stageM.filter((r) => r.id !== rec.id).every((r) => (r.tests || []).length === 0),
    `${candidatesOf(stageM).length} still candidate of ${stageM.length}`);
  ok('S4: re-running it REPLACES the battery result rather than stacking a second one',
    (() => {
      const again = refineJoint(g, stageJ, rec, {});
      return again.ok === true
        && rec.tests.filter((t) => t.name === 'isolation').length === 1
        && again.status === rec.status;
    })(), `${rec.tests.filter((t) => t.name === 'isolation').length} isolation entry(ies)`);
  ok('S4: a missing record is refused rather than thrown',
    refineJoint(g, stageJ, null, {}).ok === false);
}

// ---- S5) the stage-2 loop is a live-list walk --------------------------------
// Mirrors kernel-host's stage-2 loop exactly: pick the first candidate, measure it,
// commit, then yield. The yield is where a served request lands, and because the
// next iteration re-reads the LIVE array, that request genuinely reshapes the plan.
const hooks = {
  // Same semantics as kernel.dropCandidate: a refined joint is belief, not plan, so
  // it refuses; a candidate leaves BOTH arrays or isolation would see a ghost.
  drop(manifest, joints, id) {
    const rec = manifest.find((r) => r.id === id || r.label === id);
    if (!rec) return { ok: false, code: 'NO_SUCH_JOINT' };
    if (rec.status !== 'candidate') return { ok: false, code: 'ALREADY_REFINED' };
    const i = manifest.indexOf(rec);
    manifest.splice(i, 1);
    const j = joints.findIndex((x) => x.id === rec.id);
    if (j >= 0) joints.splice(j, 1);
    return { ok: true, dropped: rec.id, remaining: candidatesOf(manifest).length };
  },
  // Same semantics as kernel.postponeCandidate: to the end of BOTH arrays.
  postpone(manifest, joints, id) {
    const rec = manifest.find((r) => r.id === id || r.label === id);
    if (!rec) return { ok: false, code: 'NO_SUCH_JOINT' };
    if (rec.status !== 'candidate') return { ok: false, code: 'ALREADY_REFINED' };
    manifest.splice(manifest.indexOf(rec), 1); manifest.push(rec);
    const jn = joints.find((x) => x.id === rec.id);
    const ji = joints.indexOf(jn);
    if (ji >= 0) { joints.splice(ji, 1); joints.push(jn); }
    return { ok: true, postponed: rec.id };
  },
};

async function stageTwo(manifest, joints, { onBoundary = null, abort = () => false } = {}) {
  const refined = [];
  const boundaries = [];
  while (!abort()) {
    const next = manifest.find((r) => r.status === 'candidate');
    if (!next) break;
    refineJoint(g, joints, next, {});
    refined.push(next.id);
    boundaries.push(next.id);
    if (onBoundary) await onBoundary({ refined: [...refined], remaining: candidatesOf(manifest).length, manifest, joints });
  }
  return { refined, boundaries };
}

const freshStage = () => {
  const j = clone(raw.joints);
  const m = runDiscoveryLoop(g, j, { score: false }).manifest.map((r) => ({ ...r, history: [...(r.history || [])] }));
  return { m, j };
};
{
  const { m, j } = freshStage();
  const total = m.length;
  ok('setup: the geometry pass yields enough candidates to walk', total >= 3, `${total} candidates`);

  // (a) a boundary fires AFTER every joint, and never before the first
  const order = [];
  const plain = await stageTwo(m, j, {
    onBoundary: ({ refined }) => { order.push([...refined]); },
  });
  ok('S5: one boundary per refined joint, in order, each seeing everything before it',
    order.length === total && plain.refined.length === total
      && order.every((seen, i) => seen.length === i + 1)
      && order[order.length - 1].join() === plain.refined.join(),
    `${order.length} boundaries for ${total} joints`);
  ok('S5: the walk ends because the list emptied, leaving nothing a candidate',
    candidatesOf(m).length === 0 && j.every((x) => x.status !== 'candidate'),
    `${candidatesOf(m).length} left`);

  // (b) a DROP served at a boundary removes an UPCOMING candidate for good
  const d = freshStage();
  const victim = d.m[2].id;
  let dropped = null;
  const withDrop = await stageTwo(d.m, d.j, {
    onBoundary: ({ refined }) => {
      if (refined.length === 1 && !dropped) dropped = hooks.drop(d.m, d.j, victim);
    },
  });
  ok('S5: a request served at a boundary reshapes what is left — the dropped joint is never measured',
    dropped?.ok === true && !withDrop.refined.includes(victim)
      && withDrop.refined.length === d.m.length
      && !d.m.some((r) => r.id === victim) && !d.j.some((x) => x.id === victim),
    `dropped=${dropped?.dropped} refined=${withDrop.refined.length}, victim present=${d.m.some((r) => r.id === victim)}`);

  // (c) a POSTPONE moves an UPCOMING candidate to the end of the plan. Index 1, not
  // 0: the first candidate is already measured before the first boundary exists, so
  // postponing it would be postponing the past — the request this hook serves is
  // always about work that has not happened yet.
  const p = freshStage();
  const total2 = p.m.length;
  const late = p.m[1].id;
  let postponed = null;
  const withPost = await stageTwo(p.m, p.j, {
    onBoundary: ({ refined }) => { if (refined.length === 1 && !postponed) postponed = hooks.postpone(p.m, p.j, late); },
  });
  ok('S5: a postponed candidate is refined LAST, not skipped',
    postponed?.ok === true && withPost.refined.includes(late)
      && withPost.refined.length === total2
      && withPost.refined[withPost.refined.length - 1] === late
      && p.m[p.m.length - 1].id === late,
    `postponed=${postponed?.postponed} order ${J(withPost.refined)}`);

  // (d) a refined joint is belief, not plan: both hooks refuse it
  const r = freshStage();
  await stageTwo(r.m, r.j, { onBoundary: ({ refined }) => { if (refined.length === 1) { r.stop = refined[0]; } } });
  const settled = r.stop;
  ok('S5: a settled joint refuses both hooks and says why',
    hooks.drop(r.m, r.j, settled).code === 'ALREADY_REFINED'
      && hooks.postpone(r.m, r.j, settled).code === 'ALREADY_REFINED'
      && hooks.drop(r.m, r.j, 'no_such_joint').code === 'NO_SUCH_JOINT',
    `${settled} refused`);

  // (e) an ABORT keeps what was refined and leaves the rest candidates
  const a = freshStage();
  const totalA = a.m.length;
  let n = 0;
  const withAbort = await stageTwo(a.m, a.j, {
    onBoundary: () => { n += 1; },
    abort: () => n >= 2,
  });
  ok('S5: stopping at a boundary is "no further joints", never a rollback',
    withAbort.refined.length === 2
      && withAbort.refined.every((id) => a.m.find((r) => r.id === id).status !== 'candidate')
      && candidatesOf(a.m).length === totalA - 2
      && a.j.filter((x) => x.status === 'candidate').length === totalA - 2,
    `${withAbort.refined.length} kept, ${candidatesOf(a.m).length} still candidate of ${totalA}`);
  ok('S5: the stopped list is honest on the wire — refined rows clickable, the rest dimmed',
    a.j.filter((x) => jointSummary(x).status !== 'candidate').length === 2
      && a.j.filter((x) => jointSummary(x).status === 'candidate').length === totalA - 2,
    J(a.j.map((x) => jointSummary(x).status)));
}

// ---- S6) /discovery reaches the kernel hooks ---------------------------------
{
  const cmd = findCommand('discovery');
  const parsed = parseSlash('/discovery drop rotor_vis_4');
  ok('S6: /discovery is registered, takes args, and parses',
    !!cmd && cmd.takesArgs === true && parsed?.name === 'discovery' && parsed?.args === 'drop rotor_vis_4',
    J(parsed));
  ok('S6: it is documented where the persona and /help read from',
    helpText().includes('/discovery') && slashSection().includes('/discovery'),
    'helpText + slashSection');

  // ONE context object, exactly as routes/agent.mjs calls it.
  const calls = [];
  const kernel = {
    current: { manifest: [{ id: 'a', status: 'candidate' }, { id: 'b', status: 'auto-accepted' }] },
    abortRefine: () => { calls.push(['stop']); return { ok: true }; },
    dropCandidate: (id) => { calls.push(['drop', id]); return { ok: true, dropped: id, remaining: 0 }; },
    postponeCandidate: (id) => { calls.push(['postpone', id]); return { ok: true, postponed: id }; },
  };
  const run = (args) => cmd.run({ kernel, agent: null, args });
  const status = run('status');
  ok('S6: status reads the LIVE manifest and separates plan from belief',
    /1 candidate/.test(status) && status.includes('a') && /b:auto-accepted/.test(status), status);
  const stopped = run('stop');
  const droppedMsg = run('drop rotor_vis_4');
  const postponedMsg = run('postpone gimbal_x');
  ok('S6: stop, drop and postpone each reach their own kernel hook, with the id intact',
    stopped.includes('next boundary') && droppedMsg.includes('Dropped rotor_vis_4')
      && postponedMsg.includes('Postponed gimbal_x')
      && J(calls) === J([['stop'], ['drop', 'rotor_vis_4'], ['postpone', 'gimbal_x']]),
    J(calls));
  ok('S6: a verb with no id, and an unknown verb, are refused with their usage',
    /^Usage: \/discovery drop/.test(run('drop')) && /Unknown \/discovery verb/.test(run('sideways'))
      && calls.length === 3,
    `${run('drop')} | ${run('sideways')}`);
  ok('S6: a kernel without the hooks degrades to a sentence, not a throw',
    /not available on this kernel/.test(cmd.run({ kernel: { current: { manifest: [] } }, args: 'drop x' })),
    cmd.run({ kernel: { current: { manifest: [] } }, args: 'drop x' }));
}

// ---- S7) the boundary yield must not park an idle queue ---------------------
{
  const agent = createDshAgent({ config: {}, diagnostics: { note() {} } });
  ok('S7: the supervisor exposes idle() beside isBusy/queueDepth',
    typeof agent.idle === 'function' && typeof agent.isBusy === 'function'
      && typeof agent.queueDepth === 'function' && agent.isBusy() === false && agent.queueDepth() === 0);
  const t0 = Date.now();
  await agent.idle();
  const ms = Date.now() - t0;
  ok('S7: idle() resolves at once when nothing is queued — a boundary costs nothing when nobody is waiting',
    ms < 250, `${ms}ms`);
  await agent.dispose?.();
}

// ---- S8) the steered second look ---------------------------------------------
// The question this leg answers: a human sends a message WITH A SCREENSHOT while
// stage 1 is still detecting. Does it reach the detection? Stage 1 is one composed
// turn — the prompt is already gone — and stage 2 has no model turn at all, so the
// only honest place to fold it in is the boundary BETWEEN them, and only when there
// is something to fold. Each seam below is proven separately, then the order they
// are wired in.
{
  // (a) Recovering "what did you say while I was working" is a pure filter over the
  // transcript's monotonic seq — no clock, and no mistaking a message sent BEFORE
  // the run for steering of it.
  const tr = [
    { role: 'user', seq: 1, text: 'load this please', ts: 1 },
    { role: 'assistant', seq: 2, text: 'loaded', ts: 2 },
    { role: 'user', seq: 3, text: 'the tail boom folds - look at the rear arm', ts: 3, attachments: [{ id: 'att-1', url: '/x' }] },
    { role: 'user', seq: 4, text: '/discovery status', ts: 4 },
    { role: 'user', seq: 5, text: '   ', ts: 5 },
    { role: 'system', seq: 6, text: 'queued as #1', ts: 6 },
    { role: 'user', seq: 7, text: 'and the gimbal is a two-axis, not three', ts: 7 },
  ];
  const g8 = userGuidanceSince(tr, 2);
  ok('S8: guidance is what the USER said ABOVE the watermark — assistant and system entries are not instructions',
    g8.length === 2 && g8.map((x) => x.seq).join(',') === '3,7', J(g8.map((x) => ({ seq: x.seq, text: x.text.slice(0, 24) }))));
  ok('S8: a slash command is excluded — it is STRUCTURAL, already applied deterministically, and re-feeding it to a model would ask for a thing already done',
    !g8.some((x) => x.text.startsWith('/')) && userGuidanceSince(tr, 3).length === 1,
    `from seq 3 -> ${J(userGuidanceSince(tr, 3).map((x) => x.text))}`);
  ok('S8: an empty message is excluded, and the screenshot rides along with the words it was sent with',
    !g8.some((x) => !x.text.trim()) && J(g8[0].attachments) === J(['att-1']) && J(g8[1].attachments) === J([]),
    J(g8.map((x) => x.attachments)));
  ok('S8: nothing above the watermark means no second look at all — an idle run pays nothing',
    userGuidanceSince(tr, 7).length === 0 && userGuidanceSince([], 0).length === 0
      && userGuidanceSince(null, 0).length === 0 && userGuidanceSince(tr).length === 3,
    `since 7 -> ${userGuidanceSince(tr, 7).length}; no mark -> ${userGuidanceSince(tr).length} (seq 1, 3, 7)`);

  // (b) The prompt seam: the pictures go on the END of the attachment list, named
  // so they cannot be mistaken for a frame, and the text says out loud that they
  // cannot be pointed at.
  const ref = [{ mediaType: 'image/png', dataBase64: PNG, name: 'screenshot.png' }];
  const p = buildVisionPrompt({
    manifest: geo.manifest, frames: preset, plan: bigPlan, g, independent: true,
    extraImages: ref,
  });
  ok('S8: a reference image is attached AFTER the rendered frames, under a name no frame id can collide with',
    p.images.length === preset.length + 1 && p.images[0].name === preset[0].id
      && p.images[p.images.length - 1].name === 'ref:screenshot.png'
      && p.images.every((im, i) => im.dataBase64 === PNG || i < preset.length),
    J(p.images.map((im) => im.name)));
  ok('S8: the prompt TELLS the model these are not frames and cannot be cited as locators',
    /REFERENCE IMAGES FROM THE HUMAN/.test(p.text) && /You CANNOT point at them/.test(p.text)
      && /\[ref 1\] screenshot\.png/.test(p.text),
    'the pointing contract survives the extra attachment');
  ok('S8: frame attribution is unchanged by the extra images — the audit trail still says which frame was attached',
    p.frames.length === preset.length && p.frames[0].attached === true
      && J(p.references) === J([{ index: 1, name: 'screenshot.png', mediaType: 'image/png' }]),
    J({ frames: p.frames.map((f) => f.attached), refs: p.references.length }));
  const p2 = buildVisionPrompt({ manifest: geo.manifest, frames: preset, plan: bigPlan, g, extraImages: [{ name: 'no-bytes.png' }] });
  ok('S8: a reference with no bytes is warned about and NOT attached — a half-sent screenshot never reaches the model silently',
    p2.images.length === preset.length && p2.warnings.some((w) => /reference image\(s\) carried no bytes/.test(w)),
    J(p2.warnings.filter((w) => /reference/.test(w))));
  ok('S8: no extra images means the prompt is byte-for-byte what it was before the seam existed',
    (() => {
      const bare = buildVisionPrompt({ manifest: geo.manifest, frames: preset, plan: bigPlan, g, independent: true });
      const explicit = buildVisionPrompt({ manifest: geo.manifest, frames: preset, plan: bigPlan, g, independent: true, extraImages: [] });
      return bare.text === explicit.text && J(bare.images) === J(explicit.images) && bare.references.length === 0;
    })(), 'default [] is a no-op');
}

// (c) The whole steered look, end to end through the real gate: words AND pictures
// reach the model turn, the chat is told, and what comes back is still an UNSCORED
// candidate that unions into the list.
{
  const laneM = clone(geo.manifest).map((r) => ({ ...r, history: [...(r.history || [])] }));
  const laneJ = clone(joints0);
  const f = fakes(replyOne);
  const turns = [];
  const beats = [];
  const notes = ['the tail boom folds - look at the rear arm hinge'];
  const look = await runVisionCampaign(g, laneJ, laneM, {
    plan: f.plan, capture: f.capture, persist: f.persist,
    propose: async (text, images) => { turns.push({ text, images }); return f.propose(text, images); },
    emit: (kind, payload) => beats.push({ kind, payload }),
    frames: preset, rounds: 1, expectation: false, independent: true,
    stopAfter: 'proposals',
    humanNotes: () => notes,
    extraImages: [{ mediaType: 'image/png', dataBase64: PNG, name: 'screenshot.png' }],
  });
  ok('S8: the steered look is ONE turn carrying the human\'s words AND their picture',
    turns.length === 1 && /HUMAN IN THE LOOP/.test(turns[0].text)
      && turns[0].text.includes(notes[0])
      && turns[0].images.length === preset.length + 1
      && turns[0].images[turns[0].images.length - 1].name === 'ref:screenshot.png',
    `${turns.length} turn(s), ${turns[0]?.images.length} image(s) attached`);
  const noteBeat = beats.findIndex((b) => b.kind === 'vision:note');
  const askBeat = beats.findIndex((b) => b.kind === 'vision:ask');
  ok('S8: the chat is told the note was folded in, and is told BEFORE the prompt that carries it',
    noteBeat >= 0 && askBeat > noteBeat
      && J(beats[noteBeat].payload.notes) === J(notes)
      && beats[noteBeat].payload.references === 1,
    J(beats.slice(noteBeat, noteBeat + 2).map((b) => ({ kind: b.kind, refs: b.payload.references ?? null }))));
  ok('S8: what the steered look returns is still an UNSCORED candidate — steering adds to the list, it does not settle anything',
    look.ok === true && look.stopped === 'proposals' && look.proposals.length === 1
      && look.proposals[0].status === 'candidate' && (look.proposals[0].tests || []).length === 0
      && look.manifestUntouched === true && laneM.length === geo.manifest.length,
    J(look.proposals.map((r) => ({ id: r.id, status: r.status, tests: (r.tests || []).length }))));

  // (d) The union: the second look's candidate joins the first look's list, and the
  // joints already on it are untouched — which is the whole reason the boundary is
  // safe to spend a turn on. The evidence stamp below is what the orchestrator does
  // immediately before admitting (and leg (f) proves it does it there): reconcileLanes'
  // tag only reaches CONFIRMS, so a newly minted record would otherwise carry no
  // trace of whose idea it was.
  const before = laneM.map((r) => ({ id: r.id, status: r.status }));
  const rec = reconcileLanes(laneM, { records: look.proposals, confirms: look.confirmList || [] },
    { origin: 'L2-vision', tag: 'steered:L2-vision' });
  for (const r of rec.records) {
    r.evidence = Array.isArray(r.evidence) ? r.evidence : [];
    if (!r.evidence.includes('steered:L2-vision')) r.evidence.push('steered:L2-vision');
  }
  const adm = admitCandidates(laneJ, laneM, rec);
  ok('S8: the steered candidate unions into the list and every earlier candidate survives unchanged',
    adm.added === 1 && laneM.length === geo.manifest.length + 1
      && laneM.every((r) => r.status === 'candidate')
      && J(before) === J(laneM.slice(0, before.length).map((r) => ({ id: r.id, status: r.status })))
      && laneJ.length === joints0.length + 1 && laneJ.every((j) => j.status === 'candidate'),
    `+${adm.added}, ${laneM.length} candidates, ${laneJ.length} served joints`);
  const lastRec = laneM[laneM.length - 1];
  ok('S8: the record says a human steered it, so the audit trail can tell the two looks apart',
    Array.isArray(lastRec.evidence) && lastRec.evidence.includes('steered:L2-vision')
      && laneM.slice(0, before.length).every((r) => !(r.evidence || []).includes('steered:L2-vision')),
    J({ id: lastRec.id, evidence: lastRec.evidence }));
}

// (e) The gate still wins. A picture is guidance, never evidence: a proposal that
// cites the human's screenshot as its frame has no camera pose behind it, and
// grounding must refuse it rather than invent a joint from a photograph.
{
  const laneM = clone(geo.manifest).map((r) => ({ ...r, history: [...(r.history || [])] }));
  const laneJ = clone(joints0);
  const f = fakes(() => J([{
    op: 'new', type: 'hinge', frameId: 'ref:screenshot.png', regionBox: [0.2, 0.2, 0.4, 0.4],
    axis: [0, 0, 1], reasoning: 'the human showed me this part', uncertainties: [],
  }]));
  const bad = await runVisionCampaign(g, laneJ, laneM, {
    plan: f.plan, capture: f.capture, propose: f.propose, persist: f.persist,
    frames: preset, rounds: 1, expectation: false, independent: true, stopAfter: 'proposals',
    extraImages: [{ mediaType: 'image/png', dataBase64: PNG, name: 'screenshot.png' }],
  });
  // Grounding still RECORDS what the model pointed at — that is what `rejected` is
  // for — but the gate refuses to admit it, because there is no camera pose behind
  // a human's screenshot to project a regionBox through. The distinction matters:
  // a silently vanished proposal cannot be diagnosed, a rejected one can.
  ok('S8: pointing at the human\'s picture instead of a rendered frame is REJECTED, and the run still reports honestly',
    bad.ok === true && bad.proposals.length === 0 && bad.admitted.length === 0
      && bad.rejected.length === 1 && bad.rejected[0].frameId === 'ref:screenshot.png'
      && bad.manifestUntouched === true && laneM.length === geo.manifest.length,
    `admitted=${bad.admitted.length}, rejected=${J(bad.rejected.map((r) => r.frameId))}, dropped: ${J((bad.warnings || []).filter((w) => /drop/i.test(w)).slice(0, 2))}`);
}

// (f) The wiring, and above all the ORDER. The orchestrator itself needs a live
// render farm and a real model, so it is proven live; what is left to prove here is
// that the kernel reads the guidance at the boundary BETWEEN the two looks and not
// after stage 2 has started — because after `discover:stage 2` the camera lock is
// released and the joints are already being measured.
{
  const src = readFileSync(new URL('../server/kernel-host.mjs', import.meta.url), 'utf8');
  const at = (s) => src.indexOf(s);
  const mark = at('const guidanceMark = sessionStore.seq();');
  const guid = at('const guidance = sessionStore.guidanceSince(guidanceMark);');
  const look = at("emit('discover:look'");
  const notes = at('humanNotes: () => notes,');
  const extra = at('    extraImages,\n');
  const stage2 = at("emit('discover:stage', { stage: 2 });");
  const firstAsk = at("stopAfter: 'proposals',");
  const firstList = at("emit('discover:candidates', {");
  ok('S8: the watermark is taken BEFORE stage 1 asks anything, and read back at the boundary after the list lands',
    [mark, firstAsk, firstList, guid, stage2].every((i) => i > 0)
      && mark < firstAsk && firstAsk < firstList && firstList < guid && guid < stage2,
    J({ mark, firstAsk, firstList, guid, stage2 }));
  ok('S8: the second look folds in BOTH the words and the pictures, before stage 2 starts measuring',
    [look, notes, extra].every((i) => i > guid && i < stage2),
    J({ guid, look, notes, extra, stage2 }));
  ok('S8: the pictures come from the SAME shared attachment reader the chat uses',
    /from '\.\/attachments\.mjs'/.test(src) && at('attachmentsDir(host.repoRoot)') > guid
      && at('attachmentsDir(host.repoRoot)') < stage2,
    'server/attachments.mjs is the only reader');
  ok('S8: and it is guarded — no guidance, no vision lane, a stop or a reload, and the run behaves exactly as before',
    /if \(guidance\.length && wantVision && !refineAbort && !reloaded\(\)\)/.test(src),
    'the guard is the whole cost control');
  const stamp = at("rec.evidence.push('steered:L2-vision')");
  ok('S8: the steered origin is stamped onto the records it added BEFORE they are admitted',
    stamp > guid && stamp < at('const adm2 = admitCandidates(') && stamp < stage2,
    J({ guid, stamp, admit: at('const adm2 = admitCandidates('), stage2 }));
}

// ---- S9) Stop is ONE verb with four reachabilities ---------------------------
// The question this leg answers: when the human hits the red button (or types
// /stop), does everything stop immediately — including the requests already sent
// to the remote model — and are the requests still waiting in the queue REMOVED
// rather than served afterwards? Four things can be running at once, and each
// needs its own handle: the staged discovery (a boundary flag), a controller
// generation (a separate headless child, off the turn chain), the model turn in
// flight (session.cancel tears the stream down client-side — the only abort a
// remote provider can be given), and the queue itself.
{
  // (a) THE QUEUE. A stop removes the user's queued sends; the lane's survive.
  // Dropping a lane send would strand an await inside the running discovery and
  // freeze the orchestrator, which is why discovery is halted by its own flag.
  const agent = createDshAgent({ config: { paths: { dshBin: '/nonexistent/dsh' }, model: 'm' }, diagnostics: { note() {} } });
  const p1 = agent.send('first ask', [], { origin: 'user' });
  const p2 = agent.send('second ask', [], { origin: 'user' });
  const p3 = agent.send('a lane prompt', []);                     // no opts -> lane
  const p4 = agent.send('another lane prompt', [], { origin: 'lane' });
  // No host, so nothing is in flight — but the queue is not empty, and that is
  // exactly what item (4) is about.
  const st = await agent.stop();
  const settled = await Promise.allSettled([p1, p2, p3, p4]);
  const dropped = settled.filter((s) => s.status === 'rejected' && s.reason?.message === DROPPED_MSG);
  const answered = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value.text).sort();
  ok('S9: stop() reports what it actually did — { stopped, dropped }',
    st.stopped === false && st.dropped === 2, J(st));
  ok('S9: every queued USER request is removed from the queue and never reaches the model',
    dropped.length === 2 && dropped.every((s) => s.reason.dropped === true)
      && !answered.includes('first ask') && !answered.includes('second ask'),
    J({ dropped: dropped.length, answered }));
  ok('S9: lane sends survive — a stop must not strand the discovery that is awaiting them',
    J(answered) === J(['a lane prompt', 'another lane prompt']), J(answered));
  ok('S9: a request sent AFTER the stop is a fresh one, not a dropped one',
    (await agent.send('after the stop', [], { origin: 'user' })).reply.includes('after the stop'));
  ok('S9: and the queue is empty again — idle() does not park on the dropped sends',
    (await (async () => { const t0 = Date.now(); await agent.idle(); return Date.now() - t0; })()) < 250);
  await agent.dispose?.();

  // (b) THE ENTRY POINTS. The button (WS {type:'stop'}) and /stop call the SAME
  // function, so they cannot drift; discovery is flagged FIRST so the lane turn
  // that is about to be cancelled unwinds into HUMAN_STOPPED, not a crash.
  const calls = [];
  const fakeKernel = {
    abortRefine: () => { calls.push('refine'); return { ok: true }; },
    abortGenerate: () => { calls.push('generate'); return { ok: true }; },
  };
  const fakeAgent = { stop: async () => { calls.push('agent.stop'); return { stopped: true, dropped: 3 }; } };
  const r1 = await stopEverything({ kernel: fakeKernel, agent: fakeAgent });
  const said = await findCommand('stop').run({ kernel: fakeKernel, agent: fakeAgent, args: '' });
  ok('S9: one stop reaches all three hooks, discovery first',
    J(calls.slice(0, 3)) === J(['refine', 'generate', 'agent.stop']) && calls.length === 6, J(calls));
  ok('S9: /stop names everything it stopped, including the queue it drained',
    r1.nothing === false && /discovery is halting/.test(said) && /generation was killed/.test(said)
      && /turn in flight/.test(said) && /3 queued message\(s\) removed/.test(said), said);
  ok('S9: with nothing running it is an honest sentence, not a fake success',
    (await stopEverything({
      kernel: { abortRefine: () => ({ ok: false, code: 'NOT_RUNNING' }), abortGenerate: () => ({ ok: false, code: 'NOT_RUNNING' }) },
      agent: { stop: async () => ({ stopped: false, dropped: 0 }) },
    })).nothing === true);
  ok('S9: a kernel or agent missing the hooks degrades instead of throwing',
    (await stopEverything({})).nothing === true);

  // (c) GENERATION, the one job off the turn chain — proved with a real child.
  ok('S9: the bridge exposes abort() beside run()',
    typeof dshBridge.api.run === 'function' && typeof dshBridge.api.abort === 'function');
  ok('S9: aborting an idle bridge is NOT_RUNNING, never a kill of the wrong process',
    dshBridge.api.abort().code === 'NOT_RUNNING', J(dshBridge.api.abort()));

  const dir = resolve('runs', `_s9-abort-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const bin = resolve(dir, 'slow-dsh.sh');
  const patch = resolve(dir, 'noop.patch.yml');
  // `exec` so the SIGTERM lands on the sleeper itself, not on a shell that would
  // orphan it: the probe must prove the CHILD dies, not just that sh exited.
  writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  writeFileSync(patch, '- id: noop\n');
  const fakeHost = {
    // dshTimeoutMs is long on purpose: only a user abort may end this child.
    config: { paths: { dshBin: bin, bailianPatch: patch }, apiKey: 'x', dshTimeoutMs: 30_000, model: 'qwen3.8-max' },
    resources: { trackChild() {} },
    bus: { emit() {} },
    diagnostics: { note() {} },
  };
  const t0 = Date.now();
  const running = dshBridge.api.run({ host: fakeHost, task: 'sleep', runDir: dir, model: null });
  await new Promise((r) => setTimeout(r, 400)); // let the stand-in child start
  const killed = dshBridge.api.abort();
  const outcome = await running.then(() => 'resolved-without-error', (e) => e.message);
  const ms = Date.now() - t0;
  ok('S9: abort() SIGTERMs the generation child that is really in flight',
    killed.ok === true && typeof killed.pid === 'number', J(killed));
  ok('S9: a 30s generation ends at once and says a human aborted it — not "no controller was produced"',
    /aborted by the user/i.test(outcome) && ms < 5000, `${ms}ms -> ${outcome}`);
  ok('S9: and the bridge is idle again afterwards', dshBridge.api.abort().code === 'NOT_RUNNING');
  rmSync(dir, { recursive: true, force: true });

  // (d) THE WIRING, in source order: the WS stop handler and the button both go
  // through stopEverything, the composer's send is tagged as a user send (that tag
  // is what makes it droppable), and the button no longer special-cases discovery.
  const routeSrc = readFileSync(new URL('../server/routes/agent.mjs', import.meta.url), 'utf8');
  ok('S9: the WS stop handler calls the shared stopEverything, and the send is tagged origin:user',
    /const stopped = await stopEverything\(\{ kernel, agent \}\);/.test(routeSrc)
      && /agent\.send\(text, images, \{ origin: 'user' \}\)/.test(routeSrc)
      && /e\.dropped \|\| e\.message === DROPPED_MSG/.test(routeSrc));
  // Session isolation: a lane send must NEVER prompt the human DSH session. One
  // shared session is exactly how a human turn that arrives right after a vision
  // round came to be answered IN the vision reply schema — the freshest contract
  // in the history wins. Lane calls are self-contained, so they get a stateless
  // session each; mux events and cancel are addressed to the turn's own session.
  const dshSrc = readFileSync(new URL('../server/dsh-agent.mjs', import.meta.url), 'utf8');
  ok('S9: lane sends prompt a stateless session of their own — the human session stays purely human',
    /const human = opts\?\.origin === 'user';/.test(dshSrc)
      && /const sid = human \? sessionId : await createLaneSession\(\);/.test(dshSrc)
      && /rpc\('session\.prompt', \{ sessionId: sid, mode: 'queue', content \}\)/.test(dshSrc)
      && /f\.sessionId !== \(turnSid \|\| sessionId\)/.test(dshSrc)
      && /rpc\('session\.cancel', \{ sessionId: turnSid \|\| sessionId \}, 5_000\)/.test(dshSrc));
  // Thinking is switched off ONLY for a machine turn that carries screenshots.
  // The condition is pinned here because getting it wrong is silent and costly
  // in both directions: including a human send with an attachment would cost the
  // human their reasoned answer, and including a lane turn WITHOUT images would
  // keep paying ~244s of reasoning on the text lane, which never had the
  // problem. Omitting the effort is not neutral either — DSH then falls back to
  // the route default, which is thinking ON (see bailian.patch.yml), so the
  // effort must also be part of what selectModel caches.
  ok('S9: thinking is off for machine image turns, and for every run after the first of a human turn under the half policy — the text lane keeps it',
    /const effort = \(!human && images\.length\) \? 'off' : \(human && policy === 'off'\) \? 'off' : null;/.test(dshSrc)
      && /await selectModel\(model, sid, effort\);/.test(dshSrc)
      && /\.\.\.\(effort \? \{ reasoningEffort: effort \} : \{\}\)/.test(dshSrc)
      && /modelBySession\.set\(sid, key\)/.test(dshSrc));
  ok('S9: the half switch lands on a step boundary and only once per turn — the first run thinks, the rest do not',
    /kind === 'step\/end'/.test(dshSrc) && /halfArmed && !halfSwitched/.test(dshSrc) && /selectModel\(turnModel, turnSid, 'off'\)/.test(dshSrc));
  // The patch file is the other half of the same decision, and it broke once
  // already. Declaring reasoningEfforts makes pi-ai treat the model as
  // reasoning-capable, and pi-ai then sends the SYSTEM PROMPT with role
  // `developer` (openai-completions.js:787,
  // `useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`).
  // This gateway rejects that role outright --
  //   400 invalid_parameter_error: developer is not one of
  //       ['system','assistant','user','tool','function']
  // -- so every turn died before the model saw it, human session and lanes
  // alike. Nothing in the app named it as a configuration fault; the refinement
  // simply produced no proposals, which looks exactly like a model that found
  // nothing. `supportsDeveloperRole: false` keeps the role `system`, and it is
  // load-bearing ONLY because the efforts are declared -- so the guard is
  // written as that implication, not as two unrelated facts about the file.
  const patchSrc = readFileSync(new URL('../bailian.patch.yml', import.meta.url), 'utf8');
  const declaresEfforts = /^\s+reasoningEfforts:/m.test(patchSrc);
  ok('S9: the bailian route declares the qwen thinking dialect AND a route default of high — omitting an effort means thinking ON, never "no opinion"',
    /thinkingFormat:\s*qwen/.test(patchSrc) && /^\s+reasoning:\s*high\s*$/m.test(patchSrc));
  ok('S9: declaring reasoning efforts REQUIRES supportsDeveloperRole:false — without it this gateway 400s on the `developer` role and EVERY turn dies',
    !declaresEfforts || /supportsDeveloperRole:\s*false/.test(patchSrc),
    `reasoningEfforts declared=${declaresEfforts}`);
  ok('S9: the `off` level is quoted — a bare off: is a YAML 1.1 boolean, and one invalid model invalidates the whole route',
    /"off":/.test(patchSrc) && !/^\s+off:\s*$/m.test(patchSrc));
  const sockSrc = readFileSync(new URL('../app/src/composables/useAgentSocket.js', import.meta.url), 'utf8');
  const stopFn = sockSrc.slice(sockSrc.indexOf('function stop()'), sockSrc.indexOf('function stop()') + 400);
  ok('S9: the red button sends ONE stop for every case — no discovery special case left',
    stopFn.includes("ws.send(JSON.stringify({ type: 'stop' }))") && !/if \(state\.refining\)/.test(stopFn),
    stopFn.split('\n').filter((l) => l.trim()).slice(0, 3).join(' | '));
  const kernelSrc = readFileSync(new URL('../server/kernel-host.mjs', import.meta.url), 'utf8');
  ok('S9: the kernel exposes abortGenerate() and it goes to the dsh bridge\'s abort hook',
    /abortGenerate\(\) \{/.test(kernelSrc) && /host\.registry\.get\(CATEGORY\.BRIDGE, 'dsh'\)/.test(kernelSrc)
      && /bridge\?\.api\?\.abort\?\.\(\)/.test(kernelSrc));

  // S10 — the out-of-band verdict loop. A circled-scope turn died at the 15-min
  // cap after 45 tool calls: ~5 min of source archaeology to discover the write
  // path (kernel-cli had no edit verb, AGENTS.md never named the verdict route),
  // then more at the end for the UI-refresh path — which did not exist: setVerdict
  // broadcast nothing, so the open tab kept the PRE-edit node list and the human
  // clicking the joint saw the old scope. Three wires close that loop, plus the
  // validation that made a bogus node list apply silently during the probe.
  const flatKernel = kernelSrc.replace(/\s+/g, ' ');
  ok('S10: a landed verdict broadcasts joint:verdict — an out-of-band writer (the agent, a second tab, curl) must reach every open tab',
    /broadcast\(\{ kind: 'joint:verdict',/.test(flatKernel));
  const storeSrc = readFileSync(new URL('../app/src/composables/useProjectStore.js', import.meta.url), 'utf8');
  const verdictBranch = storeSrc.slice(storeSrc.indexOf("msg.kind === 'joint:verdict'"));
  ok('S10: the store re-reads the joint list on joint:verdict — a stale list makes a correct edit read as "did nothing"',
    verdictBranch.includes('refreshJoints()')
    && verdictBranch.indexOf('refreshJoints()') < verdictBranch.indexOf('} else if'));
  const wsSrc = readFileSync(new URL('../server/agent-workspace.mjs', import.meta.url), 'utf8');
  ok('S10: kernel-cli carries the edit verb — the only write path, so the agent never archaeologizes it again',
    /cmd === 'edit'/.test(wsSrc) && /decision: 'edit', edits: \{ nodes \}, actor: 'assistant'/.test(wsSrc));
  ok('S10: kernel-cli carries the deterministic set builders (subtree / region) that replace hand-rolled python over /api/state',
    /cmd === 'subtree' \|\| cmd === 'region'/.test(wsSrc));
  ok('S10: AGENTS.md names the scope-rectify recipe and the broadcast, so a circled region is a 4-step job, not a 38-step improvisation',
    /## Rectifying a joint's scope/.test(wsSrc) && /kernel-cli\.mjs edit <jointId>/.test(wsSrc) && /joint:verdict/.test(wsSrc));
  const manifestSrc = readFileSync(new URL('../src/plugins/discovery/manifest.mjs', import.meta.url), 'utf8');
  const loopSrc = readFileSync(new URL('../src/plugins/discovery/loop.mjs', import.meta.url), 'utf8');
  ok('S10: an edit may name only nodes the mesh contains — applyJointVerdict hands the parsed name set to applyVerdict',
    /knownNodes/.test(manifestSrc) && /knownNodes/.test(loopSrc) && /unknown node name\(s\)/.test(manifestSrc));

  // S11 — the removal surface. "Take this joint off the list" had no expression
  // at all: dropCandidate refuses refined records, a reject verdict leaves the
  // row in the list, JointList renders state.joints unfiltered. So a remove ask
  // became a 15-step improvisation that never removed anything. Four wires make
  // it one call — kernel method, route, cli verb, docs — plus the slash
  // fallthrough so a human /discovery drop on a refined row also removes it.
  const jointsRouteSrc = readFileSync(new URL('../server/routes/joints.mjs', import.meta.url), 'utf8');
  const slashSrc = readFileSync(new URL('../server/slash-commands.mjs', import.meta.url), 'utf8');
  ok('S11: the kernel can remove a refined joint — delete the record, commit a revision, broadcast so tabs drop the row',
    /removeJoint\(id, actor = 'human'\)/.test(flatKernel) && /decision: 'remove'/.test(flatKernel));
  ok('S11: POST /api/joints/:id/remove exposes removal to the agent and any other writer',
    jointsRouteSrc.includes('/api/joints/:id/remove') && /kernel\.removeJoint\(req\.params\.id/.test(jointsRouteSrc));
  ok('S11: kernel-cli carries the drop verb — removal is one call, not an investigation',
    /cmd === 'drop'/.test(wsSrc) && /\/remove'/.test(wsSrc));
  ok('S11: AGENTS.md forbids turning a removal into a controller investigation',
    /## Removing a joint/.test(wsSrc) && /kernel-cli\.mjs drop <jointId>/.test(wsSrc));
  ok('S11: /discovery drop on a refined joint falls through to removal instead of refusing with dead-end advice',
    /code === 'ALREADY_REFINED' && kernel\.removeJoint/.test(slashSrc));

  // S12 — the efficiency wires. A circled-scope turn on the new recipe still
  // spent ~90s of remote THINKING per step plus two wasted calls (an
  // inaccessible /tmp spill grep, a 725-node whole-airframe subtree), and every
  // server boot threw verified scopes away — the next circled turn re-derived
  // from scratch what a human had already confirmed. Scope memory makes a
  // restart start where the human left off; the config dial lets a human image
  // turn trade deliberation for latency; the measured traps stay named.
  const agentSrc = readFileSync(new URL('../server/dsh-agent.mjs', import.meta.url), 'utf8');
  const configSrc = readFileSync(new URL('../src/config.mjs', import.meta.url), 'utf8');
  ok('S12: verified scopes persist outside runs/ and are re-applied on load as scope-memory edits',
    /scope-memory\.json/.test(kernelSrc) && /actor: 'scope-memory'/.test(kernelSrc) && /current\.glbSha/.test(kernelSrc));
  ok('S12: a landed edit/accept records its node set into scope memory keyed by glb content hash',
    /scopeMemoryWrite\(mem\)/.test(kernelSrc) && /bucket\[id\] = \{ label: rec\.label/.test(kernelSrc));
  ok('S12: the thinking policy for human turns is a config knob defaulting to half (first run thinks, the rest do not)',
    /cfg\.humanReasoningPolicy/.test(agentSrc) && /humanReasoningPolicy: raw\.human_reasoning_policy \|\| 'half'/.test(configSrc));
  ok('S12: kernel-cli region accepts both arg styles and AGENTS.md names the measured waste traps',
    /args\.join\(','\)/.test(wsSrc) && /Waste traps measured on real turns/.test(wsSrc));
  ok('S12: kernel-cli answers connectivity in one call (chain) so floater questions never become node -e archaeology',
    /cmd === 'chain'/.test(wsSrc) && /chain <name,…>/.test(wsSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? 'STAGES_PROBE_FAILED' : 'STAGES_PROBE_OK');
process.exit(fail ? 1 : 0);

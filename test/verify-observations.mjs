// Observation-store proof — the automated answer to "is a vision round's
// evidence durable, resumable, bounded, and impossible to write outside its own
// directory?" Five legs, exit 0 only if all hold:
//   A) plan / frame / reply / proposals all round-trip through disk
//   B) the colour-id map is stored beside its frame, not inlined in the index
//   C) a caller-supplied frame id cannot escape the round directory
//   D) the frame budget is enforced, and a retry of the same id does not count
//      twice against it
//   E) a round survives a "restart": re-reading from disk alone reconstructs it
//
// Usage: node test/verify-observations.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAX_FRAMES_PER_ROUND, framePath, listRounds, loadColorMap, loadPlan,
  loadReply, loadRound, observationsRoot, roundDir, saveFrame, savePlan,
  saveProposals, saveReply,
} from '../src/plugins/discovery/observations.mjs';
import { loadConfig } from '../src/config.mjs';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}${extra ? ' \u2014 ' + extra : ''}`); } else { fail += 1; console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
};

console.log('\nProving the observation store\n');

const runDir = mkdtempSync(resolve(loadConfig(null).paths.runs, 'probe-obs-'));
// A 1x1 PNG — the smallest real image, enough to prove bytes survive intact.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

try {
  // ---- A) round-trip --------------------------------------------------------
  const plan = { views: [{ id: 'v0', mode: 'photo', spec: { azimuth: 0, elevation: 20, distance: 100 }, marginal: 52 }], coverage: 0.67 };
  savePlan(runDir, 1, plan);
  const frame = saveFrame(runDir, 1, {
    id: 'v0', mode: 'photo', mediaType: 'image/png', dataBase64: PNG_1PX,
    width: 1024, height: 1024, spec: plan.views[0].spec, colorMap: { '#ff0000': ['Object_12'] },
  });
  saveReply(runDir, 1, { prompt: 'P', reply: 'R', model: 'qwen3.8-max', ms: 12, warnings: [] });
  saveProposals(runDir, 1, { records: [{ id: 'rotor_x' }], confirms: ['rotor_br_0'], rejected: [{ id: 'bad', why: 'overlap' }] });

  ok('A: plan round-trips', JSON.stringify(loadPlan(runDir, 1)) === JSON.stringify(plan));
  ok('A: frame lands on disk with its declared byte length',
    frame.ok === true && existsSync(frame.file)
    && readFileSync(frame.file).length === frame.entry.bytes,
    `${frame.entry.bytes} bytes at ${frame.file.replace(runDir, '<run>')}`);
  ok('A: reply round-trips verbatim', loadReply(runDir, 1)?.reply === 'R' && loadReply(runDir, 1)?.prompt === 'P');
  ok('A: proposals keep the rejection reasons',
    loadRound(runDir, 1)?.proposals?.rejected?.[0]?.why === 'overlap');

  // ---- B) colour map is separate --------------------------------------------
  {
    const idx = JSON.parse(readFileSync(resolve(roundDir(runDir, 1), 'frames.json'), 'utf8'));
    ok('B: the colour map is referenced, not inlined in the index',
      idx.frames[0].colorMap === 'v0.colors.json' && !('colorMapEntries' in idx.frames[0]),
      `frames.json is ${readFileSync(resolve(roundDir(runDir, 1), 'frames.json'), 'utf8').length} bytes`);
    const map = loadColorMap(runDir, 1, 'v0');
    ok('B: the colour map round-trips to node names',
      Array.isArray(map?.['#ff0000']) && map['#ff0000'][0] === 'Object_12');
  }

  // ---- C) ids cannot escape the round directory ------------------------------
  {
    const evil = saveFrame(runDir, 1, {
      id: '../../../escape', mode: 'photo', dataBase64: PNG_1PX, mediaType: 'image/png',
    });
    const inside = resolve(evil.file).startsWith(roundDir(runDir, 1));
    ok('C: a traversal id is neutralised inside the round dir', evil.ok === true && inside,
      `${evil.entry.id} -> ${evil.file.replace(runDir, '<run>')}`);
    ok('C: nothing was written above the observations root',
      !existsSync(resolve(observationsRoot(runDir), 'escape.png'))
      && !existsSync(resolve(runDir, 'escape.png')));
    const bad = saveFrame(runDir, 1, { id: 'x', mode: 'photo', dataBase64: '' });
    ok('C: an undecodable frame is refused, not written empty', bad.ok === false && /no image|did not decode/.test(bad.error), bad.error);
  }

  // ---- D) frame budget -------------------------------------------------------
  {
    const dir2 = roundDir(runDir, 2);
    let written = 0; let refused = 0;
    for (let i = 0; i < MAX_FRAMES_PER_ROUND + 6; i += 1) {
      const r = saveFrame(runDir, 2, { id: `f${i}`, mode: 'photo', dataBase64: PNG_1PX, mediaType: 'image/png' });
      if (r.ok) written += 1; else refused += 1;
    }
    ok('D: the per-round frame budget is enforced',
      written === MAX_FRAMES_PER_ROUND && refused === 6, `${written} written, ${refused} refused`);
    // A retry of an existing id replaces it rather than consuming budget.
    const retry = saveFrame(runDir, 2, { id: 'f0', mode: 'ghost', dataBase64: PNG_1PX, mediaType: 'image/png' });
    const idx = JSON.parse(readFileSync(resolve(dir2, 'frames.json'), 'utf8'));
    ok('D: re-rendering the same view replaces it, not double-counts',
      retry.ok === true && idx.frames.length === MAX_FRAMES_PER_ROUND
      && idx.frames.filter((f) => f.id === 'f0').length === 1
      && idx.frames.find((f) => f.id === 'f0').mode === 'ghost');
  }

  // ---- E) resumable from disk alone ------------------------------------------
  {
    const rounds = listRounds(runDir);
    ok('E: listing discovers every round with its totals',
      rounds.length === 2 && rounds[0].round === 1 && rounds[1].round === 2,
      rounds.map((r) => `r${r.round}:${r.frames}f/${(r.bytes / 1024).toFixed(1)}KB${r.hasPlan ? '+plan' : ''}${r.hasReply ? '+reply' : ''}`).join(' '));
    ok('E: the listing records which render modes a round used',
      rounds[1].modes.includes('photo') && rounds[1].modes.includes('ghost'), rounds[1].modes.join(','));
    const r1 = loadRound(runDir, 1);
    ok('E: a round is reconstructable without any in-memory state',
      r1 && r1.plan && r1.frames.length === 2 && r1.reply && r1.proposals,
      `${r1.frames.length} frames`);
    ok('E: framePath resolves a stored frame for serving', framePath(runDir, 1, 'v0') === frame.file);
    ok('E: framePath returns null for an unknown id', framePath(runDir, 1, 'nope') === null);
    ok('E: an absent round loads as null, not as a throw', loadRound(runDir, 99) === null);
    ok('E: listing an empty run yields no rounds', listRounds(resolve(runDir, 'nothing')).length === 0);
  }
} finally {
  rmSync(runDir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'OBSERVATIONS_PROBE_OK' : 'OBSERVATIONS_PROBE_FAILED'} \u2014 ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

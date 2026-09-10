// Session store — resumability foundation. Work state already lives in the kernel
// context store (runs/<ts>/context.json), but that dir is per-boot. This store
// writes to a STABLE path (sessions/latest.json) so closing and reopening the
// localhost restores the conversation transcript + a pointer to the project.
//
// Split of responsibility (from the captured design):
//   - WORK state (joints, controllers, validation) = kernel context (system-of-record)
//   - CONVERSATION state (transcript, DSH sessionId) = this store
// Every transcript entry carries a monotonic `seq` (independent of clears) so all
// connected tabs of this single-install session can apply entries idempotently
// and converge resume payloads with live broadcast frames.
// In M2 the persisted sessionId is handed to session.create to resume the live
// agent; until then the transcript alone restores the visible conversation.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// What the human SAID while a producer was in flight — the raw material for a
// steered second look. Pure and exported so it is testable against a literal
// array instead of the real sessions/latest.json: a transcript is just entries
// carrying a monotonic `seq`, and "since" is a watermark the caller took before
// it started asking anything.
//
// Three exclusions, none of them stylistic:
//   - role !== 'user'   — the assistant's own answers are not instructions.
//   - empty text        — a picture with no words is not guidance. (The picture
//                         still rides along when it is attached to a message
//                         that HAS words, which is the case that matters.)
//   - text starts '/'   — a slash command is STRUCTURAL. /discovery drop already
//                         reshaped the plan deterministically; feeding its text
//                         to a model would ask the model to do a thing that is
//                         done, and would let a command verb arrive as prose.
export function userGuidanceSince(transcript, since = 0) {
  const mark = Number.isFinite(since) ? since : 0;
  const out = [];
  for (const e of Array.isArray(transcript) ? transcript : []) {
    if (!e || e.role !== 'user') continue;
    if (!(Number.isFinite(e.seq) && e.seq > mark)) continue;
    const text = String(e.text || '').trim();
    if (!text || text.startsWith('/')) continue;
    out.push({
      seq: e.seq,
      text,
      ts: Number.isFinite(e.ts) ? e.ts : null,
      attachments: (Array.isArray(e.attachments) ? e.attachments : [])
        .map((a) => (a && a.id != null ? String(a.id) : null))
        .filter(Boolean),
    });
  }
  return out;
}

export function createSessionStore({ repoRoot, dir = 'sessions' }) {
  const base = resolve(repoRoot, dir);
  const file = resolve(base, 'latest.json');
  mkdirSync(base, { recursive: true });

  const blank = () => ({ sessionId: null, glb: null, runDir: null, updatedAt: Date.now(), seq: 0, transcript: [], work: {} });
  let state = blank();
  if (existsSync(file)) {
    try { state = { ...blank(), ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* corrupt -> start fresh */ }
  }

  const persist = () => { state.updatedAt = Date.now(); writeFileSync(file, JSON.stringify(state, null, 2)); return file; };

  return {
    file,
    get: () => state,
    // The transcript watermark. A producer takes this BEFORE it asks anything and
    // reads guidanceSince(mark) at its next boundary, so "what arrived while I was
    // working" needs no clock and no guessing.
    seq: () => state.seq,
    guidanceSince(since) { return userGuidanceSince(state.transcript, since); },
    append(msg) { const entry = { ...msg, seq: ++state.seq }; state.transcript.push(entry); persist(); return entry; },
    setSession(patch) { Object.assign(state, patch); persist(); return state; },
    setWork(patch) { state.work = { ...state.work, ...patch }; persist(); return state.work; },
    clearTranscript() { state.transcript = []; persist(); },
    load() { if (existsSync(file)) { try { state = { ...blank(), ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* ignore */ } } return state; },
    persist,
  };
}

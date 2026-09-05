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
    append(msg) { const entry = { ...msg, seq: ++state.seq }; state.transcript.push(entry); persist(); return entry; },
    setSession(patch) { Object.assign(state, patch); persist(); return state; },
    setWork(patch) { state.work = { ...state.work, ...patch }; persist(); return state.work; },
    clearTranscript() { state.transcript = []; persist(); },
    load() { if (existsSync(file)) { try { state = { ...blank(), ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* ignore */ } } return state; },
    persist,
  };
}

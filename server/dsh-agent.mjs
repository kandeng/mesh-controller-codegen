// Persistent DSH agent supervisor — the invisible agent boundary for the app.
//
// M1 (this milestone): STUB. The chatbot UI + WS route are wired, but no DSH web
// process is spawned; send() returns a placeholder so the shell is testable
// without spending model runs.
//
// M2 (verified design — contract read from the installed DSH packages):
//   The `dsh --profile web` host exposes a JSON-RPC API. Wire path is
//   POST /api/<method> (e.g. /api/session.create), with assistant/tool events
//   streamed back over a separate WebSocket/SSE channel ("four-quadrant message
//   model": HTTP, WebSocket, in-process SSE are interchangeable carriers).
//   Source of truth: @deepseek-ai/dsh-host-apiproxy/lib/types/api/rpc-map.d.ts
//   and sessions.d.ts. The methods we need:
//     - session.create  {cwd?, sessionId?, agentPreset?} -> {sessionId}
//         Idempotent: re-creating with the SAME preallocated sessionId + cwd
//         returns the same session (a different cwd -> 'session-conflict').
//         This is the resumability primitive: we persist OUR sessionId and
//         re-create on boot; the agent rebuilds from its jsonl log.
//     - session.prompt  {sessionId, mode:'queue'|'steer', content:[{type:'text',text}], clientTimeZone?}
//     - session.history {sessionId, beforeSeq?, maxMessages?} -> {events, hasMore}
//         Used to replay the transcript into the UI after a restart.
//     - session.cancel  {sessionId}
//     - session.selectModel {sessionId, provider, model}
//   Lifecycle: spawn `dsh --profile web --port 0 --no-open --trusted-host
//   127.0.0.1:<ourPort> --patch <bailian.patch.yml>` as a GC-tracked child,
//   parse the chosen port from stdout, then drive it over /api. On shutdown the
//   resource GC SIGTERMs the child (no runaway agent — the original pain).
import { defineAgentContract } from './agent-contract.mjs';

export function createDshAgent(kernel) {
  const mode = 'stub'; // M2: 'live'
  const contract = defineAgentContract();
  let sessionId = null;

  return {
    mode,
    contract,

    status() {
      return { mode, sessionId, model: kernel.config.model, methods: contract.methods };
    },

    // M2: ensureSession() -> session.create with our persisted sessionId (resume).
    async ensureSession() {
      if (mode === 'stub') { sessionId = sessionId || 'stub-session'; return { sessionId, resumed: false }; }
      throw new Error('live agent lands in M2');
    },

    // M1 stub reply. M2: session.prompt + stream SessionEvents over the WS.
    async send(text) {
      if (mode !== 'stub') throw new Error('live agent lands in M2');
      const reply =
        `The conversational assistant (persistent DSH agent) lands in Milestone 2.\n\n` +
        `For now the app shell is fully functional without it: load a mesh, pick a joint, ` +
        `drive its knobs, and validate/generate from the toolbar.\n\n` +
        `You said: "${text}"`;
      return { role: 'assistant', text, reply, mode };
    },

    async dispose() { /* M2: SIGTERM the web-profile child via kernel.resources */ },
  };
}

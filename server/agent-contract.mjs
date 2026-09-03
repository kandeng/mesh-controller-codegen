// The agent's public contract: the JSON-RPC methods it speaks (mirroring the DSH
// web profile) and the per-joint conversational shape the assistant follows.
// Kept separate so both the supervisor and the WS route agree on one definition.

export function defineAgentContract() {
  return {
    // Wire methods (M2 maps these onto POST /api/<method> of the DSH web host).
    methods: ['session.create', 'session.prompt', 'session.history', 'session.cancel', 'session.selectModel'],
    // The per-joint incremental conversation the assistant drives (from the
    // captured design): focus one maximal-scope joint at a time.
    turnShape: {
      focus: 'one joint unit at a time (e.g. "rotor of the left propeller = hub + 2 blades")',
      steps: ['recommend joints (maximal scope)', 'human edits the list', 'generate per-joint controller', 'validate in isolation', 'human verifies via dynamic knobs'],
    },
  };
}

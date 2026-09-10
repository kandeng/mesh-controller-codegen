// Slash commands — deterministic, supervisor-handled commands for the chat.
// The DSH web host is driven over RPC with plain-text prompts, so DSH's own TUI
// slash commands are unreachable from our UI; these are intercepted in the WS
// `send` handler BEFORE agent.send(), answered without an LLM round-trip, and
// broadcast through the same turn frames as normal turns so every tab of the
// single-install session converges (see server/routes/agent.mjs).
//
// A command's run() returns either:
//   - a string            -> persisted+broadcast as an assistant entry tagged
//                            with `command: <name>` (rendered monospace), or
//   - { clear: true }     -> transcript wiped; a `clear` frame empties all tabs.
// Safety: commands with takesArgs:false only fire on an EXACT "/name"; anything
// after the name ("/clean up the previous chat") falls through to the assistant
// as ordinary prose instead of misfiring. A slash-shaped input whose name is NOT
// in the registry ("/rig") is rejected with a "no such slash command" notice.
export const COMMANDS = [
  {
    name: 'help',
    usage: '/help',
    desc: 'List every slash command with its usage and an example.',
    example: '/help',
    takesArgs: false,
    run: () => helpText(),
  },
  {
    name: 'clean',
    usage: '/clean',
    desc: 'Wipe this install\'s conversation history in every tab (attached image files stay on disk).',
    example: '/clean',
    takesArgs: false,
    run: ({ kernel }) => {
      kernel.sessionStore?.clearTranscript();
      return { clear: true };
    },
  },
  {
    name: 'stop',
    usage: '/stop',
    desc: 'Stop the currently running assistant turn; queued messages still run afterwards.',
    example: '/stop',
    takesArgs: false,
    // No turn-start/turn-end frames: /stop fires WHILE a turn is live and
    // must not flip the tabs' busy state out from under it.
    quiet: true,
    run: async ({ agent }) => ((await agent.stop())
      ? 'Stop requested — the running turn is being cancelled. Queued messages (if any) still run.'
      : 'No task is running — nothing to stop.'),
  },
  {
    // Plan control for the STAGED discovery. Discovery yields at every boundary
    // (after stage 1 and after each joint) and re-reads its live plan there, so a
    // request served from the queue can genuinely reshape what is left to do —
    // these are the deterministic verbs the assistant (or the user) uses to do it.
    name: 'discovery',
    usage: '/discovery <status|stop|drop <id>|postpone <id>>',
    desc: 'Inspect or reshape the running discovery plan: status, stop at the next boundary, drop a candidate, or postpone one to the end.',
    example: '/discovery drop rotor_vis_4',
    takesArgs: true,
    // The WS handler calls run({ kernel, agent, args }) — one context object.
    run: ({ kernel, args = '' }) => {
      const [verb, ...rest] = String(args || '').trim().split(/\s+/);
      const id = rest.join(' ').trim();
      if (verb === 'status') {
        const list = kernel.current?.manifest || [];
        const cand = list.filter((r) => r.status === 'candidate').map((r) => r.id);
        const done = list.filter((r) => r.status !== 'candidate').map((r) => `${r.id}:${r.status}`);
        return `discovery: ${cand.length} candidate(s) left [${cand.join(', ') || 'none'}] · settled [${done.join(', ') || 'none'}]`;
      }
      if (verb === 'stop') {
        const r = kernel.abortRefine?.() || { ok: false, error: 'abort is not available on this kernel' };
        return r.ok
          ? 'Stop requested — the discovery halts at its next boundary. Joints refined so far stay; the rest remain candidates.'
          : `Nothing to stop: ${r.error}`;
      }
      if (verb === 'drop') {
        if (!id) return 'Usage: /discovery drop <joint id or label>';
        const r = kernel.dropCandidate?.(id) || { ok: false, error: 'not available on this kernel' };
        return r.ok ? `Dropped ${r.dropped} from the plan — ${r.remaining} candidate(s) left.` : `Could not drop: ${r.error}`;
      }
      if (verb === 'postpone') {
        if (!id) return 'Usage: /discovery postpone <joint id or label>';
        const r = kernel.postponeCandidate?.(id) || { ok: false, error: 'not available on this kernel' };
        return r.ok ? `Postponed ${r.postponed} to the end of the plan.` : `Could not postpone: ${r.error}`;
      }
      return `Unknown /discovery verb "${verb || ''}" — use status, stop, drop <id> or postpone <id>.`;
    },
  },
];

// "/name [args...]" -> { name, args } | null (null = not a slash command).
export function parseSlash(text) {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

export function findCommand(name) {
  return COMMANDS.find((c) => c.name === name) || null;
}

// Generated from the registry so /help can never drift from reality.
export function helpText() {
  const lines = ['# Slash commands', ''];
  for (const c of COMMANDS) {
    lines.push(`- \`${c.usage}\` — ${c.desc}`);
    lines.push(`  example: \`${c.example}\``);
  }
  lines.push('', 'Unknown /commands are rejected; anything else goes to the AI assistant as prose.');
  return lines.join('\n');
}

// Injected into the run dir's AGENTS.md so the persona knows which commands the
// supervisor answers deterministically (they never reach the model).
export function slashSection() {
  return [
    '',
    '## Slash commands (answered deterministically by the supervisor)',
    ...COMMANDS.map((c) => `- \`${c.usage}\` — ${c.desc}`),
    'Unknown /commands are rejected with "no such slash command"; the ones above',
    'are intercepted before prompting, so you never see them; do not implement',
    'or imitate them yourself.',
    '',
  ].join('\n');
}

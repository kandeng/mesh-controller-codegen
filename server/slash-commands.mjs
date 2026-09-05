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

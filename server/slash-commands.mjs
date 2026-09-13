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
// /clean and /clear are ONE command under two names — people type either, and
// both must wipe in exactly the same way, so they share a single run(). Keeping
// the behaviour in one function (rather than a copy) is what makes "identical"
// true by construction instead of by discipline.
const wipeTranscript = ({ kernel }) => {
  kernel.sessionStore?.clearTranscript();
  return { clear: true };
};

// The one Stop, reachable from two doors: the red button (WS {type:'stop'}) and
// the /stop command. Both must mean the same thing, so both call THIS — one
// function is what keeps "identical" true instead of merely intended.
// Four reachabilities, in the order that matters:
//   1. discovery — set the boundary flag FIRST, so the lane turn that is about to
//      be cancelled unwinds into a clean HUMAN_STOPPED refine:end instead of a
//      crash (the orchestrator checks the flag at the boundary it lands on);
//   2. generation — kill the headless dsh child; generation is the one job that
//      does not ride the turn chain, so cancelling a turn cannot reach it;
//   3. the live model turn — session.cancel tears the request down client-side,
//      which is the only abort the remote provider can be given;
//   4. the queue — the user's queued sends are REMOVED, not merely postponed,
//      so nothing resurrects the job that was just stopped. Lane sends are kept:
//      they are awaits inside the running discovery, and discovery is stopped by
//      (1), not by stranding its own await.
export async function stopEverything({ kernel, agent } = {}) {
  const refine = kernel?.abortRefine?.() || { ok: false };
  const generate = kernel?.abortGenerate?.() || { ok: false };
  const r = (await agent?.stop?.()) || {};
  const stopped = r.stopped === true;
  const dropped = r.dropped || 0;
  const parts = [];
  if (refine.ok) parts.push('discovery is halting — the joints already checked stay committed');
  if (generate.ok) parts.push('the controller generation was killed');
  if (stopped) parts.push('the model turn in flight is being cancelled');
  if (dropped) parts.push(`${dropped} queued message(s) removed from the queue`);
  return { refine, generate, stopped, dropped, parts, nothing: parts.length === 0 };
}

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
    run: wipeTranscript,
  },
  {
    name: 'clear',
    usage: '/clear',
    desc: 'Alias of /clean — wipe this install\'s conversation history in every tab (attached image files stay on disk).',
    example: '/clear',
    takesArgs: false,
    run: wipeTranscript,
  },
  {
    name: 'stop',
    usage: '/stop',
    desc: 'Stop everything at once: halt discovery, kill a running generation, cancel the model turn in flight, and remove queued messages from the queue.',
    example: '/stop',
    takesArgs: false,
    // No turn-start/turn-end frames: /stop fires WHILE a turn is live and
    // must not flip the tabs' busy state out from under it.
    quiet: true,
    run: async ({ kernel, agent }) => {
      const r = await stopEverything({ kernel, agent });
      return r.nothing
        ? 'No task is running — nothing to stop.'
        : `Stop requested — ${r.parts.join('; ')}.`;
    },
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
        if (r.ok) return `Dropped ${r.dropped} from the plan — ${r.remaining} candidate(s) left.`;
        // A refined joint is not plan any more, so dropCandidate refuses it —
        // but a human saying "drop it" about a row in the list means REMOVE the
        // row, whatever its status. Fall through to the removal surface instead
        // of answering with advice nobody can act on.
        if (r.code === 'ALREADY_REFINED' && kernel.removeJoint) {
          const r2 = kernel.removeJoint(id, 'human');
          return r2.ok ? `Removed ${r2.removed} from the joint list — ${r2.remaining} joint(s) left.` : `Could not remove: ${r2.error}`;
        }
        return `Could not drop: ${r.error}`;
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

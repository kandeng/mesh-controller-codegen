// Agent workspace — everything the live DSH assistant needs inside its cwd
// (the run dir), written at session create:
//   - AGENTS.md        the persona + debug workflow the agent follows
//   - kernel-cli.mjs   the agent's window into the kernel (validate / rig / state)
//   - TOOLS.md         lab notebook: tools acquired to close capability gaps
//   - web.patch.yml    profile overlay: enable bash, never block on approvals
//   - model.patch.yml  model override (only when not the profile default)
// The DSH web profile ships no MCP client and patches cannot add plugins, so the
// kernel tools ride as a workspace CLI the agent runs through its bash tool.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { slashSection } from './slash-commands.mjs';

const KERNEL_CLI = (port) => `#!/usr/bin/env node
// Workspace CLI: the assistant's window into the mesh-controller kernel.
// Resolves controller paths against THIS workspace (the run dir), so plain
// relative names like controller.js work from the agent's cwd.
import { resolve } from 'node:path';
const BASE = 'http://127.0.0.1:${port}';
const [cmd, ...args] = process.argv.slice(2);
async function j(path, opts) {
  const r = await fetch(BASE + path, opts);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}
const post = (path, body) => j(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
if (cmd === 'validate') {
  const file = resolve(process.cwd(), args[0] || 'controller.js');
  console.log(JSON.stringify(await post('/api/validate', { file }), null, 2));
} else if (cmd === 'rig') {
  console.log(JSON.stringify(await j('/api/joints/' + encodeURIComponent(args[0] || '') + '/rig'), null, 2));
} else if (cmd === 'joints') {
  console.log(JSON.stringify(await j('/api/joints'), null, 2));
} else if (cmd === 'state') {
  console.log(JSON.stringify(await j('/api/state'), null, 2));
} else {
  console.log('usage: node kernel-cli.mjs validate [file] | rig <jointId> | joints | state');
}
`;

const AGENTS_MD = `# Mesh Controller Debugging Assistant

You are the debugging assistant for this mesh-controller-codegen workspace. The
human drives a 3D rigged-mesh viewer elsewhere; you fix the GENERATED CONTROLLER
SCRIPT in this directory (default: controller.js) so the rig animates correctly.

## Your tools
- Read/edit files here with your fs and str-replace-editor tools. This directory
  is your whole writable world; never touch anything outside it.
- \`node kernel-cli.mjs validate [file]\` — run the deterministic tier-0/tier-1
  harness against the loaded mesh. Returns pass/failures/warnings/metrics.
- \`node kernel-cli.mjs rig <jointId>\` — the rig report for one joint: node
  names, parent chain, rest world positions, rotor radius/disc membership, and
  cousin/sibling warnings.
- \`node kernel-cli.mjs joints\` / \`node kernel-cli.mjs state\` — catalog and
  current project state.

## Workflow (repeat until tier-1 passes)
1. Reproduce: \`node kernel-cli.mjs validate\` and read every failure line.
2. Understand the rig BEFORE editing: \`node kernel-cli.mjs rig <jointId>\` for
   each joint the failure mentions. Note the parent chain: in many exports the
   blades are SIBLINGS or COUSINS of the hub, not children.
3. Patch controller.js with str-replace-editor (small, targeted edits).
4. Re-validate. Iterate. Only declare success when validate reports pass=true.

## Hard-won rig rules
- Rotate a rotor assembly about its joint ANCHOR (a pivot Object3D placed at the
  anchor, nodes re-parented with attach()), NEVER by setting rotation on each
  node individually: per-node rotation spins every part about its OWN origin and
  tears blades/locks off the hub.
- Spin only the nodes the rig report places inside the rotor disc; skip any node
  whose subtree reaches outside it (that is the corner node carrying landing
  legs and arms).
- Honour the runtime contract exactly: createDroneController(root, THREE) with
  update(dt), setSpeed, turnLeft/turnRight/goStraight, setGimbal, getState,
  describe. tier-1 asserts idle-stop, rpm growth, diagonal CW/CCW differential,
  gimbal follow, no NaN, rotor-ring centroid and full blade coverage.

## Screenshots
The human may attach a viewer screenshot. It shows ONE selected joint being
driven by the knobs (speed + CCW/CW for rotors). Read it as evidence: parts
floating away from a hub = wrong rotation origin; a static blade at max speed =
node not in the spin set or wrong axis; mirrored/identical diagonal rpm =
differential bug. Translate what you see into a validate-able hypothesis, then
follow the workflow above.

## Capability gaps (standing orders)
When a task needs a capability you do not hold, never give up and never guess —
run this loop:
1. Check TOOLS.md first: an earlier turn may already have installed and
   verified a tool for exactly this capability. Reuse it; skip to step 6.
2. Compose before downloading. Your universal tools (bash, node, python, curl,
   fs + str-replace-editor) cover more than you expect. Example: a .glb file is
   a container — 12-byte header, then chunks of (uint32 length, uint32 type);
   the chunk typed 0x4E4F534A ('JSON') IS the embedded glTF json (nodes,
   skins[].joints, accessors). A ~15-line node script extracts it; no package.
3. Only if composition fails its smoke test, discover a package: query public
   registries with curl — \`curl -s 'https://registry.npmjs.org/-/v1/search?text=<q>'\`
   or \`curl -s https://pypi.org/pypi/<pkg>/json\` — and pick by fit and downloads.
4. Install into THIS directory only (your sandbox), pinned to the version you
   will verify: \`npm install --no-save --prefix . <pkg>@<ver>\` or
   \`pip install --target=./libs <pkg>==<ver>\`. Never install globally.
5. Smoke-test before trusting: minimal invocation on a known sample, asserting
   the output SHAPE (fields present, types right). On failure: next candidate,
   or fall back to your composed script from step 2.
6. Use the verified tool for the real task.
7. Crystallize: keep the wrapper script you wrote (e.g. extract-gltf-json.mjs)
   and append one line to TOOLS.md — capability, wrapper, package@version,
   exact invocation, the assertion that passed. Future turns skip rediscovery.
`;

const TOOLS_MD = `# TOOLS.md — lab notebook of tools acquired in this workspace

Convention (see AGENTS.md "Capability gaps"): before acquiring anything, check
the ledger below and reuse what already passed. When you install or compose a
tool to close a capability gap, keep the wrapper script in this directory and
append one line: capability — wrapper — package@version (or "hand-rolled") —
exact invocation — the smoke-test assertion that passed.

<!-- example line:
- glTF json extraction — extract-gltf-json.mjs — hand-rolled — \`node extract-gltf-json.mjs <file.glb>\` — asserted parsed json has nodes[] and skins[].joints[]
-->
`;

export function writeAgentWorkspace({ runDir, port, model, defaultModel = 'qwen3.8-max' }) {
  writeFileSync(resolve(runDir, 'AGENTS.md'), AGENTS_MD + slashSection());
  writeFileSync(resolve(runDir, 'kernel-cli.mjs'), KERNEL_CLI(port));
  writeFileSync(resolve(runDir, 'TOOLS.md'), TOOLS_MD);

  // Profile overlay: the web profile ships the bash tool disabled. Enable it so
  // the assistant can run kernel-cli.mjs. We deliberately DO NOT touch the
  // approval policy: the permission service composes {sandbox, approval} into an
  // atomic preset, and overriding approval alone (e.g. policy:never over the
  // default workspace-write sandbox) matches NO preset and aborts boot. Instead
  // we keep the valid `workspace-write` preset (agent confined to this run dir,
  // approval=ask) and the supervisor auto-allows each approval request over the
  // host's /api/respond channel — autonomous, but still sandboxed.
  const webPatch = resolve(runDir, 'web.patch.yml');
  writeFileSync(webPatch, [
    '- id: tool-bash',
    '  disabled: false',
    '',
  ].join('\n'));

  let modelPatch = null;
  if (model && model !== defaultModel) {
    modelPatch = resolve(runDir, 'model.patch.yml');
    writeFileSync(modelPatch, `- id: agent-default-model\n  config:\n    provider: bailian\n    model: ${model}\n`);
  }
  return { webPatch, modelPatch };
}

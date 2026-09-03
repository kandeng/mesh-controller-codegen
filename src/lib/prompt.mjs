// Task-prompt builder for the DSH headless codegen run.
// The contract below is the stable ground: the generated module is validated
// and executed against exactly this API (tier1 harness + browser viewer).
import { bladeCandidates } from './gltf.mjs';

// Geometry-derived rotor shortlist: cluster blade candidates by corner and
// list every node sitting at the same corner (hubs/spinners/locks). Pure
// function of the GLB — no hardcoded names — so the tool stays general.
function rotorShortlist(g) {
  const isDup = (n) => /^Object_\d+$/.test(n.name); // mesh child of a named node
  const clusters = [];
  for (const b of bladeCandidates(g)) {
    if (isDup(b)) continue;
    let c = clusters.find((x) => Math.hypot(x.wp[0] - b.wp[0], x.wp[1] - b.wp[1], x.wp[2] - b.wp[2]) < 0.7 * g.radius);
    if (!c) { c = { wp: [...b.wp], n: 1, blades: [], mates: [] }; clusters.push(c); }
    else {
      for (let k = 0; k < 3; k++) c.wp[k] = (c.wp[k] * c.n + b.wp[k]) / (c.n + 1);
      c.n++;
    }
    c.blades.push(b.name);
    for (const n of g.nodes) {
      if (!n.wext || isDup(n)) continue;
      if (Math.hypot(n.wp[0] - b.wp[0], n.wp[1] - b.wp[1], n.wp[2] - b.wp[2]) < 0.45 * g.radius) c.mates.push(n);
    }
  }
  return clusters.map((c, i) => {
    const seen = new Set();
    const mates = c.mates
      .sort((a, b) => Math.hypot(a.wp[0] - c.wp[0], a.wp[1] - c.wp[1]) - Math.hypot(b.wp[0] - c.wp[0], b.wp[1] - c.wp[1]))
      .filter((n) => (seen.has(n.name) ? false : (seen.add(n.name), true)))
      .slice(0, 30)
      .map((n) => n.name);
    return `corner ${i}: blades=[${c.blades.join(', ')}] nodes at this corner (nearest first)=[${mates.join(', ')}]`;
  });
}
export const CONTRACT = `
RUNTIME CONTRACT (fixed — implement exactly this, nothing else public):

export function createDroneController(root, THREE) {
  // root: THREE.Object3D — the loaded glTF scene root. Traverse it to find nodes BY NAME.
  // THREE: the three.js namespace passed in. Use ONLY what it provides for math.
  return {
    update(dtSeconds),            // advance simulation; rotate props/gimbal/body here
    setSpeed(metersPerSecond),    // forward speed command, >= 0
    turnLeft(), turnRight(), goStraight(),
    setGimbal(pitchDeg, yawDeg),  // camera gimbal command, degrees; clamp to sane ranges
    getState(),                   // { speed, headingDeg, props: [{name, rpm}], gimbal: {pitch, yaw} }
    describe(),                   // manifest, see below
  };
}

describe() must return:
{
  propGroups: [ { key: string, spin: +1|-1, names: [node names rotated for this rotor] } ],
  gimbalNames: [joint node names],
  cameraNames: [camera payload node names that must move WITH the gimbal],
  bodyRootName: string|null       // node yawed for turning, if any
}

HARD RULES:
1. ES module, file name exactly controller.mjs in your working directory. No package.json games.
2. No network, no fs, no DOM, no eval, no dynamic import, no process/globalThis. Pure scene-graph math.
3. Top level must be pure definitions (no side effects at import time).
4. Propeller spin: setSpeed(0) means MOTORS OFF — rotors wind down to a complete stop (rpm 0,
   nothing rotates). Rotors spin only while speed > 0: rpm ramps from a hover rpm at low speed
   to a cruise rpm at 10 m/s. getState() must report the true rpm (0 when stopped).
5. Yaw turn = CW/CCW diagonal pair differential (spin +1 pair vs -1 pair), NOT left-vs-right
   (left/right differential produces roll, not yaw).
6. Gimbal joints AND the camera payload must rotate together every frame, even if the glTF
   hierarchy makes them siblings — resolve every part by name and rotate all of them.
7. Propeller assemblies: include EVERY visual part of each rotor (hub, spinner, locks AND the
   blade nodes). Size parts by their WORLD extent (wxy column = local mesh × node matrix/scale;
   the local xy column alone misleads). Blades are the FLAT nodes (wxy z much smaller than x/y)
   out at the rotor ring (r column near the model radius). In Sketchfab-style exports blades are
   often COUSINS of the hub (different sub-parent under the same arm), not children or siblings —
   find them by geometry and position, never by parenthood. Every node of a rotor group must sit
   at the SAME corner (one world-space cluster); never place centre/body nodes in a rotor group.
8. If a named node is missing at construction, console.warn('[drone-controller] missing node: ' + name)
   once and continue without it.
9. All angles internally radians; public API degrees where stated. Ease commands (exp smoothing).
`;

export function buildTask(opts) {
  const { glbPath, stats, dump, failures, humanNotes, prevCode } = opts;
  const parts = [];
  parts.push(`Write a JavaScript ES module that animates a rigged drone GLB in three.js.

GLB file (read it if you need more than the dump below): ${glbPath}
Model facts: ${stats.count} nodes, ${stats.animations} embedded animations, world radius ${stats.radius.toFixed(1)}.
Node dump (index, name, parent, kids, hasMesh, local xy extent, WORLD xyz extent, world radius r from model centre):
${dump}

ROTOR SHORTLIST (computed from this GLB's geometry — start here, verify by eye on the dump):
${rotorShortlist(stats).join('\n')}

Discover the animation targets yourself from the dump and, if needed, by parsing the GLB
(12-byte header, first chunk is JSON): four propeller assemblies (hub + spinner + locks +
BLADES — blades may be siblings of hubs) and the gimbal joint(s) plus the camera payload
(the camera body/lens nodes; often a SIBLING of the gimbal joint, not a child).
WORK BUDGET: the dump above already carries world-space extents (wxy) and the world radius
(r) per node — pick rotor, gimbal and camera nodes DIRECTLY from it (blades = flat wxy at the
rotor ring; hubs/spinners = the small nodes at the same corner; gimbal/camera = the mechanism
and payload nodes near the front-bottom). Spend AT MOST ~15 tool calls on exploration; write
./controller.mjs FIRST, then refine it with your selftest. Only parse the GLB with your own
scripts if the dump is contradictory — never re-derive geometry the dump already gives you.
${CONTRACT}
Deliverable: write the module to ./controller.mjs in your working directory.
Also write ./selftest.mjs: a Node script that builds a mock node tree (plain objects with
name/rotation/parent + traverse) containing exactly the names from your describe() manifest,
imports ./controller.mjs, ticks 120 frames at speed 0 (assert NOTHING rotates and rpm is 0)
and at speed 10 (assert props spin and rpm grows with speed), left/right turns and a gimbal
command, and asserts turn differential mirrors and gimbal converges. Run it with node and fix
failures before finishing.`);

  if (failures?.length || humanNotes) {
    parts.push(`\nREPAIR ROUND — your previous controller.mjs failed automated validation.
Validator failures:
${(failures || []).map((f) => `- ${f}`).join('\n') || '(none)'}
${humanNotes ? `\nHuman visual verification notes (trust these over your assumptions):\n${humanNotes}` : ''}
Previous code:
\`\`\`js
${prevCode || '(unavailable)'}
\`\`\`
Fix the root cause and rewrite ./controller.mjs (keep the contract, keep describe() accurate).`);
  }
  return parts.join('\n');
}

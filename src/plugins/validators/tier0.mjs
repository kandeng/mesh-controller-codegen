// Tier-0 validator plugin: static checks (ESM export present, no require(),
// file parses). Cheap gate before the expensive kinematic tier.
import { definePlugin, CATEGORY } from '../../core/registry.mjs';
import { tier0 } from '../../lib/tier0.mjs';

export const tier0Validator = definePlugin({
  category: CATEGORY.VALIDATOR,
  name: 'tier0',
  version: '1.0.0',
  contributes: { tier: 0, description: 'Static checks: ESM export, no require(), parseable.' },
  api: {
    tier: 0,
    run({ file }) {
      const r = tier0(file);
      return { pass: r.pass, failures: r.pass ? [] : r.problems, warnings: [], metrics: {} };
    },
  },
});

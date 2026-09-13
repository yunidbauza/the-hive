// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The goal-on Stop verifier ships inside the skill as plain Node
 * (`resources/skills/goal-on/scripts/verify-goal.mjs`), because a hook process
 * has no vitest and no TypeScript. Its own suite is `node:test`, ported from
 * claude-kit with the Hive's changes (HIVE-163): the brief under
 * `~/.hive/goals`, and the ledger receipt. This wrapper is what makes
 * `pnpm test` run it.
 */
describe('goal-on verifier', () => {
  it('passes its node:test suite', () => {
    const suite = fileURLToPath(new URL('./test-verify-goal.mjs', import.meta.url));
    /*
      The reporter is pinned. Node 22 printed TAP by default and Node 24 prints
      `spec` (`ℹ pass N`), so an unpinned run passed on one Node and failed on
      the other while the suite itself was green.
    */
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', suite], {
      encoding: 'utf8',
      env: { ...process.env, HIVE_GOALS_DIR: '', HIVE_RECEIVER_URL: '' },
    });

    // `# fail 0` and exit 0 are also what an empty file prints; the pass count
    // is what says the suite ran.
    expect(run.stdout).toMatch(/^# pass [1-9]\d*$/m);
    expect(run.stdout).toMatch(/^# fail 0$/m);
    expect(run.status).toBe(0);
  }, 60_000);
});

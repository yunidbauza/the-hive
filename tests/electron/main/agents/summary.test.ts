// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type {
  AgentRunState,
  AgentsSnapshot,
} from '../../../../electron/shared/agent-contract';
import { mergeRunState } from '../../../../electron/main/agents/summary';

/**
 * R2. The three fields HIVE-115 added to `AgentSummary` had nothing filling
 * them in — a contract that compiles and is never true. These are the
 * assertions that say otherwise.
 */

const snapshot = (): AgentsSnapshot => ({
  agentsRoot: '/tmp/.hive/agents',
  agents: [
    {
      name: 'slack-watcher',
      description: 'Watches #incorp-dev.',
      icon: 'ChatCircleDots',
      status: 'sleeping',
      wake: { on: ['ledger'] },
      rotateAfter: 50,
      runs: [],
    },
    {
      name: 'never-run',
      description: 'Fresh.',
      icon: 'Robot',
      status: 'sleeping',
      wake: { on: [] },
      rotateAfter: 50,
      runs: [],
    },
  ],
});

const state = (over: Partial<AgentRunState> = {}): AgentRunState => ({
  status: 'sleeping',
  runsSinceRotate: 3,
  runs: [],
  ...over,
});

describe('mergeRunState', () => {
  it('fills in the run fields the registry cannot know', () => {
    const merged = mergeRunState(snapshot(), {
      'slack-watcher': state({
        sessionUuid: 'uuid-1',
        lastRunAt: 1_700_000,
        nextRunAt: 1_800_000,
        runs: [
          {
            run: 'r1',
            trigger: 'manual',
            startedAt: 1,
            endedAt: 2,
            outcome: 'done',
            costUsd: 0.0023,
          },
        ],
      }),
    });

    expect(merged.agents[0]).toMatchObject({
      name: 'slack-watcher',
      sessionUuid: 'uuid-1',
      runsSinceRotate: 3,
      lastRunAt: 1_700_000,
      nextRunAt: 1_800_000,
      // Four decimals under a cent: `$0.00` for a real run reads as a bug.
      cost: '$0.0023',
    });
  });

  /**
   * HIVE-116. The `Today` tile is a count and a sum over the day's runs, and
   * the `Session` tile is `runsSinceRotate` over the definition's ceiling.
   * Neither is derivable from the single `cost` HIVE-115 shipped, so the whole
   * history crosses — capped at `AGENT_RUN_HISTORY`, so it is 20 rows at worst.
   */
  it('carries the whole run history, not just the last run’s cost', () => {
    const runs = [
      {
        run: 'r1',
        trigger: 'timer',
        startedAt: 10,
        endedAt: 20,
        outcome: 'done' as const,
        costUsd: 0.004,
      },
      {
        run: 'r2',
        trigger: 'ledger',
        startedAt: 30,
        endedAt: 40,
        outcome: 'asking' as const,
        costUsd: 0.041,
      },
    ];

    const merged = mergeRunState(snapshot(), {
      'slack-watcher': state({ runs }),
    });

    expect(merged.agents[0]?.runs).toEqual(runs);
  });

  it('leaves the rotation ceiling to the definition, never to run state', () => {
    // `rotateAfter` is `limits.rotateAfter` — the registry's to fill, and this
    // join must not invent or overwrite it.
    const merged = mergeRunState(snapshot(), {
      'slack-watcher': state({ runsSinceRotate: 17 }),
    });

    expect(merged.agents[0]?.rotateAfter).toBe(50);
    expect(merged.agents[0]?.runsSinceRotate).toBe(17);
  });

  it('lets the state win on status, because only it has seen a process', () => {
    const merged = mergeRunState(snapshot(), {
      'slack-watcher': state({ status: 'working' }),
    });

    expect(merged.agents[0]?.status).toBe('working');
  });

  it('never lets the state overwrite what the definition says', () => {
    const merged = mergeRunState(snapshot(), {
      'slack-watcher': state({ status: 'asking' }),
    });

    expect(merged.agents[0]).toMatchObject({
      description: 'Watches #incorp-dev.',
      icon: 'ChatCircleDots',
      wake: { on: ['ledger'] },
    });
  });

  it('leaves an agent that has never run exactly as the registry described it', () => {
    const merged = mergeRunState(snapshot(), {
      'slack-watcher': state(),
    });

    expect(merged.agents[1]).toEqual(snapshot().agents[1]);
    expect(merged.agents[1]).not.toHaveProperty('runsSinceRotate');
  });

  it('carries the root through and adds no agents of its own', () => {
    // A state file naming an agent whose folder is gone must not resurrect it
    // as a row — the folder is the list, and this is only a join onto it.
    const merged = mergeRunState(snapshot(), { ghost: state() });

    expect(merged.agentsRoot).toBe('/tmp/.hive/agents');
    expect(merged.agents.map((agent) => agent.name)).toEqual([
      'slack-watcher',
      'never-run',
    ]);
  });

  it('reports the cost of the most recent run, not the first', () => {
    const merged = mergeRunState(snapshot(), {
      'slack-watcher': state({
        runs: [
          {
            run: 'r1',
            trigger: 'manual',
            startedAt: 1,
            endedAt: 2,
            outcome: 'done',
            costUsd: 5,
          },
          {
            run: 'r2',
            trigger: 'manual',
            startedAt: 3,
            endedAt: 4,
            outcome: 'done',
            costUsd: 1.5,
          },
        ],
      }),
    });

    expect(merged.agents[0]?.cost).toBe('$1.50');
  });

  it('omits cost when the last run recorded none', () => {
    const merged = mergeRunState(snapshot(), {
      'slack-watcher': state({
        runs: [
          {
            run: 'r1',
            trigger: 'manual',
            startedAt: 1,
            endedAt: 2,
            outcome: 'failed',
          },
        ],
      }),
    });

    expect(merged.agents[0]).not.toHaveProperty('cost');
  });

  /*
    The two the `Today` and `Next` tiles read (HIVE-121). Both are run state,
    so they travel this route rather than the registry's — and `today` is the
    accumulator rather than a sum over `runs`, which the tile used to compute
    and which stops growing after twenty runs in a day.
  */
  it("carries today's totals and the skip count", () => {
    const merged = mergeRunState(snapshot(), {
      'slack-watcher': state({
        today: { day: '2026-08-31', runs: 12, usd: 0.84 },
        skipsSinceRun: 3,
      }),
    });

    expect(merged.agents[0]).toMatchObject({
      today: { day: '2026-08-31', runs: 12, usd: 0.84 },
      skipsSinceRun: 3,
    });
  });

  it('omits both for an agent that has run but never skipped or spent', () => {
    const merged = mergeRunState(snapshot(), { 'slack-watcher': state() });

    expect(merged.agents[0]).not.toHaveProperty('today');
    expect(merged.agents[0]).not.toHaveProperty('skipsSinceRun');
  });
});

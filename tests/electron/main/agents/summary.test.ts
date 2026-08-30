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
    },
    {
      name: 'never-run',
      description: 'Fresh.',
      icon: 'Robot',
      status: 'sleeping',
      wake: { on: [] },
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
});

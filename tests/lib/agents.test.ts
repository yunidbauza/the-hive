import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_NAME_POOL,
  agentsSnapshot,
  deleteAgent,
  describeSkips,
  frontmatterName,
  loadAgents,
  nextAgentName,
  readAgent,
  renameAgent,
  resetAgents,
  runsToday,
  saveAgent,
  slackSignedOut,
  subscribeAgents,
} from '@/lib/agents';

import {
  AGENT_NAME_PATTERN,
  RESERVED_AGENT_NAMES,
} from '@shared/agent-contract';

import type { AgentsSnapshot } from '@shared/agent-contract';

const snapshot = (names: string[]): AgentsSnapshot => ({
  agents: names.map((name) => ({
    name,
    description: 'watches things',
    icon: 'Ghost',
    status: 'sleeping' as const,
    wake: { on: [] },
    mcp: [],
    tools: [],
    rotateAfter: 50,
    runs: [],
  })),
  agentsRoot: '/home/u/.hive/agents',
});

const stub = (over: Record<string, unknown> = {}) => {
  const bridge = {
    list: vi.fn(async () => snapshot(['slack-watcher'])),
    read: vi.fn(async () => '---\n'),
    write: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async () => ({ ok: true })),
    onChanged: vi.fn(() => () => {}),
    ...over,
  };

  (window as unknown as { hive?: unknown }).hive = { agents: bridge };

  return bridge;
};

beforeEach(() => {
  delete (window as unknown as { hive?: unknown }).hive;
  resetAgents();
  vi.restoreAllMocks();
});

describe('loadAgents', () => {
  it('publishes the snapshot and notifies subscribers', async () => {
    stub();
    const seen = vi.fn();
    subscribeAgents(seen);

    await loadAgents();

    expect(agentsSnapshot()?.agents.map((a) => a.name)).toEqual([
      'slack-watcher',
    ]);
    expect(seen).toHaveBeenCalled();
  });

  it('does nothing without a bridge, which is the browser demo', async () => {
    await loadAgents();

    expect(agentsSnapshot()).toBeNull();
  });

  it('clears the snapshot when the channel itself breaks', async () => {
    stub({
      list: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await loadAgents();

    expect(agentsSnapshot()).toBeNull();
  });
});

describe('saveAgent', () => {
  it('returns ok and re-lists on success', async () => {
    const bridge = stub();

    expect(await saveAgent('slack-watcher', '---\n')).toEqual({ ok: true });
    expect(bridge.list).toHaveBeenCalled();
  });

  it('returns the problems on a refusal, and does not re-list', async () => {
    // A refusal changed nothing on disk, so the snapshot the pane holds is
    // still exactly true — re-reading would only cost a render.
    const problems = [{ field: 'wake.every', reason: 'Cannot be faster than 1m.' }];
    const bridge = stub({ write: vi.fn(async () => ({ ok: false, problems })) });

    expect(await saveAgent('slack-watcher', '---\n')).toEqual({
      ok: false,
      problems,
    });
    expect(bridge.list).not.toHaveBeenCalled();
  });

  it('reports a thrown failure as a value rather than throwing', async () => {
    stub({
      write: vi.fn(async () => {
        throw new Error('disk is full');
      }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await saveAgent('slack-watcher', '---\n');

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problems[0]?.reason).toBe('disk is full');
  });

  it('refuses without a bridge instead of pretending it wrote', async () => {
    const result = await saveAgent('slack-watcher', '---\n');

    expect(result.ok).toBe(false);
  });
});

describe('deleteAgent and renameAgent', () => {
  it('removes and re-lists', async () => {
    const bridge = stub();

    expect(await deleteAgent('slack-watcher')).toEqual({ ok: true });
    expect(bridge.remove).toHaveBeenCalledWith({ name: 'slack-watcher' });
    expect(bridge.list).toHaveBeenCalled();
  });

  it('renames in one call, since main moves folder and name together', async () => {
    const bridge = stub();

    expect(await renameAgent('a', 'b')).toEqual({ ok: true });
    expect(bridge.rename).toHaveBeenCalledWith({ from: 'a', to: 'b' });
  });

  it('does not re-list when a rename is refused', async () => {
    const bridge = stub({
      rename: vi.fn(async () => ({
        ok: false,
        problems: [{ field: 'name', reason: 'b already exists.' }],
      })),
    });

    expect((await renameAgent('a', 'b')).ok).toBe(false);
    expect(bridge.list).not.toHaveBeenCalled();
  });
});

describe('readAgent', () => {
  it('returns the source', async () => {
    stub();

    expect(await readAgent('slack-watcher')).toBe('---\n');
  });

  it('returns null without a bridge', async () => {
    expect(await readAgent('slack-watcher')).toBeNull();
  });
});

describe('frontmatterName', () => {
  it('reads the declared name', () => {
    expect(frontmatterName('---\nname: slack-watcher\n---\nbody\n')).toBe(
      'slack-watcher',
    );
  });

  it('agrees with main about a trailing comment', () => {
    // The whole reason the reader lives in the contract: a simpler local regex
    // here would keep the comment and offer a Save main is certain to refuse.
    expect(frontmatterName('---\nname: watcher   # a note\n---\n')).toBe(
      'watcher',
    );
  });

  it('answers empty for a file with no closing fence', () => {
    expect(frontmatterName('---\nname: watcher\n')).toBe('');
  });

  it('answers empty when no name is declared', () => {
    expect(frontmatterName('---\nicon: Ghost\n---\n')).toBe('');
  });
});

describe('nextAgentName', () => {
  /* Deterministic in place of Math.random: 0 takes the first candidate. */
  const first = () => 0;
  const last = () => 0.999;

  it('draws from the Zerg roster', () => {
    expect(AGENT_NAME_POOL).toContain(nextAgentName([], first));
  });

  it('is lowercase, dashless and legal as a folder name', () => {
    for (const name of AGENT_NAME_POOL) {
      expect(name).toMatch(AGENT_NAME_PATTERN);
    }
  });

  it('keeps overlord, which is not the reserved overmind', () => {
    expect(AGENT_NAME_POOL).toContain('overlord');
    expect(RESERVED_AGENT_NAMES).not.toContain('overlord');
  });

  it('never proposes a reserved name', () => {
    for (const name of AGENT_NAME_POOL) {
      expect(RESERVED_AGENT_NAMES).not.toContain(name);
    }
  });

  /*
    The property that matters more than randomness: drawing blind and numbering
    on collision would offer `drone-2` while ten roster names sat free, which
    reads as the app having run out of names.
  */
  it('prefers a free name over numbering one that is taken', () => {
    const taken = AGENT_NAME_POOL.slice(0, -1);

    expect(nextAgentName(taken, first)).toBe(AGENT_NAME_POOL.at(-1));
  });

  it('numbers from two once the whole roster is held', () => {
    const taken = [...AGENT_NAME_POOL];

    expect(nextAgentName(taken, first)).toBe(`${AGENT_NAME_POOL[0]}-2`);
  });

  it('skips a number already held', () => {
    const taken = [...AGENT_NAME_POOL, `${AGENT_NAME_POOL[0]}-2`];

    expect(nextAgentName(taken, first)).toBe(`${AGENT_NAME_POOL[0]}-3`);
  });

  /* A pick of ~1 must not index past the end of the list. */
  it('stays in range at the top of the draw', () => {
    expect(AGENT_NAME_POOL).toContain(nextAgentName([], last));
  });
});

describe('describeSkips', () => {
  /*
    Silent at zero on purpose. The count answers "why has this done nothing?",
    so the suffix appearing *is* the signal — a permanent `skipped 0` beside
    every healthy agent would be noise where the number should be news.
  */
  it('says nothing when nothing has been skipped', () => {
    expect(describeSkips({ skipsSinceRun: 0 })).toBeUndefined();
  });

  it('names the count once there is one', () => {
    expect(describeSkips({ skipsSinceRun: 3 })).toBe('skipped 3');
  });
});

describe('slackSignedOut', () => {
  const run = (over: Record<string, unknown> = {}) => ({
    run: 'r1',
    trigger: 'interval',
    startedAt: 0,
    endedAt: 1,
    outcome: 'done' as const,
    ...over,
  });

  it('is true when the agent names slack and the last run found it signed out', () => {
    expect(
      slackSignedOut({ mcp: ['slack'], runs: [run({ slack: 'needs-auth' })] }),
    ).toBe(true);
  });

  it('is false when the last run found slack connected', () => {
    expect(
      slackSignedOut({ mcp: ['slack'], runs: [run({ slack: 'connected' })] }),
    ).toBe(false);
  });

  it('is false for a run that never named slack', () => {
    expect(slackSignedOut({ mcp: ['slack'], runs: [run()] })).toBe(false);
  });

  // An agent that has never run must not read as signed out — see the
  // scheduler's own `slackSignedOut`, which the same rule protects.
  it('is false for an agent that has never run', () => {
    expect(slackSignedOut({ mcp: ['slack'], runs: [] })).toBe(false);
  });

  it('reads only the most recent run', () => {
    expect(
      slackSignedOut({
        mcp: ['slack'],
        runs: [run({ slack: 'needs-auth' }), run({ slack: 'connected' })],
      }),
    ).toBe(false);
  });

  /*
    The re-review's finding (HIVE-123): `AgentRunState.runs` is never cleared
    or invalidated when a definition is saved, so a `needs-auth` run followed
    by removing `slack` from `mcp:` leaves a stale reading in `runs` alone.
    The gate has to be the agent's *current* `mcp:` list, not an inference
    from run history — a definition that no longer names slack must read as
    not signed out even with a needs-auth run sitting in its history.
  */
  it('is false once the definition no longer names slack, even with a stale needs-auth run', () => {
    expect(
      slackSignedOut({ mcp: [], runs: [run({ slack: 'needs-auth' })] }),
    ).toBe(false);
  });
});

describe('runsToday', () => {
  /** Local, because the day boundary this reads is the person's own. */
  const noon = new Date(2026, 7, 31, 12).getTime();

  it("reads the accumulator main pushed", () => {
    expect(runsToday({ day: '2026-08-31', runs: 12, usd: 0.84 }, noon)).toEqual({
      count: 12,
      cost: '$0.84',
    });
  });

  /*
    A quiet day is `$0.00`, not blank: this is a fact about spend, and an empty
    cell reads as "not measured" rather than "nothing".
  */
  it('reads a day with no runs as none, not as unmeasured', () => {
    expect(runsToday(undefined, noon)).toEqual({ count: 0, cost: '$0.00' });
  });

  /*
    Yesterday's total is not today's. Main replaces the accumulator on the
    day's first run, so between local midnight and that run the stored key
    names a day that is over — and showing its number would make the tile wrong
    every morning.
  */
  it('ignores a total belonging to a previous day', () => {
    expect(runsToday({ day: '2026-08-30', runs: 9, usd: 9 }, noon)).toEqual({
      count: 0,
      cost: '$0.00',
    });
  });

  /*
    Four decimals for a day that *did* run and cost less than a cent — a wake
    routinely does, and `$0.00` for real work reads as a bug. The two-decimal
    `$0.00` above is reserved for a day on which nothing happened.
  */
  it('keeps four decimals for a day that cost less than a cent', () => {
    expect(runsToday({ day: '2026-08-31', runs: 1, usd: 0.004 }, noon).cost).toBe(
      '$0.0040',
    );
  });
});

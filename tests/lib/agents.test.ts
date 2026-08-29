import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agentsSnapshot,
  deleteAgent,
  frontmatterName,
  loadAgents,
  readAgent,
  renameAgent,
  resetAgents,
  saveAgent,
  subscribeAgents,
} from '@/lib/agents';

import type { AgentsSnapshot } from '@shared/agent-contract';

const snapshot = (names: string[]): AgentsSnapshot => ({
  agents: names.map((name) => ({
    name,
    description: 'watches things',
    icon: 'Ghost',
    status: 'sleeping' as const,
    wake: { on: [] },
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

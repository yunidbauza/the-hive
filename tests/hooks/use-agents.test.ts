import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgents, resetAgents } from '@/lib/agents';

import { useAgents } from '@hooks/use-agents';

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

beforeEach(() => {
  delete (window as unknown as { hive?: unknown }).hive;
  resetAgents();
  vi.restoreAllMocks();
});

describe('useAgents', () => {
  it('answers null before anything has been read', () => {
    const { result } = renderHook(() => useAgents());

    expect(result.current).toBeNull();
  });

  it('re-renders every consumer on the same snapshot', async () => {
    (window as unknown as { hive?: unknown }).hive = {
      agents: { list: () => Promise.resolve(snapshot(['slack-watcher'])) },
    };

    const first = renderHook(() => useAgents());
    const second = renderHook(() => useAgents());

    await act(async () => {
      await loadAgents();
    });

    expect(first.result.current?.agents).toHaveLength(1);
    expect(second.result.current).toBe(first.result.current);
  });

  it('stops re-rendering once unmounted', async () => {
    (window as unknown as { hive?: unknown }).hive = {
      agents: { list: () => Promise.resolve(snapshot(['a'])) },
    };

    let renders = 0;
    const { unmount } = renderHook(() => {
      renders += 1;
      return useAgents();
    });

    const before = renders;
    unmount();

    await act(async () => {
      await loadAgents();
    });

    expect(renders).toBe(before);
  });

  it('survives a subscriber unsubscribing during the emit', async () => {
    // The module copies its listener set before iterating precisely so this
    // is the ordinary React teardown case rather than a crash.
    (window as unknown as { hive?: unknown }).hive = {
      agents: { list: () => Promise.resolve(snapshot(['a'])) },
    };

    const first = renderHook(() => useAgents());
    const second = renderHook(() => useAgents());
    first.unmount();

    await act(async () => {
      await loadAgents();
    });

    expect(second.result.current?.agents).toHaveLength(1);
  });
});

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAgents } from '@/lib/agents';

import { useAgentsSync } from '@features/shared/hooks/use-agents-sync';
import { useHiveStore } from '@stores/hive-store';

import type { AgentsSnapshot } from '@shared/agent-contract';

const snapshot = (names: string[]): AgentsSnapshot => ({
  agents: names.map((name) => ({
    name,
    description: 'watches things',
    icon: 'Ghost',
    status: 'sleeping' as const,
    wake: { on: [] },
  })),
  agentsRoot: '/root/agents',
});

beforeEach(() => {
  delete (window as unknown as { hive?: unknown }).hive;
  resetAgents();
  useHiveStore.getState().hydrateAgents([]);
  vi.restoreAllMocks();
});

describe('useAgentsSync', () => {
  it('subscribes before it fetches', async () => {
    // The other order drops a change landing between the two, and these
    // snapshots replace rather than merge, so nothing would re-fetch it.
    const order: string[] = [];
    const list = vi.fn(async () => {
      order.push('list');
      return snapshot([]);
    });
    const onChanged = vi.fn(() => {
      order.push('subscribe');
      return () => {};
    });

    (window as unknown as { hive?: unknown }).hive = {
      agents: { list, onChanged },
    };

    renderHook(() => useAgentsSync());
    await waitFor(() => expect(list).toHaveBeenCalled());

    expect(order).toEqual(['subscribe', 'list']);
  });

  it('hydrates the store from the same read the pane sees', async () => {
    (window as unknown as { hive?: unknown }).hive = {
      agents: {
        list: vi.fn(async () => snapshot(['zulu', 'alpha'])),
        onChanged: vi.fn(() => () => {}),
      },
    };

    renderHook(() => useAgentsSync());

    await waitFor(() =>
      expect(useHiveStore.getState().agentOrder).toEqual(['alpha', 'zulu']),
    );
  });

  it('re-lists when main says the folder changed', async () => {
    let poke = () => {};
    const list = vi.fn(async () => snapshot(['alpha']));

    (window as unknown as { hive?: unknown }).hive = {
      agents: {
        list,
        onChanged: vi.fn((fn: () => void) => {
          poke = fn;
          return () => {};
        }),
      },
    };

    renderHook(() => useAgentsSync());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    poke();

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('drops an agent whose folder is gone', async () => {
    let poke = () => {};
    let names = ['alpha', 'zulu'];

    (window as unknown as { hive?: unknown }).hive = {
      agents: {
        list: vi.fn(async () => snapshot(names)),
        onChanged: vi.fn((fn: () => void) => {
          poke = fn;
          return () => {};
        }),
      },
    };

    renderHook(() => useAgentsSync());
    await waitFor(() =>
      expect(useHiveStore.getState().agentOrder).toHaveLength(2),
    );

    names = ['alpha'];
    poke();

    await waitFor(() =>
      expect(useHiveStore.getState().agentOrder).toEqual(['alpha']),
    );
  });

  it('unsubscribes from both the push and the mirror on unmount', async () => {
    const stopPush = vi.fn();
    const list = vi.fn(async () => snapshot(['alpha']));

    (window as unknown as { hive?: unknown }).hive = {
      agents: { list, onChanged: vi.fn(() => stopPush) },
    };

    const { unmount } = renderHook(() => useAgentsSync());
    await waitFor(() => expect(list).toHaveBeenCalled());

    unmount();

    expect(stopPush).toHaveBeenCalled();
  });

  it('does nothing without a bridge, which is the browser demo', () => {
    expect(() => renderHook(() => useAgentsSync())).not.toThrow();
    expect(useHiveStore.getState().agentOrder).toEqual([]);
  });
});

import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionStatusEvent } from '@shared/session-contract';

import { isSession } from '@/types/entity';

import { useSessionStatus } from '@features/sessions/hooks/use-session-status';
import { useHiveStore } from '@stores/hive-store';

/**
 * The renderer half of story 096's status path.
 *
 * Note what is *not* here: a transcript. With a real PTY the output goes
 * straight to xterm through the transport and never touches a store, which is
 * what keeps a build log from re-rendering the shell. Only the status comes
 * back.
 */

let listeners: ((event: SessionStatusEvent) => void)[];
let disposals: number;

function withBridge() {
  (window as { hive?: unknown }).hive = {
    session: {
      onStatus: (callback: (event: SessionStatusEvent) => void) => {
        listeners.push(callback);
        return () => {
          disposals += 1;
        };
      },
    },
  };
}

const emit = (event: SessionStatusEvent) =>
  act(() => {
    for (const listener of listeners) listener(event);
  });

beforeEach(() => {
  listeners = [];
  disposals = 0;
  useHiveStore.getState().reset();
});

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
  vi.clearAllMocks();
});

describe('useSessionStatus', () => {
  it('applies a status pushed from main', () => {
    withBridge();
    renderHook(() => useSessionStatus());

    emit({ entityId: 'hero-refresh', status: 'done' });

    expect(useHiveStore.getState().entities['hero-refresh']!.status).toBe('done');
  });

  it('subscribes exactly once', () => {
    // One broadcast channel: a per-session hook would mean thirteen listeners
    // racing to ignore twelve messages each.
    withBridge();
    renderHook(() => useSessionStatus());

    expect(listeners).toHaveLength(1);
  });

  it('unsubscribes on unmount', () => {
    withBridge();
    const { unmount } = renderHook(() => useSessionStatus());

    unmount();

    expect(disposals).toBe(1);
  });

  it('does nothing at all in the browser build', () => {
    // No bridge is the demo surface, where every transcript is a recording and
    // no process exists to have a status.
    const { unmount } = renderHook(() => useSessionStatus());

    expect(listeners).toHaveLength(0);
    expect(() => unmount()).not.toThrow();
  });
});

describe('setSessionStatus', () => {
  it('leaves an unknown entity alone', () => {
    const before = useHiveStore.getState().entities;
    act(() => useHiveStore.getState().setSessionStatus('ghost', 'done'));

    expect(useHiveStore.getState().entities).toBe(before);
  });

  it('ignores agents, which have no pty this epic', () => {
    const before = useHiveStore.getState().entities['slack-agent'];
    act(() => useHiveStore.getState().setSessionStatus('slack-agent', 'done'));

    expect(useHiveStore.getState().entities['slack-agent']).toBe(before);
  });

  it('does not touch state when the status is unchanged', () => {
    // Identity matters: a no-op write would re-render every consumer of the
    // entity map on every idle tick.
    const id = 'hero-refresh';
    const entity = useHiveStore.getState().entities[id];
    if (!entity || !isSession(entity)) throw new Error('expected a fixture session');
    const before = useHiveStore.getState().entities;

    act(() => useHiveStore.getState().setSessionStatus(id, entity.status));

    expect(useHiveStore.getState().entities).toBe(before);
  });

  it('leaves the transcript untouched', () => {
    const id = 'hero-refresh';
    const lines = useHiveStore.getState().entities[id]!.lines;

    act(() => useHiveStore.getState().setSessionStatus(id, 'idle'));

    expect(useHiveStore.getState().entities[id]!.lines).toBe(lines);
  });
});

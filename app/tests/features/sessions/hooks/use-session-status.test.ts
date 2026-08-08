import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  SessionClearedEvent,
  SessionNameEvent,
  SessionStatusEvent,
} from '@shared/session-contract';

import { isSession } from '@/types/entity';

import { useSessionStatus } from '@features/sessions/hooks/use-session-status';
import { useHiveStore } from '@stores/hive-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

/**
 * The renderer half of story 096's status path.
 *
 * Note what is *not* here: a transcript. With a real PTY the output goes
 * straight to xterm through the transport and never touches a store, which is
 * what keeps a build log from re-rendering the shell. Only the status comes
 * back.
 */

let listeners: ((event: SessionStatusEvent) => void)[];
let nameListeners: ((event: SessionNameEvent) => void)[];
let clearedListeners: ((event: SessionClearedEvent) => void)[];
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
      onName: (callback: (event: SessionNameEvent) => void) => {
        nameListeners.push(callback);
        return () => {
          disposals += 1;
        };
      },
      onCleared: (callback: (event: SessionClearedEvent) => void) => {
        clearedListeners.push(callback);
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

const emitName = (event: SessionNameEvent) =>
  act(() => {
    for (const listener of nameListeners) listener(event);
  });

beforeEach(() => {
  listeners = [];
  nameListeners = [];
  clearedListeners = [];
  disposals = 0;
  useHiveStore.getState().reset();
    seedDemoFleet();
});

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
  vi.clearAllMocks();
});

describe('useSessionStatus', () => {
  it('applies a status pushed from main', () => {
    withBridge();
    renderHook(() => useSessionStatus());

    // `terminated` is the ending main can actually observe — a pty exited.
    // `done` is a judgement about the work and is not main's to make (108).
    emit({ entityId: 'hero-refresh', status: 'terminated' });

    expect(useHiveStore.getState().entities['hero-refresh']!.status).toBe(
      'terminated',
    );
  });

  it('subscribes exactly once', () => {
    // One broadcast channel: a per-session hook would mean thirteen listeners
    // racing to ignore twelve messages each.
    withBridge();
    renderHook(() => useSessionStatus());

    expect(listeners).toHaveLength(1);
  });

  it('unsubscribes every channel on unmount', () => {
    withBridge();
    const { unmount } = renderHook(() => useSessionStatus());

    unmount();

    // Status, name (HIVE-61) and cleared — a leaked listener on any of the
    // three would keep writing to a store the unmounted shell no longer
    // renders, and the cleared one would go on minting sessions.
    expect(disposals).toBe(3);
  });

  it('applies a rename pushed from main', () => {
    /**
     * The pull half of HIVE-61: the name came off the agent's terminal title,
     * so a `/rename` inside Claude renames the row in the fleet view.
     */
    withBridge();
    renderHook(() => useSessionStatus());

    emitName({ entityId: 'hero-refresh', name: 'fix the login bug' });

    const entity = useHiveStore.getState().entities['hero-refresh'];
    if (!entity || !isSession(entity)) throw new Error('expected a fixture session');
    expect(entity.name).toBe('fix the login bug');
  });

  it('subscribes to names exactly once', () => {
    withBridge();
    renderHook(() => useSessionStatus());

    expect(nameListeners).toHaveLength(1);
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

describe('renameSession', () => {
  it('leaves an unknown entity alone', () => {
    const before = useHiveStore.getState().entities;
    act(() => useHiveStore.getState().renameSession('ghost', 'whatever'));

    expect(useHiveStore.getState().entities).toBe(before);
  });

  it('ignores agents, which have no agent-set name', () => {
    const before = useHiveStore.getState().entities['slack-agent'];
    act(() => useHiveStore.getState().renameSession('slack-agent', 'nope'));

    expect(useHiveStore.getState().entities['slack-agent']).toBe(before);
  });

  it('does not touch state when the name is unchanged', () => {
    /**
     * Claude re-emits its title on repaint, so an unchanged name arrives
     * constantly. A write per repaint would re-render every consumer of the
     * entity map for a value that did not move.
     */
    const id = 'hero-refresh';
    act(() => useHiveStore.getState().renameSession(id, 'steady'));
    const before = useHiveStore.getState().entities;

    act(() => useHiveStore.getState().renameSession(id, 'steady'));

    expect(useHiveStore.getState().entities).toBe(before);
  });

  it('accepts a name the command line would refuse', () => {
    /**
     * The `--name` pattern governs what the app is willing to *send*. A name
     * read back off a terminal title is only ever rendered, so a sentence a
     * user typed into `/rename` must survive intact.
     */
    const id = 'hero-refresh';
    act(() => useHiveStore.getState().renameSession(id, 'fix "login" & logout'));

    const entity = useHiveStore.getState().entities[id];
    if (!entity || !isSession(entity)) throw new Error('expected a fixture session');
    expect(entity.name).toBe('fix "login" & logout');
  });

  it('leaves the id and branch alone', () => {
    // A name is a label; the id is an identity, and rekeying on a rename would
    // strand every reference to the session.
    const id = 'hero-refresh';
    const before = useHiveStore.getState().entities[id];
    if (!before || !isSession(before)) throw new Error('expected a fixture session');

    act(() => useHiveStore.getState().renameSession(id, 'renamed'));

    const after = useHiveStore.getState().entities[id];
    if (!after || !isSession(after)) throw new Error('expected a fixture session');
    expect(after.id).toBe(id);
    expect(after.branch).toBe(before.branch);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/types/entity';
import { useHiveStore } from '@stores/hive-store';

/**
 * The boot flag (HIVE-101).
 *
 * `booting` is deliberately **not** a `SessionStatus`: a starting session is
 * `working` by every measure a pty can take — output is pouring out of it —
 * which is exactly the reading that made the first seconds of every session
 * look like work. It is a fact about what is on *screen*.
 *
 * The store is `isDesktop()`-sensitive here, because the browser demo has no
 * process to boot and no `SessionStart` will ever arrive to uncover it. That is
 * mocked rather than worked around: a cover nothing can lift is precisely the
 * trap this feature had to avoid.
 */
vi.mock('@config/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@config/runtime')>();
  return { ...actual, isDesktop: () => true };
});

const state = () => useHiveStore.getState();
const sessionAt = (id: string) => state().entities[id] as Session;

describe('the boot flag', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
  });

  it('covers a session from the moment it is asked for', () => {
    /*
      Set at spawn rather than when the pty reports anything, because the wait
      this hides *starts* here: the shell is already loading `direnv` before
      main has finished answering.
    */
    const id = state().spawnSession('apfm-web');

    expect(sessionAt(id).booting).toBe(true);
  });

  it('uncovers it when Claude reports itself up', () => {
    const id = state().spawnSession('apfm-web');

    state().markSessionReady(id);

    expect(sessionAt(id).booting).toBeUndefined();
  });

  /**
   * `/clear` starts a second Claude session inside the same pty and produces
   * another `SessionStart`, so this arrives more than once. A session that is
   * already uncovered cannot be uncovered harder.
   */
  it('tolerates being told twice', () => {
    const id = state().spawnSession('apfm-web');
    state().markSessionReady(id);
    const after = state().entities;

    state().markSessionReady(id);

    // Same map object: a duplicate report must not re-render the fleet.
    expect(state().entities).toBe(after);
  });

  it('does nothing for an id the store has never heard of', () => {
    const before = state().entities;

    state().markSessionReady('sess-nope');

    expect(state().entities).toBe(before);
  });

  it('does nothing for an agent', () => {
    const before = state().entities;

    state().markSessionReady('slack-agent');

    expect(state().entities).toBe(before);
  });

  /**
   * The field is absent rather than `false` once it lifts. Every surface asks
   * `booting === true`, and an explicit `false` is a different object shape
   * from an absent key — which these snapshots are compared on.
   */
  it('removes the key rather than setting it false', () => {
    const id = state().spawnSession('apfm-web');
    state().markSessionReady(id);

    expect('booting' in sessionAt(id)).toBe(false);
  });
});

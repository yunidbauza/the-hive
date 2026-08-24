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

/**
 * The escape for a boot that stopped to ask the user something (HIVE-103).
 *
 * A session opened in a folder Claude Code has not been trusted with never
 * starts: it draws a trust prompt on the shell's own screen and waits. No
 * `SessionStart` ever fires, so before this the only ways out were a keystroke
 * or the sixty-second timeout — and the question was behind the cover the whole
 * time.
 *
 * Nothing new observes it. Main's activity tracker already reports `idle` after
 * two seconds of pty silence, and a boot that has gone quiet is a boot with
 * nothing left to hide.
 */
describe('the boot flag — a boot that goes quiet', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
  });

  /** Spawned, then reported working the way a shell's own output makes it. */
  const booting = (task?: string) => {
    const id = state().spawnSession('apfm-web', task);
    state().setSessionStatus(id, 'working');
    expect(sessionAt(id).booting).toBe(true);
    return id;
  };

  it('uncovers a session whose output stopped', () => {
    const id = booting();

    // What main sends after two seconds of silence — the trust prompt, drawn
    // and waiting.
    state().setSessionStatus(id, 'idle');

    expect(sessionAt(id).booting).toBeUndefined();
  });

  it('keeps covering a session that is still producing output', () => {
    // The whole point of the cover. `direnv`, a package manager and the echoed
    // command line are all `working`, and none of them is worth watching.
    const id = booting();

    state().setSessionStatus(id, 'working');

    expect(sessionAt(id).booting).toBe(true);
  });

  it('uncovers a session that is asking for permission', () => {
    // `waiting` comes from a hook, so Claude is up — but the reason it matters
    // is the same one: something on that screen wants the user.
    const id = booting();

    state().setSessionStatus(id, 'waiting');

    expect(sessionAt(id).booting).toBeUndefined();
  });

  it('uncovers a session whose process died before Claude started', () => {
    /*
      Otherwise the cover outlives the terminal it covers, and the explanation —
      `claude: command not found`, an expired login — sits underneath it for a
      minute. That is the failure mode the timeout exists for, reached here in
      two seconds instead.
    */
    const id = booting();

    state().setSessionStatus(id, 'terminated');

    expect(sessionAt(id).booting).toBeUndefined();
  });

  it('lifts the cover even when the status did not change', () => {
    /**
     * The guard that makes the rule unconditional.
     *
     * An unchanged status is normally a write to drop — Claude repaints
     * continuously, and a store write per repaint would re-render the fleet.
     * But a session spawned with no task starts `idle`, so a repeat `idle` is
     * both "no change" and "the cover must lift", and dropping it would leave a
     * cover nothing could ever remove.
     */
    const id = state().spawnSession('apfm-web');
    expect(sessionAt(id).status).toBe('idle');

    state().setSessionStatus(id, 'idle');

    expect(sessionAt(id).booting).toBeUndefined();
  });

  it('still drops an unchanged status once there is no cover to lift', () => {
    // The other half of that guard: with `booting` gone, a repeated status is
    // the no-op it has always been, and `entities` keeps its identity.
    const id = booting();
    state().setSessionStatus(id, 'idle');

    const before = state().entities;
    state().setSessionStatus(id, 'idle');

    expect(state().entities).toBe(before);
  });

  it('removes the key rather than setting it false', () => {
    // The same shape `markSessionReady` leaves behind; these snapshots are
    // compared on keys, not values.
    const id = booting();

    state().setSessionStatus(id, 'idle');

    expect('booting' in sessionAt(id)).toBe(false);
  });
});

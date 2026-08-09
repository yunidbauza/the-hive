import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHiveStore } from '@stores/hive-store';
import type { GhErrorKind, GhResult, PrsSnapshot } from '@shared/github-contract';

import { prRecord } from '@tests/support/prs';

/**
 * `refreshPrs`.
 *
 * The decision tree between "what GitHub said" and "what the panel shows".
 * `lib/github` is mocked because the verb itself has its own suite; what is
 * under test here is which of the three actions each answer produces — and, in
 * particular, that a failed sweep does not blank a list the user is reading.
 */

const readPullRequests = vi.fn<() => Promise<GhResult<PrsSnapshot> | null>>();

vi.mock('@/lib/github', () => ({
  readPullRequests: () => readPullRequests(),
}));

const ok = (snapshot: Partial<PrsSnapshot> = {}): GhResult<PrsSnapshot> => ({
  ok: true,
  value: { prs: [prRecord()], repos: 2, ...snapshot },
});

const refused = (kind: GhErrorKind): GhResult<PrsSnapshot> => ({
  ok: false,
  error: { kind, message: `it went ${kind}` },
});

beforeEach(() => {
  useHiveStore.getState().reset();
  readPullRequests.mockReset();
  // The desktop target is `window.hive` being present — feature-detect the
  // bridge, never the user agent.
  window.hive = {} as unknown as Window['hive'];
});

afterEach(() => {
  delete window.hive;
  useHiveStore.getState().reset();
});

describe('refreshPrs', () => {
  it('installs the sweep and records how many repos it covered', async () => {
    readPullRequests.mockResolvedValue(ok());

    await useHiveStore.getState().refreshPrs();

    const state = useHiveStore.getState();
    expect(state.prs).toHaveLength(1);
    expect(state.prSource).toEqual({ kind: 'live', stale: false, repos: 2 });
  });

  /**
   * The browser preview has no bridge, so it has no `gh` — a configuration
   * answer, not a failure, and it settles rather than spinning forever.
   */
  it('settles on unconfigured in the browser target', async () => {
    delete window.hive;

    await useHiveStore.getState().refreshPrs();

    expect(useHiveStore.getState().prSource).toEqual({
      kind: 'unconfigured',
      message: 'Pull requests need the desktop app — this is the browser preview.',
    });
    expect(readPullRequests).not.toHaveBeenCalled();
  });

  /**
   * Three of the seven error kinds are configuration, not failure — they are
   * what the panel explains rather than what it apologises for.
   */
  it.each(['not-installed', 'unauthenticated', 'no-repos'] as const)(
    'reads %s as unconfigured',
    async (kind) => {
      readPullRequests.mockResolvedValue(refused(kind));

      await useHiveStore.getState().refreshPrs();

      expect(useHiveStore.getState().prSource).toEqual({
        kind: 'unconfigured',
        message: `it went ${kind}`,
      });
    },
  );

  it.each(['offline', 'timeout', 'rate-limited', 'unknown'] as const)(
    'reads %s as a failure',
    async (kind) => {
      readPullRequests.mockResolvedValue(refused(kind));

      await useHiveStore.getState().refreshPrs();

      expect(useHiveStore.getState().prSource).toEqual({
        kind: 'failed',
        message: `it went ${kind}`,
      });
    },
  );

  it('reports a dead channel as a failure', async () => {
    readPullRequests.mockResolvedValue(null);

    await useHiveStore.getState().refreshPrs();

    expect(useHiveStore.getState().prSource).toEqual({
      kind: 'failed',
      message: 'The app could not reach its own main process.',
    });
  });

  /**
   * **Staleness over emptiness**, and it matters more here than for tickets: the
   * sweep runs every minute, so one flaky minute would otherwise blank a panel
   * the user is looking at and fill it again sixty seconds later.
   */
  it('keeps a live list and marks it stale when a later sweep fails', async () => {
    readPullRequests.mockResolvedValue(ok());
    await useHiveStore.getState().refreshPrs();

    readPullRequests.mockResolvedValue(refused('offline'));
    await useHiveStore.getState().refreshPrs();

    const state = useHiveStore.getState();
    expect(state.prs).toHaveLength(1);
    expect(state.prSource).toEqual({ kind: 'live', stale: true, repos: 2 });
  });

  /** An unconfigured machine clears the list: those rows describe a setup that is gone. */
  it('clears the list when the machine becomes unconfigured', async () => {
    readPullRequests.mockResolvedValue(ok());
    await useHiveStore.getState().refreshPrs();

    readPullRequests.mockResolvedValue(refused('no-repos'));
    await useHiveStore.getState().refreshPrs();

    expect(useHiveStore.getState().prs).toEqual([]);
  });

  /**
   * A refresh over a live list must not flash a skeleton. Nothing sets
   * `loading` after boot at all, so this holds for a successful sweep that
   * matched nothing too — an empty `live` answer keeps saying so.
   */
  it('does not return a live source to loading mid-refresh', async () => {
    readPullRequests.mockResolvedValue(ok());
    await useHiveStore.getState().refreshPrs();

    const seen: string[] = [];
    readPullRequests.mockImplementation(() => {
      seen.push(useHiveStore.getState().prSource.kind);
      return Promise.resolve(ok());
    });

    await useHiveStore.getState().refreshPrs();

    expect(seen).toEqual(['live']);
  });

  it('announces the first read with loading', async () => {
    const seen: string[] = [];
    readPullRequests.mockImplementation(() => {
      seen.push(useHiveStore.getState().prSource.kind);
      return Promise.resolve(ok());
    });

    await useHiveStore.getState().refreshPrs();

    expect(seen).toEqual(['loading']);
  });

  /**
   * The flicker this used to cause, once a minute, on the two states that most
   * need to stay readable.
   *
   * An earlier version set `loading` on every sweep that was not already
   * `live`. On an unconfigured machine — or a failed one, where the panel is
   * showing a "Try again" button — the poll replaced the explanation with a
   * skeleton for the duration of the sweep, up to twenty seconds of every
   * sixty. The button the user was reaching for did not exist for a third of
   * each minute.
   */
  it.each(['unconfigured', 'failed'] as const)(
    'does not flip a %s panel back to a skeleton on the next poll',
    async (kind) => {
      readPullRequests.mockResolvedValue(
        refused(kind === 'unconfigured' ? 'no-repos' : 'offline'),
      );
      await useHiveStore.getState().refreshPrs();
      expect(useHiveStore.getState().prSource.kind).toBe(kind);

      const seen: string[] = [];
      readPullRequests.mockImplementation(() => {
        seen.push(useHiveStore.getState().prSource.kind);
        return Promise.resolve(ok());
      });

      await useHiveStore.getState().refreshPrs();

      expect(seen).toEqual([kind]);
    },
  );

  /**
   * "Try again" calls this directly while the poller may have a sweep out.
   *
   * Two concurrent sweeps are two `gh` processes, and the harm is specific: if
   * the retry answered first and the older sweep then timed out, the failure
   * path would mark the just-installed fresh list stale — a "may be out of
   * date" banner over data a second old.
   */
  it('shares one sweep between concurrent callers', async () => {
    let release: ((value: GhResult<PrsSnapshot>) => void) | undefined;
    readPullRequests.mockImplementation(
      () =>
        new Promise<GhResult<PrsSnapshot>>((resolve) => {
          release = resolve;
        }),
    );

    const store = useHiveStore.getState();
    const first = store.refreshPrs();
    const second = store.refreshPrs();

    expect(readPullRequests).toHaveBeenCalledTimes(1);

    release?.(ok());
    await Promise.all([first, second]);

    expect(useHiveStore.getState().prSource).toEqual({
      kind: 'live',
      stale: false,
      repos: 2,
    });
  });

  it('starts a fresh sweep once the previous one has settled', async () => {
    readPullRequests.mockResolvedValue(ok());

    await useHiveStore.getState().refreshPrs();
    await useHiveStore.getState().refreshPrs();

    expect(readPullRequests).toHaveBeenCalledTimes(2);
  });

  /** An empty sweep is an answer, and it stays an answer across refreshes. */
  it('keeps an empty live result live rather than treating it as nothing yet', async () => {
    readPullRequests.mockResolvedValue(ok({ prs: [] }));
    await useHiveStore.getState().refreshPrs();

    const seen: string[] = [];
    readPullRequests.mockImplementation(() => {
      seen.push(useHiveStore.getState().prSource.kind);
      return Promise.resolve(ok({ prs: [] }));
    });

    await useHiveStore.getState().refreshPrs();

    expect(seen).toEqual(['live']);
  });
});

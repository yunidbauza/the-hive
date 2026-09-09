import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LATE_BIND_RETRY_MS,
  useAttachedServer,
  useReceiverExposure,
  useServerExposure,
  useServing,
  useServingDeviceCount,
} from '@hooks/use-project-config';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import {
  DEFAULT_BIND,
  DEFAULT_RECEIVER,
  emptySnapshot,
  type ConfigSnapshot,
  type ReceiverBindConfig,
} from '@shared/config-contract';
import type { AppInfo } from '@shared/ipc-contract';

const CONFIG_PATH = '/Users/dev/.hive/config.json';

const readAppInfo = vi.fn();

/**
 * The bridge is mocked at the `@lib/project-config` seam, the same boundary
 * `advanced-section.test.tsx` fakes for the same reason: components (and the
 * hooks they call) never reach `window.hive` directly, so that is the only
 * seam worth faking.
 */
vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return {
    ...actual,
    readAppInfo: () => readAppInfo(),
  };
});

/**
 * A full snapshot with only `receiver.bind` overridden — `emptySnapshot`
 * already fills in `receiver` from `DEFAULT_RECEIVER`, so this only needs to
 * name the one field each test cares about, exactly like every other
 * `@lib/project-config` spec.
 */
function snapshot(bind: Partial<ReceiverBindConfig>): ConfigSnapshot {
  return {
    ...emptySnapshot(CONFIG_PATH),
    receiver: { ...DEFAULT_RECEIVER, bind: { ...DEFAULT_BIND, ...bind } },
  };
}

const info = (receiverBoundHost: string | null): AppInfo => ({
  version: '0.1.0',
  electron: '38.0.0',
  chrome: '140.0.0',
  node: '22.0.0',
  platform: 'darwin',
  logPath: '/Users/dev/Library/Logs/The Hive',
  receiverBoundHost,
  serverBoundHost: null,
  servingDeviceCount: 0,
  attachedServerName: null,
  serving: false,
});

/** Same shape as {@link info}, but for `useServerExposure`'s field instead. */
const serverInfo = (serverBoundHost: string | null): AppInfo => ({
  version: '0.1.0',
  electron: '38.0.0',
  chrome: '140.0.0',
  node: '22.0.0',
  platform: 'darwin',
  logPath: '/Users/dev/Library/Logs/The Hive',
  receiverBoundHost: null,
  serverBoundHost,
  servingDeviceCount: 0,
  attachedServerName: null,
  serving: false,
});

/** Same shape as {@link info}, but for `useServingDeviceCount`'s field. */
const deviceCountInfo = (servingDeviceCount: number): AppInfo => ({
  version: '0.1.0',
  electron: '38.0.0',
  chrome: '140.0.0',
  node: '22.0.0',
  platform: 'darwin',
  logPath: '/Users/dev/Library/Logs/The Hive',
  receiverBoundHost: null,
  serverBoundHost: null,
  servingDeviceCount,
  attachedServerName: null,
  serving: false,
});

/** Same shape as {@link info}, but for `useAttachedServer`'s field. */
const attachedInfo = (attachedServerName: string | null): AppInfo => ({
  version: '0.1.0',
  electron: '38.0.0',
  chrome: '140.0.0',
  node: '22.0.0',
  platform: 'darwin',
  logPath: '/Users/dev/Library/Logs/The Hive',
  receiverBoundHost: null,
  serverBoundHost: null,
  servingDeviceCount: 0,
  attachedServerName,
  serving: false,
});

/**
 * Renders the hook and waits for the mounted effect's async `readAppInfo`
 * round-trip to settle and commit, then asserts the value it landed on.
 *
 * `waitFor` rather than a fixed number of flushed microtask ticks: it polls
 * with real timers until the assertion holds or the default timeout expires,
 * so it genuinely waits out the fetch instead of coincidentally matching a
 * pre-fetch initial state — the failure mode a `null`-expecting assertion
 * would otherwise risk, since the hook also starts at `null` before it has
 * fetched anything. Asserting the call happened *first* forces every case,
 * `null`-expecting ones included, to wait past the point where a broken hook
 * that never read `AppInfo` at all would already have satisfied the check.
 */
async function renderValue(expected: string | null): Promise<string | null> {
  const { result } = renderHook(() => useReceiverExposure());
  await waitFor(() => {
    expect(readAppInfo).toHaveBeenCalled();
    expect(result.current).toBe(expected);
  });
  return result.current;
}

/** Same shape as {@link renderValue}, but for `useServerExposure`. */
async function renderServerValue(expected: string | null): Promise<string | null> {
  const { result } = renderHook(() => useServerExposure());
  await waitFor(() => {
    expect(readAppInfo).toHaveBeenCalled();
    expect(result.current).toBe(expected);
  });
  return result.current;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  resetProjectConfig();
});

/**
 * `useReceiverExposure` (HIVE-134).
 *
 * Sourced from the receiver's **running** bind (`AppInfo.receiverBoundHost`),
 * never from `snapshot.receiver.bind.host` — that field says what will be
 * bound at the *next* launch, and a listening socket cannot be moved to match
 * it mid-session. `isLoopbackHost` is still the one definition of "exposed",
 * proven here rather than re-derived: the whole `127.0.0.0/8` block reads as
 * not-exposed, not only the canonical `127.0.0.1`.
 */
describe('useReceiverExposure', () => {
  it('is null when the running bind is loopback', async () => {
    setProjectConfigForTest(snapshot({ host: '127.0.0.1' }));
    readAppInfo.mockResolvedValue(info('127.0.0.1'));
    expect(await renderValue(null)).toBeNull();
  });

  it('is null anywhere in 127.0.0.0/8', async () => {
    setProjectConfigForTest(snapshot({ host: '127.0.0.1' }));
    readAppInfo.mockResolvedValue(info('127.0.0.2'));
    expect(await renderValue(null)).toBeNull();
  });

  it('is the address when the running bind is widened', async () => {
    setProjectConfigForTest(snapshot({ host: '172.17.0.1' }));
    readAppInfo.mockResolvedValue(info('172.17.0.1'));
    expect(await renderValue('172.17.0.1')).toBe('172.17.0.1');
  });

  /*
   * The point of this story: a failed bind — a sandbox, a firewall, a busy
   * port — means nothing is listening, so nothing is exposed, even though a
   * config-derived chip would still see a non-loopback `bind.host` and claim
   * otherwise (`receiver.ts`'s "why a failure to bind is not an error").
   */
  it('is null when nothing is listening, even with a widened configured bind', async () => {
    setProjectConfigForTest(snapshot({ host: '172.17.0.1' }));
    readAppInfo.mockResolvedValue(info(null));
    expect(await renderValue(null)).toBeNull();
  });

  /*
   * The defect this task exists to fix: HIVE-134 launched with a wide bind,
   * genuinely exposed, and the socket stays open for the rest of the running
   * session — but a user can toggle the settings switch off mid-session,
   * which rewrites the config file and its snapshot to loopback *instantly*,
   * long before the next launch that would actually close the socket. A
   * chip sourced from the snapshot would vanish right then and read as safe.
   * It is not: the old, wide socket is still open and reachable. So the
   * configured bind going loopback must not hide the chip while the running
   * bind stays wide — this is the one case that discriminates the fix from
   * the bug, and it is why the fixture separates "configured" from
   * "running" rather than deriving one from the other.
   */
  it('still shows the address when the configured bind has gone loopback but the running bind has not (divergence)', async () => {
    setProjectConfigForTest(snapshot({ host: '127.0.0.1' }));
    readAppInfo.mockResolvedValue(info('172.17.0.1'));
    expect(await renderValue('172.17.0.1')).toBe('172.17.0.1');
  });

  /* The browser demo has no config and no bridge at all. */
  it('is null with no snapshot', async () => {
    setProjectConfigForTest(null);
    readAppInfo.mockResolvedValue(info('172.17.0.1'));
    const { result } = renderHook(() => useReceiverExposure());
    // Gated on the snapshot resolving first — the browser demo target never
    // crosses that gate, so `readAppInfo` is never even asked.
    expect(readAppInfo).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  /**
   * The late-bind retry (HIVE-134 follow-up review).
   *
   * The bug this closes: a hostname bind resolves via DNS, which can outlast
   * this hook's first `readAppInfo` round trip — a bare one-shot read then
   * caches `null` for the rest of the session and the exposure chip never
   * appears at all, even once the socket is genuinely listening. Fake timers
   * throughout, so the retry's real-world delay (`LATE_BIND_RETRY_MS`) does
   * not have to elapse in wall-clock time for this to run fast.
   */
  describe('the late-bind retry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries once after a null answer and catches a bind that resolved just after', async () => {
      setProjectConfigForTest(snapshot({ host: '172.17.0.1' }));
      readAppInfo
        .mockResolvedValueOnce(info(null))
        .mockResolvedValueOnce(info('172.17.0.1'));

      const { result } = renderHook(() => useReceiverExposure());

      // The mounted effect's first `readAppInfo` call settles with `null` —
      // flushed with no timer advance, so this is proven to be the *first*
      // read's own answer, not a symptom of the retry firing early.
      await act(async () => {
        await Promise.resolve();
      });
      expect(readAppInfo).toHaveBeenCalledTimes(1);
      expect(result.current).toBeNull();

      // Advancing by anything short of the retry delay must not fire it —
      // the point of a *bounded* retry rather than a poll.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LATE_BIND_RETRY_MS - 1);
      });
      expect(readAppInfo).toHaveBeenCalledTimes(1);
      expect(result.current).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(readAppInfo).toHaveBeenCalledTimes(2);
      expect(result.current).toBe('172.17.0.1');
    });

    it('does not retry a second time when the retry itself lands null', async () => {
      setProjectConfigForTest(snapshot({ host: '172.17.0.1' }));
      // Every call answers `null` — if this hook ever chased a third read,
      // it would find one here to chase.
      readAppInfo.mockResolvedValue(info(null));

      const { result } = renderHook(() => useReceiverExposure());

      await act(async () => {
        await Promise.resolve();
      });
      expect(readAppInfo).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(LATE_BIND_RETRY_MS);
      });
      expect(readAppInfo).toHaveBeenCalledTimes(2);
      expect(result.current).toBeNull();

      // Far past any bounded retry's own delay, a second retry would have
      // fired by now if one were scheduled.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LATE_BIND_RETRY_MS * 10);
      });
      expect(readAppInfo).toHaveBeenCalledTimes(2);
    });

    it('does not retry when the first answer is already a live address', async () => {
      setProjectConfigForTest(snapshot({ host: '172.17.0.1' }));
      readAppInfo.mockResolvedValue(info('172.17.0.1'));

      renderHook(() => useReceiverExposure());

      await act(async () => {
        await Promise.resolve();
      });
      expect(readAppInfo).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(LATE_BIND_RETRY_MS * 10);
      });
      // A non-null first answer schedules nothing — there is no ambiguity to
      // resolve, so no second read to skip.
      expect(readAppInfo).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * `useServerExposure` (HIVE-142).
 *
 * Sourced from the server-mode socket's **running** bind
 * (`AppInfo.serverBoundHost`), never from `snapshot.server.bind.host`, for
 * the same "cannot rebind mid-session" reason `useReceiverExposure` reads
 * `receiverBoundHost` instead of the config snapshot. No loopback filter
 * here, unlike the receiver hook: a server-mode bind is opted into, not
 * something that can widen by accident, so any bound address is worth
 * reporting. Any `ConfigSnapshot` gates the fetch — `useServerExposure`
 * does not care which block the snapshot came from, only that one resolved.
 */
describe('useServerExposure', () => {
  it('is null when nothing is bound', async () => {
    setProjectConfigForTest(snapshot({ host: '127.0.0.1' }));
    readAppInfo.mockResolvedValue(serverInfo(null));
    expect(await renderServerValue(null)).toBeNull();
  });

  it('is the address when the running bind is up', async () => {
    setProjectConfigForTest(snapshot({ host: '127.0.0.1' }));
    readAppInfo.mockResolvedValue(serverInfo('100.101.102.103'));
    expect(await renderServerValue('100.101.102.103')).toBe('100.101.102.103');
  });

  /* The browser demo has no config and no bridge at all. */
  it('is null with no snapshot', async () => {
    setProjectConfigForTest(null);
    readAppInfo.mockResolvedValue(serverInfo('100.101.102.103'));
    const { result } = renderHook(() => useServerExposure());
    // Gated on the snapshot resolving first — the browser demo target never
    // crosses that gate, so `readAppInfo` is never even asked.
    expect(readAppInfo).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  /**
   * The same late-bind retry `useReceiverExposure` carries, proven here
   * once rather than in full triplicate: `server.bind.host` accepts a
   * hostname exactly as `receiver.bind.host` does, so the same DNS-outlasts-
   * the-first-read race applies, and both hooks share {@link LATE_BIND_RETRY_MS}.
   */
  it('retries once after a null answer and catches a bind that resolved just after', async () => {
    vi.useFakeTimers();
    try {
      setProjectConfigForTest(snapshot({ host: '127.0.0.1' }));
      readAppInfo
        .mockResolvedValueOnce(serverInfo(null))
        .mockResolvedValueOnce(serverInfo('100.101.102.103'));

      const { result } = renderHook(() => useServerExposure());

      await act(async () => {
        await Promise.resolve();
      });
      expect(readAppInfo).toHaveBeenCalledTimes(1);
      expect(result.current).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(LATE_BIND_RETRY_MS);
      });
      expect(readAppInfo).toHaveBeenCalledTimes(2);
      expect(result.current).toBe('100.101.102.103');
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Same shape as {@link renderValue}, but for `useServingDeviceCount`. */
async function renderDeviceCount(expected: number): Promise<number> {
  const { result } = renderHook(() => useServingDeviceCount());
  await waitFor(() => {
    expect(readAppInfo).toHaveBeenCalled();
    expect(result.current).toBe(expected);
  });
  return result.current;
}

/**
 * `useServingDeviceCount` (HIVE-144, Task 13).
 *
 * Sourced from `AppInfo.servingDeviceCount`, a paired-device count off disk —
 * independent of `useServerExposure`'s own bind gate, which is why it is its
 * own hook rather than a second field folded into that one's return; see its
 * own doc comment.
 */
describe('useServingDeviceCount', () => {
  it('is 0 before the first read lands', () => {
    setProjectConfigForTest(snapshot({}));
    readAppInfo.mockResolvedValue(deviceCountInfo(2));

    const { result } = renderHook(() => useServingDeviceCount());

    expect(result.current).toBe(0);
  });

  it('is the count once the read resolves', async () => {
    setProjectConfigForTest(snapshot({}));
    readAppInfo.mockResolvedValue(deviceCountInfo(2));
    expect(await renderDeviceCount(2)).toBe(2);
  });

  /*
   * A count of exactly 1, proven separately from 2 above: a hook that always
   * read `info.servingDeviceCount` off some hard-coded fixture, or that
   * mangled the number in transit, could still pass the `2` case above by
   * coincidence.
   */
  it('is 1 for a single paired device', async () => {
    setProjectConfigForTest(snapshot({}));
    readAppInfo.mockResolvedValue(deviceCountInfo(1));
    expect(await renderDeviceCount(1)).toBe(1);
  });

  /* The browser demo has no config and no bridge at all. */
  it('is 0 with no snapshot, and never asks the bridge', () => {
    setProjectConfigForTest(null);
    readAppInfo.mockResolvedValue(deviceCountInfo(2));

    const { result } = renderHook(() => useServingDeviceCount());

    // Gated on the snapshot resolving first — the browser demo target never
    // crosses that gate, so `readAppInfo` is never even asked.
    expect(readAppInfo).not.toHaveBeenCalled();
    expect(result.current).toBe(0);
  });
});

/** Same shape as {@link renderValue}, but for `useAttachedServer`. */
async function renderAttachedServer(expected: string | null): Promise<string | null> {
  const { result } = renderHook(() => useAttachedServer());
  await waitFor(() => {
    expect(readAppInfo).toHaveBeenCalled();
    expect(result.current).toBe(expected);
  });
  return result.current;
}

/**
 * `useAttachedServer` (HIVE-144, Task 13).
 *
 * Sourced from `AppInfo.attachedServerName`, never from
 * `ConfigSnapshot.attachedServer` — see that field's own doc comment for the
 * full config-versus-runtime split this hook reads the runtime half of.
 *
 * No late-bind retry, unlike `useReceiverExposure` and `useServerExposure`:
 * those exist because a hostname bind resolves via DNS on a timeline a first
 * `readAppInfo` round trip can outrun, so a bare `null` there is ambiguous.
 * `readAppInfo()` itself does not resolve until whichever side is answering
 * it has already finished, so a `null` this hook sees is never a read that
 * merely landed early.
 */
describe('useAttachedServer', () => {
  it('is null when not attached', async () => {
    setProjectConfigForTest(snapshot({}));
    readAppInfo.mockResolvedValue(attachedInfo(null));
    expect(await renderAttachedServer(null)).toBeNull();
  });

  it('is the server name once attached', async () => {
    setProjectConfigForTest(snapshot({}));
    readAppInfo.mockResolvedValue(attachedInfo('mini'));
    expect(await renderAttachedServer('mini')).toBe('mini');
  });

  /* The browser demo has no config and no bridge at all. */
  it('is null with no snapshot, and never asks the bridge', () => {
    setProjectConfigForTest(null);
    readAppInfo.mockResolvedValue(attachedInfo('mini'));

    const { result } = renderHook(() => useAttachedServer());

    expect(readAppInfo).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});

/**
 * `useServing` (HIVE-144 review, I3) — the interlock's UI signal.
 *
 * `AppInfo.serving` and never `ConfigSnapshot.server.enabled`, which is the
 * whole point: while attached, `config:get` is answered by the far end, so
 * that field describes the **server's** file and reads `true` on a client
 * attached to a real server. Keyed on it, Settings would disable the attach
 * half on the one window that needs it, with a reason that is false.
 */
describe('useServing', () => {
  /** A server's own snapshot, as an attached client actually holds it. */
  const serversSnapshot = (): ConfigSnapshot => ({
    ...emptySnapshot(CONFIG_PATH, '/bin/zsh'),
    server: { ...emptySnapshot(CONFIG_PATH, '/bin/zsh').server, enabled: true },
  });

  it('is false on an ordinary local window', async () => {
    setProjectConfigForTest(snapshot({}));
    readAppInfo.mockResolvedValue({ ...attachedInfo(null), serving: false });

    const { result } = renderHook(() => useServing());

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it('is true on a machine launched to serve', async () => {
    setProjectConfigForTest(snapshot({}));
    readAppInfo.mockResolvedValue({ ...attachedInfo(null), serving: true });

    const { result } = renderHook(() => useServing());

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  /**
   * The state a config-derived answer gets wrong: an attached client, holding
   * the server's snapshot with `server.enabled: true`, is itself serving
   * nothing.
   */
  it('is false on a client whose proxied snapshot says the far end serves', async () => {
    setProjectConfigForTest(serversSnapshot());
    readAppInfo.mockResolvedValue({ ...attachedInfo('mini'), serving: false });

    const { result } = renderHook(() => useServing());

    await waitFor(() => {
      expect(readAppInfo).toHaveBeenCalled();
    });
    expect(result.current).toBe(false);
  });

  /* The browser demo has no config and no bridge at all. */
  it('is false with no snapshot, and never asks the bridge', () => {
    setProjectConfigForTest(null);
    readAppInfo.mockResolvedValue({ ...attachedInfo(null), serving: true });

    const { result } = renderHook(() => useServing());

    expect(readAppInfo).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });
});

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useReceiverExposure } from '@hooks/use-project-config';
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
});

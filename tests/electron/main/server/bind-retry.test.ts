// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bindUntilBound,
  SERVER_BIND_RETRY_MAX_MS,
  SERVER_BIND_RETRY_MS,
} from '../../../../electron/main/server/bind-retry';

/**
 * A server whose Tailscale address is not up yet at login (HIVE-147).
 *
 * The bind used to be tried once, at boot. On an unattended Mac mini that meant
 * a server which came up unreachable after every reboot where Tailscale lost
 * the race, until a human restarted it.
 */
describe('bindUntilBound', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a failed bind until one lands, then stops', async () => {
    const start = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue('ws://100.64.0.1:7433');

    bindUntilBound(start);
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SERVER_BIND_RETRY_MS);
    expect(start).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(SERVER_BIND_RETRY_MS * 2);
    expect(start).toHaveBeenCalledTimes(3);

    // Bound: nothing more, however long the process runs.
    await vi.advanceTimersByTimeAsync(SERVER_BIND_RETRY_MAX_MS * 10);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it('backs off to a ceiling, so a config typo costs a log line a minute', async () => {
    const start = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
    bindUntilBound(start);
    await vi.advanceTimersByTimeAsync(0);

    const gaps = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
    for (const [i, gap] of gaps.entries()) {
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(start).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(start).toHaveBeenCalledTimes(i + 2);
    }
  });

  it('counts a rejected attempt as a failed one', async () => {
    const start = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('EADDRNOTAVAIL'))
      .mockResolvedValue('ws://100.64.0.1:7433');

    bindUntilBound(start);
    await vi.advanceTimersByTimeAsync(SERVER_BIND_RETRY_MS);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('stops retrying once stopped, even with an attempt already scheduled', async () => {
    const start = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
    const stop = bindUntilBound(start);
    await vi.advanceTimersByTimeAsync(0);

    stop();
    await vi.advanceTimersByTimeAsync(SERVER_BIND_RETRY_MAX_MS * 10);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a retry when stopped while an attempt is in flight', async () => {
    let fail: (value: null) => void = () => undefined;
    const start = vi.fn<() => Promise<string | null>>().mockReturnValueOnce(
      new Promise<null>((resolve) => {
        fail = resolve;
      }),
    );
    const stop = bindUntilBound(start);

    stop();
    fail(null);
    await vi.advanceTimersByTimeAsync(SERVER_BIND_RETRY_MAX_MS * 10);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

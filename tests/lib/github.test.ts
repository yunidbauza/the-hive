import { afterEach, describe, expect, it, vi } from 'vitest';

import { readPullRequests } from '@lib/github';
import type { GhResult, PrsSnapshot } from '@shared/github-contract';

/**
 * The renderer's GitHub bridge.
 *
 * Mirrors `lib/jira.ts`: no bridge is the browser demo and not a failure, and a
 * rejected channel is reported to the console rather than thrown at a panel —
 * a rail that crashes because IPC hiccuped is worse than one that says it does
 * not know.
 */

const SNAPSHOT: GhResult<PrsSnapshot> = {
  ok: true,
  value: { prs: [], repos: 2 },
};

afterEach(() => {
  delete window.hive;
  vi.restoreAllMocks();
});

describe('readPullRequests', () => {
  it('answers null when there is no bridge', async () => {
    await expect(readPullRequests()).resolves.toBeNull();
  });

  it('calls the bridge and returns its answer', async () => {
    const prs = vi.fn().mockResolvedValue(SNAPSHOT);
    window.hive = { github: { prs } } as unknown as Window['hive'];

    await expect(readPullRequests()).resolves.toEqual(SNAPSHOT);
    expect(prs).toHaveBeenCalledWith();
  });

  /** A refusal from GitHub is an *answer*, and it is passed straight through. */
  it('passes a refusal through rather than flattening it to null', async () => {
    const refusal: GhResult<PrsSnapshot> = {
      ok: false,
      error: { kind: 'offline', message: 'Could not reach GitHub.' },
    };
    window.hive = {
      github: { prs: vi.fn().mockResolvedValue(refusal) },
    } as unknown as Window['hive'];

    await expect(readPullRequests()).resolves.toEqual(refusal);
  });

  it('answers null and logs once when the channel itself fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.hive = {
      github: { prs: vi.fn().mockRejectedValue(new Error('channel closed')) },
    } as unknown as Window['hive'];

    await expect(readPullRequests()).resolves.toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

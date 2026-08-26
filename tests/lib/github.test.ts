import { afterEach, describe, expect, it, vi } from 'vitest';

import { readPullRequests, searchPullRequests } from '@lib/github';
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

/**
 * The search verb, which has the same three answers as the sweep and one more
 * question of its own: what it forwards.
 */
describe('searchPullRequests', () => {
  it('answers null with no bridge — that is the browser demo', async () => {
    delete window.hive;

    await expect(searchPullRequests('carapace')).resolves.toBeNull();
  });

  it('forwards the term and the project untouched', async () => {
    const searchPrs = vi.fn().mockResolvedValue({ ok: true, value: [] });
    window.hive = { github: { searchPrs } } as unknown as Window['hive'];

    await searchPullRequests('carapace', 'nova-web');

    expect(searchPrs).toHaveBeenCalledWith('carapace', 'nova-web');
  });

  it('omits the project when there is none — main reads that as all of them', async () => {
    const searchPrs = vi.fn().mockResolvedValue({ ok: true, value: [] });
    window.hive = { github: { searchPrs } } as unknown as Window['hive'];

    await searchPullRequests('carapace');

    expect(searchPrs).toHaveBeenCalledWith('carapace', undefined);
  });

  it('passes a refusal through rather than flattening it to null', async () => {
    const refusal = {
      ok: false as const,
      error: { kind: 'offline' as const, message: 'Could not reach GitHub.' },
    };
    window.hive = {
      github: { searchPrs: vi.fn().mockResolvedValue(refusal) },
    } as unknown as Window['hive'];

    await expect(searchPullRequests('carapace')).resolves.toEqual(refusal);
  });

  it('answers null and logs once when the channel itself fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.hive = {
      github: { searchPrs: vi.fn().mockRejectedValue(new Error('channel closed')) },
    } as unknown as Window['hive'];

    await expect(searchPullRequests('carapace')).resolves.toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

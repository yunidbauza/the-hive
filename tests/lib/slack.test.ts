import { afterEach, describe, expect, it, vi } from 'vitest';

import { readSlackStatus, signIn, signOut, testSlack } from '@lib/slack';
import type { SlackStatus } from '@shared/slack-contract';

/**
 * The renderer's Slack bridge (HIVE-123).
 *
 * Mirrors `tests/lib/jira.test.ts`, because `src/lib/slack.ts` mirrors
 * `src/lib/jira.ts`: **no bridge is the browser demo**, not a failure, so it
 * answers `null` silently; a **rejected channel** is also `null`, but logged
 * once, because a settings pane that throws when IPC hiccups is worse than one
 * that says it does not know.
 *
 * The distinction is the whole file. Both paths answer `null` and
 * `SlackGroup` renders the same "could not reach its own main process" for
 * either — so the only thing that can tell a missing bridge from a broken one
 * is whether the console was written to, and that is what these assert.
 */

const CONNECTED: SlackStatus = { kind: 'connected' };

type SlackBridge = NonNullable<Window['hive']>['slack'];

afterEach(() => {
  delete window.hive;
  vi.restoreAllMocks();
});

/** Install a partial bridge; the cast is confined to this helper. */
function bridge(slack: Partial<SlackBridge>): void {
  window.hive = { slack } as unknown as NonNullable<Window['hive']>;
}

describe('with no bridge', () => {
  it('answers null rather than throwing', async () => {
    await expect(readSlackStatus()).resolves.toBeNull();
    await expect(signIn()).resolves.toBeNull();
    await expect(signOut()).resolves.toBeNull();
    await expect(testSlack()).resolves.toBeNull();
  });

  it('logs nothing — the browser demo is not a failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await readSlackStatus();
    await signIn();
    await signOut();
    await testSlack();

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('with a bridge', () => {
  it('returns the status the main process answered', async () => {
    bridge({ status: () => Promise.resolve(CONNECTED) });

    await expect(readSlackStatus()).resolves.toEqual(CONNECTED);
  });

  it('calls the verb each helper is named for, and no other', async () => {
    const calls: string[] = [];
    const record = (verb: string) => () => {
      calls.push(verb);

      return Promise.resolve(CONNECTED);
    };

    bridge({
      status: record('status'),
      signIn: record('signIn'),
      signOut: record('signOut'),
      test: record('test'),
    });

    await readSlackStatus();
    await signIn();
    await signOut();
    await testSlack();

    expect(calls).toEqual(['status', 'signIn', 'signOut', 'test']);
  });

  /**
   * An `error` status is an *answer*, not a failure of the channel — the pane
   * renders its message as the caption. Swallowing it to `null` would replace
   * the reason with "could not reach its own main process".
   */
  it('passes an error status through untouched', async () => {
    const refused: SlackStatus = { kind: 'error', message: 'bad url' };
    bridge({ signIn: () => Promise.resolve(refused) });

    await expect(signIn()).resolves.toEqual(refused);
  });

  it('answers null and logs once when the channel rejects', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge({ test: () => Promise.reject(new Error('no handler')) });

    await expect(testSlack()).resolves.toBeNull();
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toContain('slack.test');
  });

  /** Every verb names itself in the log, or a report says nothing useful. */
  it('names the verb that failed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge({
      status: () => Promise.reject(new Error('x')),
      signIn: () => Promise.reject(new Error('x')),
      signOut: () => Promise.reject(new Error('x')),
    });

    await readSlackStatus();
    await signIn();
    await signOut();

    expect(spy.mock.calls.map((args) => String(args[0]))).toEqual([
      '[hive] slack.status failed:',
      '[hive] slack.signIn failed:',
      '[hive] slack.signOut failed:',
    ]);
  });
});

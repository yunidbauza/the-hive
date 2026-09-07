import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearSlackTokens,
  readSlackSocketState,
  readSlackStatus,
  setSlackConfig,
  setSlackTokens,
  signIn,
  signOut,
  subscribeSlackSocketStatus,
  testSlack,
  testSlackSocket,
} from '@lib/slack';
import type {
  SlackSocketStatus,
  SlackStatus,
  SlackTokensState,
} from '@shared/slack-contract';

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

type ConfigBridge = NonNullable<Window['hive']>['config'];

/** Install a partial bridge; the cast is confined to this helper. */
function bridge(slack: Partial<SlackBridge>, config: Partial<ConfigBridge> = {}): void {
  window.hive = { slack, config } as unknown as NonNullable<Window['hive']>;
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

/**
 * Socket mode's own wrappers (HIVE-124).
 *
 * The same two rules as the four above — no bridge is `null` and silent, a
 * rejection is `null` and logged once — applied to verbs that no longer all
 * answer with a `SlackStatus`. The subscription is the one shape that is not a
 * promise, and it has a rule of its own: with no bridge it must still hand back
 * a disposer, or a component's cleanup path differs between the app and the
 * browser demo.
 */
describe('socket mode (HIVE-124)', () => {
  const PRESENT: SlackTokensState = {
    hasAppToken: true,
    hasBotToken: true,
    encryptionAvailable: true,
  };

  describe('with no bridge', () => {
    it('answers null rather than throwing, and logs nothing', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(setSlackTokens({ appToken: 'xapp-1' })).resolves.toBeNull();
      await expect(clearSlackTokens()).resolves.toBeNull();
      await expect(setSlackConfig({ socketMode: true })).resolves.toBeNull();
      await expect(testSlackSocket()).resolves.toBeNull();
      await expect(readSlackSocketState()).resolves.toBeNull();

      expect(spy).not.toHaveBeenCalled();
    });

    it('still returns a disposer from the subscription', () => {
      const stop = subscribeSlackSocketStatus(() => {});

      expect(() => {
        stop();
      }).not.toThrow();
    });
  });

  describe('with a bridge', () => {
    it('forwards the tokens and answers with presence', async () => {
      const setTokens = vi.fn(() => Promise.resolve(PRESENT));
      bridge({ setTokens });

      await expect(setSlackTokens({ appToken: 'xapp-1' })).resolves.toEqual(PRESENT);
      expect(setTokens).toHaveBeenCalledWith({ appToken: 'xapp-1' });
    });

    it('clears through its own verb, which takes nothing', async () => {
      const clearTokens = vi.fn(() =>
        Promise.resolve({ ...PRESENT, hasAppToken: false, hasBotToken: false }),
      );
      bridge({ clearTokens });

      await clearSlackTokens();

      expect(clearTokens).toHaveBeenCalledWith();
    });

    /** The switch is a config write, so it goes to `config`, not to `slack`. */
    it('writes the switch through the config namespace', async () => {
      const setSlack = vi.fn(() => Promise.resolve({} as never));
      bridge({}, { setSlack });

      await setSlackConfig({ socketMode: true, commanders: ['U1'] });

      expect(setSlack).toHaveBeenCalledWith({
        socketMode: true,
        commanders: ['U1'],
      });
    });

    it('reaches socketTest, and not the MCP server’s test', async () => {
      const socketTest = vi.fn(() =>
        Promise.resolve({ kind: 'ok' as const, workspace: 'acme', bot: 'hive' }),
      );
      const test = vi.fn(() => Promise.resolve({ kind: 'connected' as const }));
      bridge({ socketTest, test });

      await expect(testSlackSocket()).resolves.toEqual({
        kind: 'ok',
        workspace: 'acme',
        bot: 'hive',
      });
      expect(test).not.toHaveBeenCalled();
    });

    it('passes the push through and hands back the bridge’s own disposer', () => {
      const stop = vi.fn();
      let emit: ((status: SlackSocketStatus) => void) | undefined;
      bridge({
        onSocketStatus: (callback: (status: SlackSocketStatus) => void) => {
          emit = callback;

          return stop;
        },
      });

      const seen: SlackSocketStatus[] = [];
      const dispose = subscribeSlackSocketStatus((status) => seen.push(status));

      emit?.({ kind: 'connecting' });
      dispose();

      expect(seen).toEqual([{ kind: 'connecting' }]);
      expect(stop).toHaveBeenCalledOnce();
    });

    /**
     * The mount-time read (fix-round-2, HIVE-124). The push it accompanies is
     * not buffered and main suppresses a repeat of the last status, so this is
     * the only way a pane that mounts after boot learns either fact.
     */
    it('reads presence and the last socket status in one call', async () => {
      const socketState = vi.fn(() =>
        Promise.resolve({ tokens: PRESENT, socket: { kind: 'off' as const } }),
      );
      bridge({ socketState });

      await expect(readSlackSocketState()).resolves.toEqual({
        tokens: PRESENT,
        socket: { kind: 'off' },
      });
      expect(socketState).toHaveBeenCalledWith();
    });

    it('answers null and names the verb when a channel rejects', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      bridge({ socketTest: () => Promise.reject(new Error('no handler')) });

      await expect(testSlackSocket()).resolves.toBeNull();
      expect(String(spy.mock.calls[0]?.[0])).toContain('slack.socketTest');
    });
  });
});

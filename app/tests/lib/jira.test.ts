import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearJiraToken,
  readJiraStatus,
  saveJiraToken,
  testJiraConnection,
} from '@lib/jira';
import type { JiraStatus } from '@shared/jira-contract';

/**
 * The renderer's Jira bridge (HIVE-67).
 *
 * Mirrors `project-config.ts`: no bridge is the browser demo and not a failure,
 * and a rejected channel is reported to the console rather than thrown at a
 * component — a settings pane that crashes because IPC hiccuped is worse than
 * one that says it does not know.
 */

const STATUS: JiraStatus = {
  site: 'behiques.atlassian.net',
  email: 'me@example.com',
  credential: { kind: 'none' },
  encryptionAvailable: true,
};

type JiraBridge = NonNullable<Window['hive']>['jira'];

afterEach(() => {
  delete window.hive;
  vi.restoreAllMocks();
});

/** Install a partial bridge; the cast is confined to this helper. */
function bridge(jira: Partial<JiraBridge>): void {
  window.hive = { jira } as unknown as NonNullable<Window['hive']>;
}

describe('with no bridge', () => {
  it('answers null rather than throwing', async () => {
    await expect(readJiraStatus()).resolves.toBeNull();
    await expect(saveJiraToken('t')).resolves.toBeNull();
    await expect(clearJiraToken()).resolves.toBeNull();
    await expect(testJiraConnection()).resolves.toBeNull();
  });

  it('logs nothing — the browser demo is not a failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await readJiraStatus();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('with a bridge', () => {
  it('returns the status', async () => {
    bridge({ status: () => Promise.resolve(STATUS) });
    await expect(readJiraStatus()).resolves.toEqual(STATUS);
  });

  it('passes the token through to setToken', async () => {
    const setToken = vi.fn(() => Promise.resolve(STATUS));
    bridge({ setToken });
    await saveJiraToken('ATATT-x');
    expect(setToken).toHaveBeenCalledWith({ token: 'ATATT-x' });
  });

  it('calls clearToken with no argument', async () => {
    const clearToken = vi.fn(() => Promise.resolve(STATUS));
    bridge({ clearToken });
    await clearJiraToken();
    expect(clearToken).toHaveBeenCalledWith();
  });

  it('returns a refusal from test as an answer, not as null', async () => {
    bridge({
      test: () =>
        Promise.resolve({
          ok: false as const,
          error: { kind: 'unauthorized' as const, message: 'nope' },
        }),
    });
    await expect(testJiraConnection()).resolves.toEqual({
      ok: false,
      error: { kind: 'unauthorized', message: 'nope' },
    });
  });

  it('reports a rejected channel as null and logs once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge({ status: () => Promise.reject(new Error('channel down')) });
    await expect(readJiraStatus()).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never logs the token when a write is refused', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge({ setToken: () => Promise.reject(new Error('refused')) });

    await expect(saveJiraToken('ATATT-secret')).resolves.toBeNull();
    expect(JSON.stringify(spy.mock.calls)).not.toContain('ATATT-secret');
  });

  it('names the verb that failed, so one log line serves all four', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge({ test: () => Promise.reject(new Error('boom')) });
    await testJiraConnection();
    expect(spy.mock.calls[0]?.[0]).toContain('jira.test');
  });
});

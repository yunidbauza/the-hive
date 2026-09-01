// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  signInToSlack,
  signOutOfSlack,
  SLACK_ADD_TIMEOUT_MS,
  SLACK_SIGN_IN_TIMEOUT_MS,
} from '../../../../../electron/main/integrations/slack/login';
import { SILENT_FAILURE, TIMED_OUT } from '../../../../../electron/main/integrations/slack/outcome';
import { SLACK_CALLBACK_PORT, SLACK_CLIENT_ID, SLACK_MCP_URL } from '@shared/slack-contract';

/**
 * Every step of the sign-in runs on the **async** runner, the read-back
 * included. `claude mcp login` waits on a browser OAuth round-trip and
 * `claude mcp get` health-checks the server over HTTP; the five-second
 * `spawnSync` helper this used to share with `gh auth status` killed the first
 * every time, while blocking the whole main process on both.
 *
 * `run` therefore answers all three commands, and the tests below tell them
 * apart by argv where it matters.
 */

const ok = () => ({ code: 0, stdout: '', stderr: '', timedOut: false });
/** What `claude mcp get slack` prints for a server that is there. */
const CONNECTED = 'Status: ✓ Connected';
/** …and what it exits with when it is not. */
const missing = () => ({ code: 1, stdout: '', stderr: 'No MCP server found', timedOut: false });

/**
 * The default runner: everything succeeds, and the read-back says connected.
 *
 * Written as one function over argv rather than a call counter, because the
 * `add`-failure path below inserts an extra `mcp get` between add and login and
 * a counter would silently mean something different in each test.
 */
const happy = (args: readonly string[]) =>
  Promise.resolve(args[1] === 'get' ? { ...ok(), stdout: CONNECTED } : ok());

describe('signInToSlack', () => {
  it("adds the server with Slack's own client id, at user scope", async () => {
    const calls: string[][] = [];
    const run = (_f: string, args: readonly string[]) => {
      calls.push([...args]);

      return happy(args);
    };

    await signInToSlack('claude', run);

    expect(calls[0]).toEqual([
      'mcp', 'add', '--transport', 'http', 'slack', SLACK_MCP_URL,
      '--client-id', SLACK_CLIENT_ID,
      '--callback-port', String(SLACK_CALLBACK_PORT),
      '--scope', 'user',
    ]);
    expect(calls[1]).toEqual(['mcp', 'login', 'slack']);
  });

  /**
   * The browser flow gets minutes, not seconds. Asserted as a real number
   * rather than as "the constant equals itself": five seconds is a guaranteed
   * failure and this is the assertion that would catch a return to it.
   */
  it('gives the browser round-trip a human amount of time', async () => {
    const timeouts: (number | undefined)[] = [];
    const run = (
      _f: string,
      args: readonly string[],
      options?: { timeoutMs?: number },
    ) => {
      timeouts.push(options?.timeoutMs);

      return happy(args);
    };

    await signInToSlack('claude', run);

    expect(timeouts.slice(0, 2)).toEqual([
      SLACK_ADD_TIMEOUT_MS,
      SLACK_SIGN_IN_TIMEOUT_MS,
    ]);
    expect(SLACK_SIGN_IN_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('reads the status back rather than assuming the zero exit means success', async () => {
    // add and login both exit zero — a login abandoned in the browser does
    // this too — but the read-back (`mcp get`) reports needs-auth. The
    // returned status must come from that third call, not from an optimistic
    // short-circuit after a zero-exit login.
    const calls: string[][] = [];
    const run = (_f: string, args: readonly string[]) => {
      calls.push([...args]);

      return Promise.resolve(
        args[1] === 'get'
          ? { ...ok(), stdout: 'Status: ! Needs authentication' }
          : ok(),
      );
    };

    const status = await signInToSlack('claude', run);

    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(['mcp', 'get', 'slack']);
    expect(status).toEqual({ kind: 'needs-auth' });
  });

  /**
   * The story's re-authentication bug, in one test.
   *
   * `claude mcp add` exits **1** with `MCP server slack already exists in user
   * config` on stderr the second time (measured, 2.1.252) — so the *only*
   * button a signed-out pane offers could never reach the `mcp login` that
   * would refresh an expired token. The add's failure has to be read against
   * the CLI's own state, not taken at its word.
   */
  it('proceeds to the login when the add failed only because the server is already there', async () => {
    const calls: string[][] = [];
    const run = (_f: string, args: readonly string[]) => {
      calls.push([...args]);

      if (args[1] === 'add') {
        return Promise.resolve({
          code: 1,
          stdout: '',
          stderr: 'MCP server slack already exists in user config',
          timedOut: false,
        });
      }

      return Promise.resolve({ ...ok(), stdout: CONNECTED });
    };

    const status = await signInToSlack('claude', run);

    expect(calls.map((args) => args[1])).toEqual(['add', 'get', 'login', 'get']);
    expect(status).toEqual({ kind: 'connected' });
  });

  /**
   * The other half of the same branch, and the reason it reads state rather
   * than matching `/already exists/`: an add that failed for a real reason
   * must still stop, and must still report **its own** message rather than the
   * read-back's.
   */
  it('does not attempt the login when the add fails and the server is not there', async () => {
    const calls: string[][] = [];
    const run = (_f: string, args: readonly string[]) => {
      calls.push([...args]);

      return Promise.resolve(
        args[1] === 'add'
          ? { code: 1, stdout: '', stderr: 'bad url', timedOut: false }
          : missing(),
      );
    };

    const status = await signInToSlack('claude', run);

    expect(calls.map((args) => args[1])).toEqual(['add', 'get']);
    expect(status).toEqual({ kind: 'error', message: 'bad url' });
  });

  /** A read-back that cannot answer is not evidence the add was redundant. */
  it('keeps the add’s failure when the read-back is itself broken', async () => {
    const run = (_f: string, args: readonly string[]) =>
      args[1] === 'add'
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'bad url', timedOut: false })
        : Promise.reject(new Error('spawn ENOENT'));

    await expect(signInToSlack('claude', run)).resolves.toEqual({
      kind: 'error',
      message: 'bad url',
    });
  });

  it('reports a failed browser flow with the reason the cli gave', async () => {
    const run = (_f: string, args: readonly string[]) =>
      Promise.resolve(
        args[1] === 'login'
          ? { code: 1, stdout: '', stderr: 'callback port 3118 is in use', timedOut: false }
          : ok(),
      );

    await expect(signInToSlack('claude', run)).resolves.toEqual({
      kind: 'error',
      message: 'callback port 3118 is in use',
    });
  });

  /**
   * A login that hit its cap has printed "waiting for your browser…" and
   * nothing else. Echoing that as the error would be worse than saying
   * nothing; saying nothing is what it used to do.
   */
  it('names the timeout rather than echoing the waiting message', async () => {
    const run = (_f: string, args: readonly string[]) =>
      Promise.resolve(
        args[1] === 'login'
          ? {
              code: -1,
              stdout: 'Opening your browser to complete authentication…',
              stderr: '',
              timedOut: true,
            }
          : ok(),
      );

    await expect(signInToSlack('claude', run)).resolves.toEqual({
      kind: 'error',
      message: TIMED_OUT,
    });
  });

  it('never leaves the caption blank when the cli fails silently', async () => {
    const run = (_f: string, args: readonly string[]) =>
      Promise.resolve(
        args[1] === 'get'
          ? missing()
          : { code: 1, stdout: '', stderr: '', timedOut: false },
      );

    await expect(signInToSlack('claude', run)).resolves.toEqual({
      kind: 'error',
      message: SILENT_FAILURE,
    });
  });

  it('reports a binary that could not be executed rather than throwing', async () => {
    const run = () => Promise.reject(new Error('spawn ENOENT'));

    await expect(signInToSlack('claude', run)).resolves.toEqual({
      kind: 'error',
      message: 'Could not run claude: spawn ENOENT',
    });
  });
});

describe('signOutOfSlack', () => {
  it('removes the server at user scope and reports not-added', () => {
    const calls: string[][] = [];
    const run = (_f: string, args: readonly string[]) => {
      calls.push([...args]);

      return { code: 0, stdout: CONNECTED, stderr: '' };
    };

    expect(signOutOfSlack('claude', run)).toEqual({ kind: 'not-added' });
    expect(calls[0]).toEqual(['mcp', 'remove', 'slack', '--scope', 'user']);
  });

  it('stays on the synchronous runner — there is no browser in a remove', () => {
    const run = () => ({ code: 1, stdout: '', stderr: 'no such server', timedOut: false });

    expect(signOutOfSlack('claude', run)).toEqual({
      kind: 'error',
      message: 'no such server',
    });
  });
});

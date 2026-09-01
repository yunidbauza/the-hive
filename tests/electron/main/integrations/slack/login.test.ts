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
 * Sign-in runs on the **async** runner and reads its result back on the sync
 * one, so both are supplied here. That split is the fix for the story's first
 * Critical: `claude mcp login` waits on a browser OAuth round-trip, and the
 * five-second `spawnSync` helper it used to share with `gh auth status` killed
 * it every time — while blocking the whole main process for those five seconds.
 */

const ok = () => ({ code: 0, stdout: '', stderr: '', timedOut: false });
const connected = () => ({ code: 0, stdout: 'Status: ✓ Connected', stderr: '' });

describe('signInToSlack', () => {
  it("adds the server with Slack's own client id, at user scope", async () => {
    const calls: string[][] = [];
    const run = (_f: string, args: readonly string[]) => {
      calls.push([...args]);

      return Promise.resolve(ok());
    };

    await signInToSlack('claude', run, connected);

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
      _args: readonly string[],
      options?: { timeoutMs?: number },
    ) => {
      timeouts.push(options?.timeoutMs);

      return Promise.resolve(ok());
    };

    await signInToSlack('claude', run, connected);

    expect(timeouts).toEqual([SLACK_ADD_TIMEOUT_MS, SLACK_SIGN_IN_TIMEOUT_MS]);
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

      return Promise.resolve(ok());
    };
    const readBack = (_f: string, args: readonly string[]) => {
      calls.push([...args]);

      return { code: 0, stdout: 'Status: ! Needs authentication', stderr: '' };
    };

    const status = await signInToSlack('claude', run, readBack);

    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(['mcp', 'get', 'slack']);
    expect(status).toEqual({ kind: 'needs-auth' });
  });

  it('does not attempt the login when the add fails', async () => {
    const calls: string[][] = [];
    const run = (_f: string, args: readonly string[]) => {
      calls.push([...args]);

      return Promise.resolve({ code: 1, stdout: '', stderr: 'bad url', timedOut: false });
    };

    const status = await signInToSlack('claude', run, connected);

    expect(calls).toHaveLength(1);
    expect(status).toEqual({ kind: 'error', message: 'bad url' });
  });

  it('reports a failed browser flow with the reason the cli gave', async () => {
    let call = 0;
    const run = () => {
      call += 1;

      return Promise.resolve(
        call === 1
          ? ok()
          : { code: 1, stdout: '', stderr: 'callback port 3118 is in use', timedOut: false },
      );
    };

    await expect(signInToSlack('claude', run, connected)).resolves.toEqual({
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
    let call = 0;
    const run = () => {
      call += 1;

      return Promise.resolve(
        call === 1
          ? ok()
          : {
              code: -1,
              stdout: 'Opening your browser to complete authentication…',
              stderr: '',
              timedOut: true,
            },
      );
    };

    await expect(signInToSlack('claude', run, connected)).resolves.toEqual({
      kind: 'error',
      message: TIMED_OUT,
    });
  });

  it('never leaves the caption blank when the cli fails silently', async () => {
    const run = () =>
      Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false });

    await expect(signInToSlack('claude', run, connected)).resolves.toEqual({
      kind: 'error',
      message: SILENT_FAILURE,
    });
  });

  it('reports a binary that could not be executed rather than throwing', async () => {
    const run = () => Promise.reject(new Error('spawn ENOENT'));

    await expect(signInToSlack('claude', run, connected)).resolves.toEqual({
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

      return connected();
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

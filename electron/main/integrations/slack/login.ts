import {
  SLACK_CALLBACK_PORT,
  SLACK_CLIENT_ID,
  SLACK_MCP_URL,
  SLACK_SERVER_KEY,
  type SlackStatus,
} from '@shared/slack-contract';

import type { RunCommand } from '../gh';
import type { RunAsync } from '../github/run';

import { couldNotRun, failure } from './outcome';
import { readSlackStatus } from './status';

/**
 * Sign-in as a subprocess, not as a terminal (HIVE-123).
 *
 * `claude mcp login` opens the system browser and waits on the callback port;
 * it needs no tty of its own, so a visible PTY pane would show the user a
 * spinner and nothing else. The browser is where the flow actually happens,
 * and the pane reports the outcome.
 *
 * Two commands rather than one, because `add` is idempotent configuration and
 * `login` is the interactive half — and a failed `add` must not be followed by
 * a login that would prompt against a server that is not there.
 *
 * ## Two runners, on purpose
 *
 * `run` is the **asynchronous** one, the same `runAsync` the PR poller and
 * `sessions/git.ts` already share. The login blocks on a human in a browser:
 * `gh.ts`'s synchronous runner would SIGTERM it after five seconds — so it
 * could never succeed — and would block the whole main process, every IPC
 * reply, every pty chunk and the agent scheduler, for those five seconds on the
 * way to failing. The timeout is passed **per verb**, because "how long is too
 * long" is a fact about the verb and not about the mechanism.
 *
 * `readBack` is the synchronous runner, kept for the one call here that really
 * is a sub-second local fact-read — `claude mcp get`.
 */

/**
 * Half a minute for `claude mcp add`.
 *
 * Local config editing with no network in it. Generous for what it does, and
 * still short enough that a wedged CLI reports rather than hangs the pane.
 */
export const SLACK_ADD_TIMEOUT_MS = 30_000;

/**
 * Ten minutes for `claude mcp login`.
 *
 * This is a human flow — a browser launch, a Slack consent screen, possibly a
 * workspace picker, possibly a password manager and a second factor in the way.
 * Anything on the order of seconds is not a timeout, it is a guaranteed
 * failure. The cap exists only so a flow abandoned with the tab left open
 * eventually gives the button back rather than waiting forever.
 */
export const SLACK_SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export async function signInToSlack(
  claude: string,
  run: RunAsync,
  readBack: RunCommand,
): Promise<SlackStatus> {
  try {
    const added = await run(
      claude,
      [
        'mcp', 'add', '--transport', 'http', SLACK_SERVER_KEY, SLACK_MCP_URL,
        '--client-id', SLACK_CLIENT_ID,
        '--callback-port', String(SLACK_CALLBACK_PORT),
        // See `status.ts`: a local server is invisible to an agent's own cwd.
        '--scope', 'user',
      ],
      { timeoutMs: SLACK_ADD_TIMEOUT_MS },
    );

    if (added.code !== 0) return failure(added);

    const logged = await run(claude, ['mcp', 'login', SLACK_SERVER_KEY], {
      timeoutMs: SLACK_SIGN_IN_TIMEOUT_MS,
    });

    if (logged.code !== 0) return failure(logged);
  } catch (cause) {
    return couldNotRun(cause);
  }

  // Read it back rather than assuming: the login can exit zero having been
  // abandoned in the browser.
  return readSlackStatus(claude, readBack);
}

export function signOutOfSlack(claude: string, run: RunCommand): SlackStatus {
  /*
    The one verb here that stays on the synchronous runner. `claude mcp remove`
    edits a local file and returns; there is no browser and no model in it, so
    the fast path is the honest one.
  */
  try {
    const removed = run(claude, ['mcp', 'remove', SLACK_SERVER_KEY, '--scope', 'user']);

    if (removed.code !== 0) return failure(removed);
  } catch (cause) {
    return couldNotRun(cause);
  }

  /*
    The credential entry in `~/.claude/.credentials.json` goes with the server,
    so this really is a sign-out and not merely a forget.
  */
  return { kind: 'not-added' };
}

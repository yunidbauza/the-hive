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
 * Two commands rather than one, because `add` is configuration and `login` is
 * the interactive half — and an `add` that genuinely failed must not be
 * followed by a login that would prompt against a server that is not there.
 *
 * ## `claude mcp add` is not idempotent, and re-authentication depends on it
 *
 * Measured against `claude` 2.1.252: a second
 * `claude mcp add --transport http slack <url> --scope user` prints
 * `MCP server slack already exists in user config` **on stderr** and exits
 * **1**. Treating that as a failed add is what made an expired token
 * unrecoverable: the pane reports "Not signed in", the only button offered is
 * `Sign in to Slack`, and that click could never get past the `add` to reach
 * the `mcp login` that would refresh the credential. A permanent dead end
 * reached by doing nothing but waiting.
 *
 * The fix asks the CLI's own **state** rather than matching its prose: on a
 * non-zero `add`, read the server back with `claude mcp get`. A server that is
 * there was already configured, so the add failed only by being redundant and
 * the login proceeds; a server that is not there means the add failed for a
 * real reason, and *that* reason — the add's own stderr, not the read-back's —
 * is what the pane is told. A wording change in the CLI cannot break this the
 * way an `/already exists/` match would.
 *
 * ## One runner, asynchronous
 *
 * The same `runAsync` the PR poller and `sessions/git.ts` share. The login
 * blocks on a human in a browser and `mcp get` health-checks over HTTP:
 * `gh.ts`'s synchronous runner would SIGTERM the login after five seconds — so
 * it could never succeed — and would block the whole main process, every IPC
 * reply, every pty chunk and the agent scheduler, for those five seconds on the
 * way to failing. The timeout is passed **per verb**, because "how long is too
 * long" is a fact about the verb and not about the mechanism.
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

/**
 * Is the server configured despite the `add` having failed?
 *
 * `not-added` is the CLI saying there is no such server, and `error` is this
 * module being unable to tell — a `claude` that hung, or one that could not be
 * run at all. Neither is evidence the add was merely redundant, so both keep
 * the add's own failure as the answer. See the module comment for why this
 * reads state rather than matching the "already exists" sentence.
 */
const alreadyAdded = async (claude: string, run: RunAsync): Promise<boolean> => {
  const existing = await readSlackStatus(claude, run);

  return existing.kind !== 'not-added' && existing.kind !== 'error';
};

export async function signInToSlack(
  claude: string,
  run: RunAsync,
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

    if (added.code !== 0 && !(await alreadyAdded(claude, run))) {
      return failure(added);
    }

    const logged = await run(claude, ['mcp', 'login', SLACK_SERVER_KEY], {
      timeoutMs: SLACK_SIGN_IN_TIMEOUT_MS,
    });

    if (logged.code !== 0) return failure(logged);
  } catch (cause) {
    return couldNotRun(cause);
  }

  // Read it back rather than assuming: the login can exit zero having been
  // abandoned in the browser.
  return readSlackStatus(claude, run);
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

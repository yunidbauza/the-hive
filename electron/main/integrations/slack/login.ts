import {
  SLACK_CALLBACK_PORT,
  SLACK_CLIENT_ID,
  SLACK_MCP_URL,
  SLACK_SERVER_KEY,
  type SlackStatus,
} from '@shared/slack-contract';

import type { RunCommand } from '../gh';

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
 */

const failure = (stderr: string, stdout: string): SlackStatus => ({
  kind: 'error',
  message: (stderr.trim() === '' ? stdout : stderr).trim(),
});

export function signInToSlack(claude: string, run: RunCommand): SlackStatus {
  try {
    const added = run(claude, [
      'mcp', 'add', '--transport', 'http', SLACK_SERVER_KEY, SLACK_MCP_URL,
      '--client-id', SLACK_CLIENT_ID,
      '--callback-port', String(SLACK_CALLBACK_PORT),
      // See `status.ts`: a local server is invisible to an agent's own cwd.
      '--scope', 'user',
    ]);

    if (added.code !== 0) return failure(added.stderr, added.stdout);

    const logged = run(claude, ['mcp', 'login', SLACK_SERVER_KEY]);

    if (logged.code !== 0) return failure(logged.stderr, logged.stdout);
  } catch (cause) {
    return {
      kind: 'error',
      message: `Could not run claude: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  // Read it back rather than assuming: the login can exit zero having been
  // abandoned in the browser.
  return readSlackStatus(claude, run);
}

export function signOutOfSlack(claude: string, run: RunCommand): SlackStatus {
  try {
    const removed = run(claude, ['mcp', 'remove', SLACK_SERVER_KEY, '--scope', 'user']);

    if (removed.code !== 0) return failure(removed.stderr, removed.stdout);
  } catch (cause) {
    return {
      kind: 'error',
      message: `Could not run claude: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  /*
    The credential entry in `~/.claude/.credentials.json` goes with the server,
    so this really is a sign-out and not merely a forget.
  */
  return { kind: 'not-added' };
}

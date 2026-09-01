import { SLACK_SERVER_KEY, type SlackStatus } from '@shared/slack-contract';

import type { RunAsync, RunResult } from '../github/run';

import { couldNotRun, TIMED_OUT } from './outcome';

/**
 * What `claude mcp get slack` says (HIVE-123).
 *
 * `claude mcp get` costs **no model turn**, which is why the pane uses it
 * rather than the `-p` probe. What it cannot tell you is whether a workspace
 * admin has approved the server — that needs a real tool call, which is
 * `probe.ts` and the Test button alone.
 *
 * ## Why the asynchronous runner, like every other verb here
 *
 * `mcp get` **health-checks the server over HTTP** — measured at about 1.7 s
 * against the live Slack endpoint, not the "well under a second" a local file
 * read would cost. On `gh.ts`'s `spawnSync` helper that is a network round-trip
 * on the main process's event loop: every IPC reply, every pty chunk and the
 * agent scheduler stall for its duration, and two components ask for this on
 * mount. So it takes `runAsync`, the same shared runner the PR poller,
 * `sessions/git.ts` and the other three Slack verbs already use.
 *
 * The runner is injected exactly as `gh.ts` injects its own, and for the same
 * reason: a test that shelled out would answer differently on every machine.
 */

/**
 * Ten seconds for `claude mcp get`.
 *
 * Shorter than `runAsync`'s twenty-second default, which is sized for `gh`
 * talking to GitHub. This is one health check against one endpoint and it
 * answers in a couple of seconds; ten is the backstop for an endpoint that has
 * stopped answering, and it is what keeps a settings pane from sitting on `…`
 * for twenty seconds before admitting it does not know.
 */
export const SLACK_GET_TIMEOUT_MS = 10_000;

/** `  Status: ✓ Connected` → connected. */
export function parseMcpGet(stdout: string): SlackStatus {
  const line = stdout
    .split('\n')
    .map((row) => row.trim())
    .find((row) => row.startsWith('Status:'));

  if (line === undefined) return { kind: 'not-added' };
  /*
    Matched on the words rather than on the glyph. The tick and the bang are
    decoration and have changed before; "Connected" and "Needs authentication"
    are the message. Strip the Status: label and any leading glyph before matching.

    The glyph is stripped as *non-word characters*, not as a whitespace-delimited
    token. `\S*` assumed a glyph is always there: on a build that printed a bare
    `Status: Connected` it would have eaten the word itself and reported an
    error on a healthy server. `\W+` strips a tick, a bang or nothing at all,
    and can never reach a letter.
  */
  const message = line.replace(/^Status:\s*/, '').replace(/^\W+/, '').trim();
  if (/^connected$/i.test(message)) return { kind: 'connected' };
  if (/^needs authentication$/i.test(message)) return { kind: 'needs-auth' };

  return { kind: 'error', message: line };
}

export async function readSlackStatus(
  claude: string,
  run: RunAsync,
): Promise<SlackStatus> {
  let result: RunResult;

  try {
    /*
      `claude mcp get` searches scopes automatically and does not accept a
      `--scope` argument — attempting to pass one fails with "unknown option".
      It reports servers visible to the current process, which is sufficient:
      agents run with cwd `~/.hive/work/<name>`, a different project entirely,
      so a locally-scoped sign-in would show here and be missing at wake time
      (a third Finding, deferred as Minor).
    */
    result = await run(claude, ['mcp', 'get', SLACK_SERVER_KEY], {
      timeoutMs: SLACK_GET_TIMEOUT_MS,
    });
  } catch (cause) {
    return couldNotRun(cause);
  }

  /*
    `-1` is the runner's marker for a process that died by signal rather than by
    exiting — which is where its timeout kill lands. Folding that into the
    non-zero branch below reported "not signed in" for a `claude` that hung or
    was killed, which is a *different* fact and one the user can act on
    differently. It gets its own answer, and the timeout says so by name.
  */
  if (result.code === -1) {
    return {
      kind: 'error',
      message: result.timedOut
        ? TIMED_OUT
        : 'claude did not exit normally — it may have been interrupted.',
    };
  }

  // Any other non-zero means no such server. stderr carries an unrelated sdk
  // warning on every call, so it is never read.
  if (result.code !== 0) return { kind: 'not-added' };

  return parseMcpGet(result.stdout);
}

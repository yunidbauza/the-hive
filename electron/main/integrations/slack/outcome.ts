import type { SlackStatus } from '@shared/slack-contract';

/**
 * The two ways a Slack verb fails, said once (HIVE-123).
 *
 * `login.ts`, `probe.ts` and `status.ts` each carried their own copy of both,
 * which is three places for the same sentence to drift and — in the case of
 * {@link failure} — three copies of the same hole: a command that failed having
 * printed nothing produced `{ kind: 'error', message: '' }`, which the pane
 * renders as an empty red caption saying nothing at all. A killed process is
 * precisely the case that prints nothing, so that was not a theoretical branch.
 */

/** A run that was still going when its timeout fired. */
export const TIMED_OUT = 'claude did not answer in time. Try again.';

/**
 * A run that failed and said nothing.
 *
 * Names the likely causes rather than leaving the caption blank, because the
 * one thing the CLI did not give us is the reason.
 */
export const SILENT_FAILURE =
  'claude failed without a message — it may have been interrupted.';

/**
 * How much of a failing command's output becomes a caption.
 *
 * The runner caps a child at an 8 MiB `maxBuffer`, and every byte of that was
 * eligible to cross IPC and be rendered into a single `<p>` in the settings
 * pane — a `claude` that failed while streaming would have hung the pane on
 * its own error message. A caption is a sentence or two; two thousand
 * characters is already far more than anyone reads, and it bounds the value at
 * the point where it stops being a stream and becomes a status.
 */
export const MAX_MESSAGE_CHARS = 2_000;

/** The head, because a CLI's first line is the one that names the problem. */
const clamp = (message: string): string =>
  message.length <= MAX_MESSAGE_CHARS
    ? message
    : `${message.slice(0, MAX_MESSAGE_CHARS)}…`;

/**
 * What a command that ran and failed should say.
 *
 * `stderr` first, `stdout` as the fallback: `claude` writes its diagnostics to
 * stderr, but a subcommand that fails by printing usage puts it on stdout.
 *
 * A timeout wins over both. A killed run's partial output is whatever it had
 * got to — for the sign-in that is a "waiting for your browser" line, which as
 * an error message would be actively misleading.
 *
 * Shaped to take the runner's result object so both runners fit: the sync one
 * (`gh.ts`) has no `timedOut` field and the async one (`github/run.ts`) does.
 */
export const failure = (result: {
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}): SlackStatus => {
  if (result.timedOut === true) return { kind: 'error', message: TIMED_OUT };

  const message = (result.stderr.trim() === '' ? result.stdout : result.stderr).trim();

  return {
    kind: 'error',
    message: message === '' ? SILENT_FAILURE : clamp(message),
  };
};

/** A command that could not be executed at all — a bad path, a missing binary. */
export const couldNotRun = (cause: unknown): SlackStatus => ({
  kind: 'error',
  message: `Could not run claude: ${cause instanceof Error ? cause.message : String(cause)}`,
});

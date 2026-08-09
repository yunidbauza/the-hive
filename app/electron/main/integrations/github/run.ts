import { execFile } from 'node:child_process';

/**
 * Running `gh`, asynchronously, for the PR poller.
 *
 * ## Why this is not `gh.ts`'s `runCommand`
 *
 * That one is `spawnSync`, and it is right to be: it answers a settings pane
 * once, when the user opens it. This runs **every minute for as long as the app
 * is open**, and a synchronous spawn blocks the main process's event loop —
 * every IPC reply, every pty chunk and every window event would stall behind
 * each sweep. A poller has to be async or it is a stutter.
 *
 * The execution rules are otherwise `gh.ts`'s, unchanged and for the same
 * reasons: `execFile` semantics with no shell, so there is no command string
 * for a metacharacter to live in; an argv array; a resolved absolute path
 * supplied by the caller, never the bare name; a timeout and a `maxBuffer` cap,
 * because a hung `gh` must not hang the app and unbounded output must not
 * become unbounded memory; and no raw output escapes — callers read named
 * fields out of it and return those.
 *
 * `cwd` is new here and is the one thing this adds. It comes from the config
 * file, already expanded, made absolute and `realpath`'d by `config/resolve.ts`,
 * and never from the renderer.
 */

/** How long a call gets before it is killed. */
const TIMEOUT_MS = 20_000;

/**
 * 8 MiB. A sweep of a dozen repositories with fifty PRs each and a hundred
 * review threads apiece lands around a megabyte; this is deliberate headroom
 * over the worst realistic case rather than a limit anyone should meet.
 */
const MAX_BUFFER = 8 * 1024 * 1024;

export interface RunResult {
  /** The exit code. `-1` when the process was killed rather than exiting. */
  code: number;
  stdout: string;
  stderr: string;
  /** The timeout fired. Told apart from a refusal, because it reads differently. */
  timedOut: boolean;
}

/**
 * Run a program for an answer.
 *
 * Injected everywhere it is used, so the unit tests can answer without
 * executing anything: what is worth testing is how the output is read, and a
 * test that shelled out would answer differently on every machine.
 *
 * **Resolves for a non-zero exit** rather than rejecting. A `gh` that ran and
 * refused has told us something, and a caller that had to catch in order to
 * read it would be catching the normal path. Only a failure to *start* the
 * process — no such file, not executable — rejects.
 */
export type RunAsync = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string },
) => Promise<RunResult>;

export const runAsync: RunAsync = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: options?.cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr, timedOut: false });
          return;
        }

        /**
         * `execFile` reports an exit code as a *number* and a spawn failure as
         * a string like `ENOENT`. The distinction is the whole branch: the
         * first is an answer, the second means nothing ran and there is
         * nothing to read.
         */
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code === 'number') {
          resolve({ code, stdout, stderr, timedOut: false });
          return;
        }

        // A killed process — the timeout, in practice. Reported as such rather
        // than as exit code 0, which would read as success.
        if (error.killed === true || error.signal !== undefined) {
          resolve({ code: -1, stdout, stderr, timedOut: true });
          return;
        }

        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

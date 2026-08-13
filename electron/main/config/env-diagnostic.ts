import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  ENV_PROBE_ARGS,
  buildSessionEnv,
  type EffectiveRuntime,
  type EnvDiagnostic,
  type EnvVarVerdict,
} from '@shared/config-contract';

/**
 * The environment diagnostic (story 108).
 *
 * The design decision this diagnostic exists to make observable: injected
 * env is applied **before** the shell starts, and the login shell that
 * follows sources its rc file **afterward** — which can silently overwrite
 * anything just set. That order is deliberate (the alternative is typing
 * `export` statements into the PTY, which is the arbitrary-code path
 * `UNSAFE_ENV_KEYS` exists to close), but a decision whose consequence is
 * invisible is not a decision the user can act on. Without this, "I set FOO
 * in Settings and it's still the old value" looks like a bug in this app
 * rather than a line in `.zshrc`.
 *
 * Two jobs, split the way `probe.ts` is split from `diagnoseCommand`:
 * {@link compareEnv} reads a `printenv` transcript and is pure, so the
 * interesting logic — what counts as "overridden" — is unit-testable without
 * spawning anything. {@link diagnoseEnv} is the one function in this module
 * that touches a process.
 *
 * **Asynchronous, not `spawnSync`.** A first pass used `spawnSync`, and
 * review caught what that hides: `spawnSync`'s `timeout` only *sends*
 * `killSignal`, it does not guarantee the child actually returns control —
 * measured, a shell running `trap '' TERM; sleep 20` blocked the whole call
 * for 20+ seconds against a 2-second timeout, because the default
 * `killSignal` (`SIGTERM`) can be trapped and ignored. This runs on the
 * **main process**, so that block is every window, every IPC channel and the
 * pty-host pump frozen — triggered by a renderer button, running a
 * user-configured program that executes arbitrary rc code. `execFile`
 * (promisified) fixes both halves: it does not block the event loop while the
 * child runs, and passing `killSignal: 'SIGKILL'` — a signal that cannot be
 * trapped — actually bounds a hostile or hung shell to the timeout. Measured:
 * the same trapping script against the same 2-second timeout now returns in
 * ~2.0s, and the main thread's own timers keep firing the whole time the
 * child is still alive.
 */

const execFileAsync = promisify(execFile);

/** How long the probe shell gets before it is considered hung. */
const TIMEOUT_MS = 5_000;

/**
 * 512 KiB. A `printenv` transcript of even a few hundred variables is tiny.
 *
 * This bounds **both** stdout and stderr — unlike the `spawnSync` version,
 * where stderr was piped to `/dev/null` and never buffered at all,
 * `execFile` buffers both streams against the same `maxBuffer` and rejects
 * if either is exceeded (there is no `execFile` option to discard a stream
 * the way `stdio: [..., 'ignore']` could). Decided not to special-case this:
 * a chatty rc file that overruns 512 KiB of stderr now fails the probe
 * instead of being silently ignored, but a failed probe is already reported
 * as a failed *observation* rather than a bad verdict — the same "fails
 * safely" property every other probe failure has — and discarding stderr
 * properly would mean giving up `execFile`'s built-in buffering for a
 * hand-rolled `spawn` wrapper, more surgery than this fix round should carry
 * for a genuinely rare case.
 */
const MAX_BUFFER = 512 * 1024;

/**
 * Diff what was injected against what the shell actually ended up with.
 *
 * Only the **configured** variables are reported — never the shell's whole
 * environment. Dumping everything would bury the answer in noise the user did
 * not set, and it would put unrelated values (credentials an rc file exports,
 * `PATH`, `HOME`) on screen for no reason tied to this diagnostic's job.
 */
export function compareEnv(
  configured: Record<string, string>,
  printenv: string,
): EnvVarVerdict[] {
  const actual = new Map<string, string>();
  for (const rawLine of printenv.split('\n')) {
    // Split on the FIRST `=` only — an env value legitimately contains one
    // (a URL with a query string, a base64 blob), and splitting anywhere else
    // would truncate it.
    const at = rawLine.indexOf('=');
    if (at <= 0) continue;
    actual.set(rawLine.slice(0, at), rawLine.slice(at + 1));
  }

  return Object.entries(configured).map(([key, value]) => {
    const found = actual.get(key) ?? null;
    return {
      key,
      configured: value,
      // `null` distinctly means "the shell has no such variable at all" —
      // dropped rather than changed — and the view renders that case with its
      // own wording ("dropped by your rc file").
      actual: found,
      overridden: found !== value,
    };
  });
}

/**
 * Turn a rejected probe into one sentence, preserving the distinction between
 * the three ways it can fail.
 *
 * `execFile`'s rejection carries all three as properties on **one** Error
 * object rather than as two separate result fields to check in a particular
 * order — which is what closes off the exact class of bug review flagged in
 * the `spawnSync` version (`result.error` had to be checked *before*
 * `result.status`, because a timeout there reported `status: 0` and would
 * have silently read as a successful, empty-diff run if checked in the wrong
 * order). Here there is only ever one failure path, so `killed` is checked
 * first only because a killed process can also carry a stale, misleading
 * `code` — not because of an ordering hazard between two separate results.
 *
 * Exported since HIVE-84: `config/login-env.ts` runs a shell under the same
 * `execFile` + `SIGKILL` discipline and can fail in exactly these three ways.
 * Shared rather than copied — two hand-written descriptions of the same three
 * failures would drift, and the drift would surface as two Settings panes
 * explaining one broken rc file differently.
 */
export function describeProbeFailure(
  cause: unknown,
  timeoutMs: number,
): string {
  if (!(cause instanceof Error)) return String(cause);

  const err = cause as NodeJS.ErrnoException & {
    killed?: boolean;
    signal?: NodeJS.Signals | null;
  };

  if (err.killed) {
    return `the shell did not finish within ${timeoutMs / 1000}s and was killed (${err.signal ?? 'unknown signal'})`;
  }
  if (typeof err.code === 'number') {
    return `the shell exited with status ${err.code}`;
  }
  // A string code (`ENOENT`, `EACCES`, ...) or none at all: the shell could
  // not even be started. `err.message` already names it plainly, e.g.
  // "spawn /opt/bad-shell ENOENT".
  return err.message;
}

/**
 * Run the resolved shell once, as an interactive login shell, and report what
 * survived.
 *
 * `execFile` with `shell: false` and an argv array — never a shell string —
 * matching the rule `integrations/gh.ts` states for the only other place in
 * `electron/main` that executes another program: the shell here is the
 * *program* being probed, never an interpreter for a string this process
 * assembled.
 *
 * `ENV_PROBE_ARGS` (`-l -i -c printenv`) includes `-i`, not just `-l -c` —
 * see its doc comment in `config-contract.ts` for why the interactive flag is
 * load-bearing rather than decorative.
 *
 * Read-only, so — like `diagnoseCommand` — it does not go through
 * `writeConfig`.
 *
 * A failed probe is a failed *observation*, never a configuration error:
 * reporting it as the latter would tell the user their settings are wrong
 * when all that happened is that this diagnostic could not run. Every way a
 * probe can fail — the shell could not even be started (`ENOENT` for a
 * typo'd path), the shell ran but exited non-zero, or it did not finish
 * before the timeout and was killed — is reported through `error` with
 * `vars: []`, never as a verdict.
 */
export async function diagnoseEnv(
  runtime: EffectiveRuntime,
  projectId: string | null,
  /**
   * Where the probe runs — the same directory a real session for this
   * project would spawn in (`project.path`), or the caller's chosen fallback
   * when there is no such directory (see `ipc/index.ts`'s handler for what it
   * picks and why). Required rather than defaulted here: the whole point of
   * story 108's second fix round is that this must never be silently left as
   * whatever main's own `cwd` happens to be — that was the bug.
   *
   * Anything an rc file keys on the working directory — direnv's `.envrc`,
   * `asdf`/`nodenv`/`pyenv` version files — depends on this matching the real
   * session, exactly like `TERM` does below.
   */
  cwd: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  /**
   * The names a real session would have removed on top of the deny list —
   * `AUTH_ENV_KEYS` when `subscriptionAuth` is on (`sessions/index.ts`).
   *
   * Passed through for the same reason `cwd` and `TERM` are: a probe that kept
   * `ANTHROPIC_API_KEY` would report it as present in an environment where
   * every real session has it stripped, and an rc file that branches on it
   * would take the branch a real session never takes. The whole point of
   * building the probe environment with {@link buildSessionEnv} is that there
   * is one definition; leaving a caller-supplied strip list out of the call
   * would put the divergence back one level up.
   */
  stripEnv: readonly string[] = [],
  /**
   * How long the probe gets before it is killed.
   *
   * Overridable only so the timeout/`SIGKILL` path is unit-testable in
   * bounded time — production never passes this, and always gets
   * {@link TIMEOUT_MS}. A test that had to wait out a real 5-second timeout
   * to prove the kill signal is what actually bounds a hung shell would be a
   * slow test nobody re-runs; one that waits 200ms proves the identical
   * thing.
   */
  timeoutMs: number = TIMEOUT_MS,
): Promise<EnvDiagnostic> {
  try {
    const probe = execFileAsync(runtime.shell, [...ENV_PROBE_ARGS], {
      // The real session's directory, not wherever main happens to be
      // running from — a packaged app's cwd is unrelated to any project
      // (`/` is typical) and an rc file that keys off the directory (direnv,
      // asdf/nodenv/pyenv version files) would diverge otherwise. See the
      // `cwd` parameter doc above.
      cwd,
      // The environment this session would actually spawn with, built the
      // *same way* the pty-host builds a real session's — merged env,
      // deny-list stripped, then `TERM`/`COLORTERM`/`PWD` forced last. Before
      // story 108's fix round this was `{ ...baseEnv, ...runtime.env }` by
      // hand, which left `TERM` however main's own process happened to have
      // it (unset in a packaged app launched from Finder) instead of the
      // `xterm-256color` every real session gets — an rc file that branches
      // on `TERM` would take a different path here than it would for a real
      // session, and silently report a variable as "kept" that a session
      // would actually see overridden.
      env: buildSessionEnv(baseEnv, cwd, runtime.env, stripEnv),
      encoding: 'utf8',
      timeout: timeoutMs,
      // A signal that cannot be trapped or ignored. `SIGTERM` (the default)
      // is what a hostile or merely oh-my-zsh-heavy rc file can catch and
      // sit through — see this module's top comment for the measured 20s+
      // freeze that produced when this diagnostic ran synchronously. This is
      // the second line of defence review asked for, and it is what actually
      // bounds the timeout above to something the app can rely on.
      killSignal: 'SIGKILL',
      maxBuffer: MAX_BUFFER,
      shell: false,
    });

    /**
     * Close stdin immediately, restoring the EOF `spawnSync`'s
     * `stdio: ['ignore', ...]` used to give for free.
     *
     * `execFile` does not accept `stdio` as an option — passing one is
     * silently not forwarded to the underlying `spawn` (measured) — so
     * `child.stdin.end()` on the promise's attached `.child` is the only way
     * to get the same effect. Without it, stdin is an open pipe that never
     * EOFs, and a `read` in an rc file blocks until this probe's own
     * timeout kills it. This is more reachable than it sounds: `-i` (added
     * for the interactive-sourcing fix) is exactly what makes an rc file
     * take its interactive branch, where prompts and `read` live — so a
     * probe that used to resolve instantly could otherwise turn into a
     * multi-second "did not finish … and was killed" for a shell whose real
     * sessions never had a problem.
     */
    probe.child?.stdin?.end();

    const { stdout } = await probe;

    return {
      projectId,
      shell: runtime.shell,
      error: null,
      vars: compareEnv(runtime.env, stdout),
    };
  } catch (cause) {
    return {
      projectId,
      shell: runtime.shell,
      error: describeProbeFailure(cause, timeoutMs),
      vars: [],
    };
  }
}

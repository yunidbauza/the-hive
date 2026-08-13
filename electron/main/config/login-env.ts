import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import { promisify } from 'node:util';

import {
  LOGIN_ENV_DELIMITER,
  LOGIN_ENV_IMPORT_KEYS,
  LOGIN_ENV_PROBE_ARGS,
  LOGIN_ENV_RECORD_SEPARATOR,
} from '@shared/config-contract';
import type { LoginEnvStatus } from '@shared/ipc-contract';

import { describeProbeFailure } from './env-diagnostic';

/**
 * Give this process the `PATH` its user actually has (HIVE-84).
 *
 * ## The defect this closes
 *
 * A macOS app launched from Finder, the Dock or Spotlight inherits **launchd's**
 * environment, not the one a login shell assembles. In a packaged build that
 * means `PATH` is exactly `/usr/bin:/bin:/usr/sbin:/sbin` — four entries, none
 * of which is where anybody installs a developer tool. So `gh` at
 * `/opt/homebrew/bin/gh` is genuinely invisible to this process while being
 * obviously present in the user's terminal, and Settings correctly but
 * uselessly reported "gh was not found".
 *
 * Three modules already *described* this — `config/runtime.ts` explains it for
 * `claude`, `config/shell.ts` explains why `$SHELL` cannot be trusted in the
 * same launch mode, and the Integrations pane said it in prose. What none of
 * them did was act on it. This module is the missing step: ask the login shell
 * once, at startup, and write the answer back into `process.env`.
 *
 * ## Why writing `process.env` is the right seam
 *
 * Every consumer already reads `process.env` **lazily, at call time** — the
 * `gh` probe (`integrations/gh.ts`), `resolveGit` (`sessions/git.ts`), the
 * command diagnostic (`config/runtime.ts`), and the base environment of every
 * session (`sessions/index.ts`). Repairing the one value they all derive from
 * fixes all of them with no change at any call site.
 *
 * **The pty-host is the exception, and it is enforced rather than assumed.**
 * `forkPtyHost` passes no `env`, so the utility process snapshots
 * `process.env` at fork time and keeps it for the life of the app — a lazy
 * read that happens exactly once, unlike every other consumer above. So the
 * `ptySpawn` and `ptyRestart` handlers `await` {@link loginEnvStatus} before
 * the host can come up. An earlier draft of this comment claimed the ordering
 * held on its own; it did not, and a fast click on a slow machine would have
 * frozen launchd's `PATH` into every terminal the app ever opened.
 *
 * The alternative, threading an "effective PATH" parameter through those four
 * call chains, would have produced the same behaviour plus a permanent
 * opportunity for one of them to be missed.
 *
 * ## What it will not do
 *
 * - **It imports an allowlist**, {@link LOGIN_ENV_IMPORT_KEYS}, never the whole
 *   environment. See that constant for why.
 * - **It never overwrites a variable this process already has.** A value
 *   inherited from a real terminal launch, or set by the user, is a deliberate
 *   choice; the login shell is the fallback, not the authority. `PATH` is the
 *   documented exception — it is *merged*, never replaced, so nothing the
 *   launching process supplied is lost.
 * - **It never reports a value.** Two of the three importable variables are
 *   credentials. What leaves this module is which *names* were imported, the
 *   same rule `integrations/gh.ts` follows for reads.
 * - **It cannot hang the app.** `execFile` (never `spawnSync`), a timeout, and
 *   `killSignal: 'SIGKILL'` — the full set of lessons `env-diagnostic.ts`
 *   records from measuring a `trap '' TERM` rc file block the main process for
 *   20+ seconds against a 2-second timeout. This runs at startup on the main
 *   process, so that failure would be a hang before the first window.
 */

const execFileAsync = promisify(execFile);

/**
 * How long the login shell gets before it is killed.
 *
 * The same 5s the environment diagnostic allows. It is a ceiling, not a cost:
 * the import is started at boot and awaited only by the handlers that read
 * `PATH`, so a shell that answers in 200ms — which is the ordinary case — is
 * never waited on at all.
 */
const TIMEOUT_MS = 5_000;

/** 512 KiB, bounding stdout and stderr together, as `diagnoseEnv` does. */
const MAX_BUFFER = 512 * 1024;

/**
 * Run a login shell and hand back what it printed.
 *
 * Injected so the unit tests can answer without executing anything. A test
 * that shelled out for real would assert a different `PATH` on every machine,
 * which is precisely the property this module exists to stop depending on.
 */
export type RunLoginShell = (
  shell: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string }>;

export const runLoginShell: RunLoginShell = async (
  shell,
  args,
  { cwd, env, timeout },
) => {
  const probe = execFileAsync(shell, [...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    // Cannot be trapped or ignored — the second line of defence that makes the
    // timeout above something this process can actually rely on.
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BUFFER,
    shell: false,
  });

  /**
   * Close stdin immediately.
   *
   * `execFile` does not forward a `stdio` option, so this is the only way to
   * give the child an EOF. Without it stdin is a pipe that never closes, and
   * `-i` is exactly the flag that makes an rc file take its interactive branch
   * — where a `read` would block until the timeout kills a probe that had
   * nothing wrong with it.
   */
  probe.child?.stdin?.end();

  const { stdout } = await probe;
  return { stdout };
};

/**
 * Pull the variables out of a transcript that may be wrapped in shell noise.
 *
 * Pure, and exported, because *this* is the part worth testing: what a banner,
 * a `=`-bearing motd, or a value containing an `=` — or a newline — does to
 * the result.
 *
 * **Records are separated by {@link LOGIN_ENV_RECORD_SEPARATOR}, not by
 * newlines (HIVE-86).** Splitting on newlines was correct only for values that
 * contain none, and `PATH` is routinely not one of them: an rc file running
 * `export PATH="$PATH:$(npm bin -g)"` on npm 9+ embeds a multi-line error
 * message in the value. That truncated `PATH` at the first newline, and left a
 * continuation line reading `NAME=value` indistinguishable from a real
 * assignment. NUL cannot appear in an environment value at all, so neither
 * failure is reachable through this parser now.
 *
 * Only the records between the first and last {@link LOGIN_ENV_DELIMITER} are
 * read. A transcript missing either marker yields nothing at all rather than a
 * best effort — a shell that did not get as far as printing both markers did
 * not get as far as reporting its environment either, and parsing its banner
 * would invent variables.
 */
export function parseLoginEnv(stdout: string): Record<string, string> {
  const records = stdout.split(LOGIN_ENV_RECORD_SEPARATOR);
  const first = records.indexOf(LOGIN_ENV_DELIMITER);
  const last = records.lastIndexOf(LOGIN_ENV_DELIMITER);

  if (first === -1 || last === first) return {};

  const vars: Record<string, string> = {};
  for (const raw of records.slice(first + 1, last)) {
    /**
     * Drop the newline `printenv` adds, and only that one.
     *
     * The probe prints each value with `printenv KEY`, which terminates its
     * output with a newline of its own — so every record arrives as
     * `KEY=value\n` and that last byte is the command's punctuation, not part
     * of the value. Exactly one is removed: a value that genuinely ends in a
     * newline arrives as `value\n\n` and must keep one.
     *
     * An unset variable prints nothing at all, so its record is a bare `KEY=`
     * with no newline to remove — which `isSet` then reads as unset.
     */
    const record = raw.endsWith('\n') ? raw.slice(0, -1) : raw;

    // Split on the FIRST `=` only: a value legitimately contains one — a URL
    // with a query string, a base64 blob — and splitting anywhere else would
    // truncate it. The same rule `compareEnv` follows.
    const at = record.indexOf('=');
    if (at <= 0) continue;
    vars[record.slice(0, at)] = record.slice(at + 1);
  }
  return vars;
}

/** Non-empty after trimming. An exported-but-blank variable is not a value. */
function isSet(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** How many entries a `PATH` actually has, ignoring the empty ones. */
function countEntries(path: string | undefined): number {
  if (!isSet(path)) return 0;
  return path.split(delimiter).filter((entry) => entry !== '').length;
}

/**
 * The login shell's entries first, then anything the launching process had
 * that the shell did not.
 *
 * **Merged rather than replaced**, so a `PATH` deliberately set by whoever
 * started the app — a terminal launch, a Playwright fixture, a wrapper script
 * — cannot be silently dropped by an rc file that happens not to mention it.
 * Login-shell order wins for anything present in both, which is what makes a
 * version manager's shim directory shadow a system binary here exactly as it
 * does in the user's terminal.
 */
export function mergePath(loginPath: string, inheritedPath: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const entry of [
    ...loginPath.split(delimiter),
    ...inheritedPath.split(delimiter),
  ]) {
    if (entry === '' || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }

  return merged.join(delimiter);
}

export interface ImportLoginEnvOptions {
  /** `importLoginEnv` from the config. `false` makes this a reported no-op. */
  enabled: boolean;
  /** The login shell to ask — `defaultShell()`, resolved by the caller. */
  shell: string;
  /**
   * The environment to repair. `process.env` in production; a plain object in
   * tests, so nothing a test does can leak into the process running it.
   */
  target?: NodeJS.ProcessEnv;
  run?: RunLoginShell;
  /**
   * Overridable only so the timeout path is testable in bounded time —
   * production never passes it. A test that waited out a real 5-second timeout
   * to prove `SIGKILL` bounds a hung shell would be a slow test nobody re-runs.
   */
  timeoutMs?: number;
  /** Where the probe runs. The user's home, which is where a login shell starts. */
  cwd?: string;
}

/**
 * Ask the login shell, and write the allowlist into `target`.
 *
 * Never throws. Every failure — a shell that cannot be spawned, one that exits
 * non-zero, one that has to be killed, one whose output had no markers — comes
 * back as a `LoginEnvStatus` with `imported: false` and a sentence. Startup
 * must not be able to fail because a diagnostic could not run, and a user with
 * a broken rc file must still get an app, with an explanation of what it can
 * and cannot see.
 */
export async function importLoginEnv({
  enabled,
  shell,
  target = process.env,
  run = runLoginShell,
  timeoutMs = TIMEOUT_MS,
  cwd = homedir(),
}: ImportLoginEnvOptions): Promise<LoginEnvStatus> {
  const inheritedEntries = countEntries(target.PATH);

  const unchanged = (
    error: string | null,
    shellUsed: string | null,
  ): LoginEnvStatus => ({
    enabled,
    imported: false,
    shell: shellUsed,
    inheritedEntries,
    // Deliberately equal, not zero: the pane renders the pair as a comparison,
    // and a no-op has to read as one.
    effectiveEntries: inheritedEntries,
    varsImported: [],
    error,
  });

  if (!enabled) return unchanged(null, null);

  let vars: Record<string, string>;
  try {
    const { stdout } = await run(shell, LOGIN_ENV_PROBE_ARGS, {
      cwd,
      env: target,
      timeout: timeoutMs,
    });
    vars = parseLoginEnv(stdout);
  } catch (cause) {
    return unchanged(describeProbeFailure(cause, timeoutMs), shell);
  }

  if (Object.keys(vars).length === 0) {
    return unchanged(
      'the shell ran but printed no environment between the markers — its output may have been truncated, or an rc file may exit early',
      shell,
    );
  }

  const varsImported: string[] = [];

  for (const key of LOGIN_ENV_IMPORT_KEYS) {
    const value = vars[key];
    if (!isSet(value)) continue;

    if (key === 'PATH') {
      // The one key that is merged rather than skipped-when-present: this
      // process always has *a* `PATH`, so "only when absent" would make the
      // whole import a no-op.
      const merged = mergePath(value, target.PATH ?? '');
      if (merged !== target.PATH) {
        target.PATH = merged;
        varsImported.push(key);
      }
      continue;
    }

    // Everything else: the inherited value wins. A token already in this
    // process's environment was put there deliberately — by a terminal launch
    // or a wrapper — and an rc file must not quietly swap the credential the
    // app authenticates with.
    if (isSet(target[key])) continue;

    target[key] = value;
    varsImported.push(key);
  }

  return {
    enabled,
    imported: varsImported.length > 0,
    shell,
    inheritedEntries,
    effectiveEntries: countEntries(target.PATH),
    varsImported,
    /**
     * A probe that ran cleanly and changed nothing is not an error.
     *
     * It is the ordinary result of launching from a terminal — the environment
     * was already the login shell's. Reporting it as a failure would put a
     * warning in front of the users who have nothing wrong.
     */
    error: null,
  };
}

/**
 * The one import, started once.
 *
 * Memoised as a promise rather than as a result, so the readers that need the
 * repaired `PATH` can await the *same* in-flight probe instead of racing it or
 * starting a second one. `main/index.ts` kicks it off at boot; `ipc/index.ts`
 * awaits it in the handlers that read `PATH`. Nothing awaits it before the
 * window is created — a slow rc file must not delay the first paint.
 */
let inFlight: Promise<LoginEnvStatus> | null = null;

export function startLoginEnvImport(
  options: ImportLoginEnvOptions,
): Promise<LoginEnvStatus> {
  inFlight ??= importLoginEnv(options);
  return inFlight;
}

/**
 * What the import did, awaiting it if it is still running.
 *
 * Returns a disabled-shaped status when nothing ever started it, which is the
 * honest answer for a unit test or a harness that skipped boot — not a claim
 * that an import happened.
 */
export async function loginEnvStatus(): Promise<LoginEnvStatus> {
  return (
    inFlight ?? {
      enabled: false,
      imported: false,
      shell: null,
      inheritedEntries: countEntries(process.env.PATH),
      effectiveEntries: countEntries(process.env.PATH),
      varsImported: [],
      error: null,
    }
  );
}

/** Test seam: forget the memoised import so the next call starts a fresh one. */
export function resetLoginEnvImport(): void {
  inFlight = null;
}

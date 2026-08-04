import { spawnSync } from 'node:child_process';

import type {
  EffectiveRuntime,
  EnvDiagnostic,
  EnvVarVerdict,
} from '@shared/config-contract';

/**
 * The environment diagnostic (story 108).
 *
 * The design this diagnostic exists to make observable: injected environment
 * is applied **before** the shell starts, and the login shell that follows
 * sources its rc file **afterward** — which can silently overwrite anything
 * just set. That order is deliberate (the alternative is typing `export`
 * statements into the PTY, which is the arbitrary-code path
 * `UNSAFE_ENV_KEYS` exists to close), but a decision whose consequence is
 * invisible is not a decision the user can act on. Without this, "I set FOO
 * in Settings and it's still the old value" looks like a bug in this app
 * rather than a line in `.zshrc`.
 *
 * Two jobs, split the way `probe.ts` is split from `diagnoseCommand`:
 * {@link compareEnv} reads a `printenv` transcript and is pure, so the
 * interesting logic — what counts as "overridden" — is unit-testable without
 * spawning anything. {@link diagnoseEnv} is the one function in this module
 * that touches a process, and it does the least amount of work it can once it
 * has a transcript in hand.
 */

/** How long the probe shell gets before it is considered hung. */
const TIMEOUT_MS = 5_000;

/** 512 KiB. A `printenv` transcript of even a few hundred variables is tiny. */
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
 * Run the resolved shell once, as a login shell, and report what survived.
 *
 * `spawnSync` with `shell: false` and an argv array — never a shell string —
 * matching the rule `integrations/gh.ts` states for the only other place in
 * `electron/main` that executes another program: the shell here is the
 * *program* being probed, never an interpreter for a string this process
 * assembled. `spawnSync` rather than `execFileSync` for consistency with that
 * established precedent: `execFileSync` throws on a non-zero exit and on a
 * failed spawn alike, which would force this function back into a try/catch
 * that re-derives the same distinction `gh.ts`'s `result.error` / `result.status`
 * check already makes explicit.
 *
 * Read-only, so — like `diagnoseCommand` — it does not go through
 * `writeConfig`.
 *
 * A failed probe is a failed *observation*, never a configuration error:
 * reporting it as the latter would tell the user their settings are wrong
 * when all that happened is that this diagnostic could not run. Both ways a
 * probe can fail — the shell could not even be started (`result.error`, e.g.
 * `ENOENT` for a typo'd path) and the shell ran but did not finish cleanly
 * (a non-zero exit, or a signal from the timeout) — are reported through
 * `error` with `vars: []`, never as a verdict.
 */
export function diagnoseEnv(
  runtime: EffectiveRuntime,
  projectId: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
): EnvDiagnostic {
  const result = spawnSync(runtime.shell, ['-l', '-c', 'printenv'], {
    // The merged env this session would actually spawn with, not the
    // process's own — a project that overrides a variable must be diagnosed
    // against *its* value, or this describes a session nobody is running.
    env: { ...baseEnv, ...runtime.env },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    shell: false,
    // An rc file that writes to stderr is normal and is not this diagnostic's
    // business; stdin is closed so a shell that decided to prompt cannot hang
    // waiting on a terminal this process does not have.
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.error !== undefined) {
    return {
      projectId,
      shell: runtime.shell,
      error: result.error.message,
      vars: [],
    };
  }

  if (result.status !== 0) {
    const detail =
      result.status === null
        ? `it was killed by signal ${result.signal ?? 'unknown'}`
        : `it exited with status ${result.status}`;
    return {
      projectId,
      shell: runtime.shell,
      error: `the shell did not run to completion — ${detail}`,
      vars: [],
    };
  }

  return {
    projectId,
    shell: runtime.shell,
    error: null,
    vars: compareEnv(runtime.env, result.stdout ?? ''),
  };
}

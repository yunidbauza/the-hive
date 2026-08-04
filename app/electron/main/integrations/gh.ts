import { spawnSync } from 'node:child_process';

import type { GhStatus, GhTokenSource } from '../../shared/ipc-contract';
import { probeCommand } from '../config/probe';

/**
 * What this machine's `gh` looks like from here (story 106).
 *
 * ## Why this is allowed to execute a program, and how
 *
 * This is the first place in `electron/main` that runs another binary —
 * `node-pty` lives in the pty-host utility process, not here — so the rules are
 * written down rather than assumed:
 *
 * 1. **`execFile` semantics, never a shell.** `spawnSync` with `shell: false`
 *    and an argv array. There is no command *string* for a metacharacter to
 *    live in.
 * 2. **The resolved absolute path is what runs**, never the bare name `gh`.
 *    Resolving once with {@link probeCommand} and executing that exact path
 *    closes the window in which `PATH` could resolve to something different
 *    between the check and the run.
 * 3. **argv is a constant.** The IPC verb that reaches this takes no payload at
 *    all, so nothing from the renderer can appear in an argument. That is the
 *    security design, not an omission.
 * 4. **Bounded.** A timeout and a `maxBuffer` cap, because a hung `gh` must not
 *    hang the settings pane, and unbounded output must not become unbounded
 *    memory.
 * 5. **No raw output escapes.** The result is assembled from named fields that
 *    were matched out of the output; stdout and stderr are never returned.
 *    `--show-token` is never passed.
 *
 * ## Why it reports a token source and never a token
 *
 * The PR panel is fixture-backed — nothing in this app fetches from GitHub — so
 * a token stored here would be a credential no code reads, living in a
 * plaintext file the product encourages the user to hand-edit. Which source
 * *would* supply one is the genuinely useful answer, and it costs nothing to be
 * honest about. Only the **presence** of an environment variable is ever read;
 * the value is never loaded, logged, or returned.
 */

/** How long `gh` gets before it is considered hung. */
const TIMEOUT_MS = 5_000;

/** 512 KiB. `gh auth status` prints a dozen lines; this is already generous. */
const MAX_BUFFER = 512 * 1024;

/**
 * Run a program for a *fact*.
 *
 * Injected everywhere it is used so the unit tests can answer without
 * executing anything — what is worth testing is how output is read, and a test
 * that shelled out would answer differently on every machine.
 */
export type RunCommand = (
  file: string,
  args: readonly string[],
) => { code: number; stdout: string; stderr: string };

export const runCommand: RunCommand = (file, args) => {
  const result = spawnSync(file, [...args], {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
    shell: false,
    // Nothing is written to it, but leaving stdin inherited would let a program
    // that decided to prompt block on a terminal this process does not have.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error !== undefined) throw result.error;

  return {
    // `null` is a signalled death — a timeout kill lands here. Reported as a
    // failure rather than as a zero, which would read as success.
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

/** `gh version 2.62.0 (2024-11-14)` → `2.62.0`. */
const VERSION = /^gh version (\S+)/m;

/** `✓ Logged in to github.com account octocat (keyring)` → `octocat`. */
const ACCOUNT = /Logged in to \S+ account (\S+)/;

/**
 * The variables `gh` itself consults, in `gh`'s own precedence order.
 *
 * Order is load-bearing: reporting `GITHUB_TOKEN` while `gh` would use
 * `GH_TOKEN` would send a user editing the variable that is not being read.
 */
const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

function envToken(
  env: NodeJS.ProcessEnv,
): (typeof TOKEN_VARS)[number] | null {
  for (const name of TOKEN_VARS) {
    // Presence only — never the value. An exported-but-empty variable is unset
    // as far as `gh` is concerned, and reporting it would be a false positive
    // on a very common shell-profile pattern.
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return name;
  }
  return null;
}

const NOT_INSTALLED = {
  version: null,
  authenticated: false,
  account: null,
  error: null,
} as const;

export function readGhStatus(
  env: NodeJS.ProcessEnv,
  run: RunCommand,
): GhStatus {
  const path = env.PATH ?? '';
  const { resolved, probes } = probeCommand('gh', path);
  const envVar = envToken(env);

  if (resolved === null) {
    return {
      ...NOT_INSTALLED,
      installed: false,
      resolved: null,
      path,
      probes,
      // Still reported: an environment token is where one *would* come from,
      // and saying "none" here would be wrong in the one case the user has
      // actually configured something.
      tokenSource: envVar === null ? 'none' : 'env',
      envVar,
    };
  }

  let version: string | null = null;
  let authenticated = false;
  let account: string | null = null;
  let error: string | null = null;

  try {
    const versionResult = run(resolved, ['--version']);
    version = VERSION.exec(versionResult.stdout)?.[1] ?? null;

    /**
     * A non-zero exit is the ordinary "not logged in" answer.
     *
     * `gh auth status` exits 1 when no host is authenticated, which is a state,
     * not a failure. Treating it as an error would put a red banner in front of
     * every user who has simply not run `gh auth login`.
     */
    const authResult = run(resolved, ['auth', 'status']);
    if (authResult.code === 0) {
      authenticated = true;
      // `gh` prints this to stdout on success and stderr on some versions, so
      // both are searched — the account name is the only thing taken from
      // either, and nothing else from the output is kept.
      account =
        ACCOUNT.exec(authResult.stdout)?.[1] ??
        ACCOUNT.exec(authResult.stderr)?.[1] ??
        null;
    }
  } catch (cause) {
    // A timeout or a binary that could not be executed. Recorded and returned,
    // never thrown: the settings pane must render either way, and a section
    // that throws because an external tool misbehaved tells the user this app
    // is broken.
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const tokenSource: GhTokenSource =
    envVar !== null ? 'env' : authenticated ? 'keyring' : 'none';

  return {
    installed: true,
    resolved,
    path,
    probes,
    version,
    authenticated,
    account,
    tokenSource,
    envVar,
    error,
  };
}

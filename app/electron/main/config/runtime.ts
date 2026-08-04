import type {
  CommandDiagnostic,
  ConfigSnapshot,
  EffectiveRuntime,
  ProjectConfig,
} from '../../shared/config-contract';

import { probeCommand } from './probe';

/**
 * What a session actually spawns with, and why (story 104).
 *
 * Two jobs, deliberately in one module: resolving the effective runtime, and
 * explaining where the command was looked for. Keeping them together is what
 * guarantees the diagnostic describes the *same* values the spawn path uses —
 * a diagnostic that resolved its own `PATH` would eventually reassure the user
 * about an environment no session runs in, which is exactly the failure it
 * exists to prevent.
 *
 * The filesystem search itself moved to `probe.ts` in story 106, when `gh`
 * detection needed the identical question asked. That does not weaken the
 * pairing above: choosing the command and the `PATH` — the part that must match
 * the spawn path — still happens here.
 */

/**
 * Resolve one project's runtime against the snapshot's top-level values.
 *
 * A project override wins; absent means inherit. There is no third state —
 * `parse.ts` already rejects a blank override and drops it, so an empty string
 * never reaches here to be mistaken for a deliberate choice.
 *
 * `project` is nullable because the top-level command is diagnosable on its own,
 * before any project is selected.
 */
export function effectiveRuntime(
  snapshot: ConfigSnapshot,
  project: ProjectConfig | null,
): EffectiveRuntime {
  const shellFromProject = project?.shell !== undefined;
  const commandFromProject = project?.claudeCommand !== undefined;

  return {
    shell: project?.shell ?? snapshot.shell,
    claudeCommand: project?.claudeCommand ?? snapshot.claudeCommand,
    // A fresh object every call: the caller passes this to the pty-host, and
    // handing out the snapshot's own map would let a mutation downstream edit
    // the cached config.
    env: { ...(project?.env ?? {}) },
    shellFromProject,
    commandFromProject,
  };
}

/**
 * Explain where a command was looked for, and what was found (story 104).
 *
 * The epic asks for "a PATH diagnostic that says why `claude` was not found".
 * The honest answer is nearly always that **the app's `PATH` is not the login
 * shell's `PATH`**: a GUI app launched from Finder or Dock inherits launchd's
 * environment, not the one `.zshrc` assembles, so a `claude` installed by a
 * version manager is genuinely absent from where the app can see — while being
 * obviously present in the user's terminal. Reporting the `PATH` that was
 * actually searched is what turns "command not found" into something the user
 * can act on.
 *
 * Read-only: it stats files and writes nothing, so it does not go through
 * `writeConfig`.
 *
 * `env` is the **merged** environment the session would get, not
 * `process.env` — a project that sets its own `PATH` must be diagnosed against
 * that `PATH`, or the diagnostic describes a session nobody is running.
 *
 * **POSIX only, deliberately.** `PATHEXT` is not consulted, so on Windows a
 * `claude.cmd` would be reported as not found. That is consistent rather than
 * wrong: the whole session model is POSIX today — `DEFAULT_SHELL` is
 * `/bin/sh`, `LOGIN_SHELL_ARGS` is `['-l']`, and nothing packages a Windows
 * build. Teaching only the diagnostic about Windows would make it describe a
 * session this app cannot start.
 */
export function diagnoseCommand(
  runtime: EffectiveRuntime,
  projectId: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
): CommandDiagnostic {
  const command = runtime.claudeCommand;
  const path = runtime.env.PATH ?? baseEnv.PATH ?? '';

  // The search itself lives in `probe.ts` (story 106), because `gh` detection
  // asks the identical question. What stays here is the part that is specific
  // to *this* diagnostic: which command to look for, and which `PATH` the
  // session would really use.
  const { isPath, resolved, probes } = probeCommand(command, path);

  return { projectId, command, isPath, resolved, path, probes };
}

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, sep } from 'node:path';

import type {
  CommandDiagnostic,
  ConfigSnapshot,
  EffectiveRuntime,
  PathProbe,
  ProjectConfig,
} from '../../shared/config-contract';

/**
 * What a session actually spawns with, and why (story 104).
 *
 * Two jobs, deliberately in one module: resolving the effective runtime, and
 * explaining where the command was looked for. Keeping them together is what
 * guarantees the diagnostic describes the *same* values the spawn path uses —
 * a diagnostic that resolved its own `PATH` would eventually reassure the user
 * about an environment no session runs in, which is exactly the failure it
 * exists to prevent.
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
 * Whether a file exists and is executable by this process.
 *
 * `accessSync` with `X_OK` rather than reading the mode bits: the answer
 * depends on the process's uid/gid and on ACLs, and re-deriving that from
 * `statSync().mode` gets it wrong for exactly the users who have an unusual
 * setup — which is the population asking why `claude` was not found.
 */
function isExecutable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether a file exists at all, executable or not. */
function exists(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
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

  /**
   * A command containing a separator is used as a path, not searched for.
   *
   * This mirrors what a shell does, and it matters here: reporting "not found
   * on PATH" for `/opt/homebrew/bin/claude` would send the user editing a
   * `PATH` that was never consulted.
   */
  const isPath = command.includes(sep) || command.includes('/');

  if (isPath) {
    /**
     * A *relative* path is reported as unresolved rather than probed.
     *
     * It would be resolved against the session's cwd — the project directory —
     * which this process does not share, so stat-ing it here would answer a
     * different question than the one the user asked. Saying "not found" for
     * `./bin/claude` is honest; claiming to have found it would not be.
     */
    return {
      projectId,
      command,
      isPath: true,
      resolved:
        isAbsolute(command) && isExecutable(command) ? command : null,
      path,
      probes: [],
    };
  }

  const probes: PathProbe[] = [];
  let resolved: string | null = null;

  for (const directory of path.split(delimiter)) {
    // An empty entry means "the current directory" to some shells. Probing it
    // would report a result that depends on a cwd this process does not share
    // with the session, so it is skipped rather than guessed at.
    if (directory === '') continue;

    const candidate = join(directory, command);
    const found = isExecutable(candidate);
    const probe: PathProbe = { directory, found };

    // The genuinely confusing case, called out rather than shown as "not
    // found": the file is right there, and the reason it does not run is a
    // missing +x bit.
    if (!found && exists(candidate)) probe.notExecutable = true;

    probes.push(probe);
    if (found && resolved === null) resolved = candidate;
  }

  return { projectId, command, isPath: false, resolved, path, probes };
}

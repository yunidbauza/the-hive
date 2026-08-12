import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, sep } from 'node:path';

import type { PathProbe } from '../../shared/config-contract';

/**
 * Look for a command, and report where you looked (story 106).
 *
 * This search is story 104's, unchanged — it was inlined in `diagnoseCommand`
 * until this story needed the identical question asked about `gh`. Extracted
 * rather than copied: two copies of "where does this app think its binaries
 * are" would drift, and the drift would surface as two screens giving a user
 * different answers about the same `PATH`.
 *
 * It decides nothing about what the result *means*. `diagnoseCommand` turns it
 * into an explanation of a failed spawn; `integrations/gh.ts` turns it into an
 * installed/not-installed answer. Neither meaning belongs here.
 *
 * **POSIX only, deliberately.** `PATHEXT` is not consulted, so on Windows a
 * `gh.cmd` would be reported as not found. That stays consistent with the rest
 * of the session model — `DEFAULT_SHELL` is `/bin/sh`, `LOGIN_SHELL_ARGS` is
 * `['-l']`, and nothing packages a Windows build.
 */
export interface CommandProbe {
  /** The command was used as a path, not searched for on `PATH`. */
  isPath: boolean;
  /** Absolute path to the executable that would run, or `null`. */
  resolved: string | null;
  /** Every directory consulted, in order. Empty when `isPath`. */
  probes: PathProbe[];
}

/**
 * Whether a file exists and is executable by this process.
 *
 * `accessSync` with `X_OK` rather than reading the mode bits: the answer
 * depends on the process's uid/gid and on ACLs, and re-deriving that from
 * `statSync().mode` gets it wrong for exactly the users who have an unusual
 * setup — which is the population asking why a command was not found.
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

export function probeCommand(command: string, path: string): CommandProbe {
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
      isPath: true,
      resolved: isAbsolute(command) && isExecutable(command) ? command : null,
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

  return { isPath: false, resolved, probes };
}

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Resolving `claudeCommand` to something `spawn` can run (HIVE-115).
 *
 * ## Why an agent does not go through the shell
 *
 * A session's command line is *typed into* a login shell
 * (`sessions/bootstrap.ts`), so the user's own `claude` — which on a developer
 * machine is routinely a shell function or alias — is what runs. An agent is
 * spawned with an argv array and no shell, so a function is unreachable.
 *
 * That is the desired outcome rather than a limitation to work around. A
 * wrapper function that appends `--dangerously-skip-permissions` is a
 * reasonable thing to want in a terminal you are watching, and exactly the
 * wrong thing to inherit in an unattended background turn.
 *
 * ## Why arguments are refused rather than split
 *
 * Splitting `claude --tel` means re-implementing shell word-splitting and
 * quoting — the surface the argv array exists to avoid. Sessions keep
 * honouring such a value; agents say so instead of guessing.
 */

export type ClaudeResolution = { path: string } | { problem: string };

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function resolveClaude(
  command: string,
  pathVar: string | undefined,
  isExecutable: (path: string) => boolean = isExecutableFile,
): ClaudeResolution {
  const trimmed = command.trim();

  if (trimmed === '') return { problem: 'No claude command is configured.' };

  /*
    The disk gets asked before the whitespace rule does, and the order matters.

    A space in an absolute path is not an argument, it is a space:
    `/Users/me/Application Support/bin/claude` is an ordinary macOS path, and
    refusing it told the user to "set Settings › Runtime to a plain path" —
    which is exactly what they had done. Asking `isExecutable` first settles it
    with the only authority that can: if a file is there and runnable, the whole
    string was one path and there was never an argument to split.

    The refusal below still stands for everything that fails that test, which is
    where `claude --tel` lands. See the module comment for why it is a refusal
    rather than an attempt at shell word-splitting.
  */
  if (isAbsolute(trimmed) && isExecutable(trimmed)) return { path: trimmed };

  if (/\s/.test(trimmed)) {
    return {
      problem:
        `The configured claude command \`${trimmed}\` carries arguments. ` +
        'An agent is spawned without a shell, so it needs a single ' +
        'executable — set Settings › Runtime to a plain path.',
    };
  }

  if (isAbsolute(trimmed)) {
    return { problem: `\`${trimmed}\` is not an executable file.` };
  }

  if (pathVar === undefined || pathVar === '') {
    return { problem: `Cannot look for \`${trimmed}\`: PATH is empty.` };
  }

  for (const dir of pathVar.split(delimiter)) {
    if (dir === '') continue;

    const candidate = join(dir, trimmed);

    if (isExecutable(candidate)) return { path: candidate };
  }

  return {
    problem:
      `\`${trimmed}\` was not found on PATH. An agent runs without a shell, ` +
      'so a shell function or alias of that name cannot be used.',
  };
}

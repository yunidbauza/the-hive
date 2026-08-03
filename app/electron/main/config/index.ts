import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CONFIG_PATH_ENV,
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_SHELL,
  emptySnapshot,
  type ConfigSnapshot,
} from '@shared/config-contract';

import { parseConfig } from './parse';
import { resolveProjects } from './resolve';
import { CONFIG_TEMPLATE } from './template';

/**
 * The workspace config (story 090).
 *
 * Read once at startup and on an explicit reload. **Not watched** — a file
 * watcher is out of scope, and a config that changes under a live session
 * would raise questions about what happens to the PTY already running in the
 * old directory that this story is not the place to answer.
 *
 * Nothing here throws. A failing entry disables that project and is reported;
 * a malformed file disables all of them and is reported. One mistyped path
 * must not stop the app from launching — but it must be *visible*, because a
 * silently dropped project looks like a bug in the app rather than a typo in a
 * file.
 */

const LABEL = 'config';

/**
 * Where the config lives.
 *
 * Read from the environment on every call rather than captured at module load:
 * story 085's Playwright fixture sets `HIVE_CONFIG_PATH` per test, and a
 * value frozen at import time would make the first spec to load this module
 * decide the path for all of them.
 */
export function configPath(): string {
  const override = process.env[CONFIG_PATH_ENV];
  if (override !== undefined && override.trim() !== '') return override;
  return join(homedir(), '.hive', 'config.json');
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * First run: create the directory, write the template, carry on.
 *
 * `wx` rather than `w` — if something created the file between the failed read
 * and this write, that file is the user's and must not be clobbered by a
 * template. The resulting `EEXIST` is reported like any other write failure and
 * the next load reads what is actually there.
 */
function writeTemplate(path: string, shell: string): ConfigSnapshot {
  const snapshot = emptySnapshot(path, shell);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, CONFIG_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
    snapshot.templateWritten = true;
    // Logged once, because a file the user has never seen is a file they
    // cannot edit. This is the only line that tells them where it is.
    console.info(`[hive] no workspace config found — wrote a template to ${path}`);
  } catch (cause) {
    snapshot.errors.push(
      `${LABEL}: could not create ${path} (${describe(cause)}) — no project is spawnable`,
    );
  }
  return snapshot;
}

/** Read, parse, and resolve the config file. Always returns a snapshot. */
export function loadConfig(): ConfigSnapshot {
  const path = configPath();
  const shell = process.env.SHELL ?? DEFAULT_SHELL;

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return writeTemplate(path, shell);
    }
    const snapshot = emptySnapshot(path, shell);
    snapshot.errors.push(
      `${LABEL}: could not read ${path} (${describe(cause)}) — no project is spawnable`,
    );
    return snapshot;
  }

  const parsed = parseConfig(text, LABEL);
  const projects = resolveProjects(parsed.projects, parsed.errors);

  return {
    configPath: path,
    templateWritten: false,
    shell: parsed.shell ?? shell,
    claudeCommand: parsed.claudeCommand ?? DEFAULT_CLAUDE_COMMAND,
    projects,
    errors: parsed.errors,
  };
}

let cached: ConfigSnapshot | null = null;

/** The snapshot every consumer reads. Loads on first use. */
export function getConfig(): ConfigSnapshot {
  cached ??= loadConfig();
  return cached;
}

/** Re-read the file. This is what `window.hive.config.reload()` reaches. */
export function reloadConfig(): ConfigSnapshot {
  cached = loadConfig();
  return cached;
}

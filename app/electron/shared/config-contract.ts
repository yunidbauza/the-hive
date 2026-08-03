/**
 * The workspace config contract (story 090).
 *
 * `~/.hive/config.json` is where the user says which of the fixture projects
 * map to real directories on this machine. A PTY needs a `cwd`; this file is
 * the smallest thing that supplies one.
 *
 * It lives in `electron/shared/` for the same reason `ipc-contract.ts` does:
 * main validates the file, the renderer renders the verdict, and both must
 * agree about the shape at compile time rather than by convention. Types and
 * constants only — no Node APIs, no DOM APIs.
 */

/**
 * Why an entry is or is not usable.
 *
 * A closed set, and each member names something the *user* can act on. A
 * generic `'invalid'` would be honest and useless: the whole point of surfacing
 * the reason is that "I typed the path wrong" and "I pointed at a file" are
 * different mistakes with different fixes.
 */
export type ProjectStatus =
  | 'ok'
  | 'missing'
  | 'not-a-directory'
  | 'not-absolute'
  | 'duplicate-id';

export interface ProjectConfig {
  /** Matches a fixture project id. That is the whole mapping. */
  id: string;
  /** The resolved, symlink-free absolute path — or `null` when unusable. */
  path: string | null;
  status: ProjectStatus;
}

/**
 * What `window.hive.config.get()` answers with.
 *
 * Note there is no `ok` / `valid` flag. A snapshot is always returned, even for
 * a malformed file: one mistyped path must not stop the app from launching, so
 * failure is expressed per entry and in {@link ConfigSnapshot.errors}, never as
 * an absent snapshot.
 */
export interface ConfigSnapshot {
  /** The file that was read — `HIVE_CONFIG_PATH` or `~/.hive/config.json`. */
  configPath: string;
  /**
   * True when no file existed and a template was written during this load.
   *
   * The renderer uses it for the first-run notice. It is deliberately not an
   * error: no config file is the normal state on a fresh machine.
   */
  templateWritten: boolean;
  /** The login shell for every session, already defaulted from `$SHELL`. */
  shell: string;
  /** The bootstrap command a session runs (story 096), already defaulted. */
  claudeCommand: string;
  /** Every entry the file declared, in file order, each with its verdict. */
  projects: ProjectConfig[];
  /**
   * Human-readable problems, in the order they were found.
   *
   * Populated for file-level failures (unreadable, malformed JSON, wrong
   * version, an unknown top-level key) *and* for every rejected entry, so the
   * renderer can show a reason without re-deriving one from a status code.
   */
  errors: string[];
}

/** The only config schema version this build understands. */
export const CONFIG_VERSION = 1;

/** Used when the file names no shell and `$SHELL` is unset. */
export const DEFAULT_SHELL = '/bin/sh';

/** Used when the file names no bootstrap command (story 096). */
export const DEFAULT_CLAUDE_COMMAND = 'claude';

/**
 * The env var that relocates the config file.
 *
 * The escape hatch story 085 already depends on — its Playwright fixture sets
 * this so a spec can never point a real `claude` at the developer's real
 * working tree.
 */
export const CONFIG_PATH_ENV = 'HIVE_CONFIG_PATH';

/**
 * A snapshot with nothing configured.
 *
 * Exported because both the first-run path and the malformed-file path need
 * exactly this, and because the renderer's own tests want one without
 * hand-assembling six fields.
 */
export function emptySnapshot(
  configPath: string,
  shell: string = DEFAULT_SHELL,
): ConfigSnapshot {
  return {
    configPath,
    templateWritten: false,
    shell,
    claudeCommand: DEFAULT_CLAUDE_COMMAND,
    projects: [],
    errors: [],
  };
}

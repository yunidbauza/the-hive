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

/** Where a project entry came from. `cloned` is written by story 102. */
export type ProjectOrigin = 'local' | 'cloned';

export interface ProjectConfig {
  /**
   * Stable, derived once from the directory basename (story 101).
   *
   * Story 090 required this to match a fixture project id. Story 101 reverses
   * that: the config now *declares* projects, and the fixtures are the
   * fallback rather than the schema.
   */
  id: string;
  /** Display name. Defaults to the resolved directory's basename. */
  name: string;
  /** The resolved, symlink-free absolute path — or `null` when unusable. */
  path: string | null;
  /** Phosphor icon name, as `Icon` spells them. */
  icon: string;
  origin: ProjectOrigin;
  status: ProjectStatus;
  /**
   * Whether the resolved directory is a git repository.
   *
   * Derived on load and **never written to the file** — like {@link status}.
   * Keeping it out of the config means a hand-edited file cannot lie about it,
   * and a directory that is `git init`-ed after being added reports correctly
   * on the next load.
   */
  isRepo: boolean;
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

/** The schema version this build writes (story 101). */
export const CONFIG_VERSION = 2;

/**
 * Versions the reader accepts.
 *
 * A v1 file is read normally and upgraded **in memory** — `name` from the
 * resolved directory's basename, a default `icon`, `origin: 'local'` — and
 * rewritten as v2 only when the user first saves something. Reading someone's
 * file and rewriting it before they asked for anything is not a migration, it
 * is a surprise. A v1 file the user never edits through the UI stays v1 forever
 * and keeps working.
 */
export const SUPPORTED_CONFIG_VERSIONS: readonly number[] = [1, 2];

/** What a project entry gets when the file names no icon. */
export const DEFAULT_PROJECT_ICON = 'ph-folder';

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

/**
 * Payload of `config:add-project` (story 101).
 *
 * The path is one the user chose, usually through the native dialog. It is
 * **re-validated in main from scratch** — expanded, made absolute, `realpath`'d,
 * confirmed to be a directory — because the dialog is a UX step, not a
 * capability grant: a renderer that skipped it and posted a path directly gets
 * exactly the same treatment.
 */
export interface AddProjectRequest {
  path: string;
  /** Optional display name. Defaults to the directory basename. */
  name?: string;
}

/** Payload of `config:remove-project` (story 101). */
export interface RemoveProjectRequest {
  id: string;
}

/**
 * The entity id a clone's terminal runs under (story 102).
 *
 * Reserved, single, and not a real entity: it is the id the existing PTY
 * channels carry clone traffic on, which is what lets the clone terminal be
 * *typable*. `pty:write` routes through the sessions layer's id translation
 * (`electron/main/ipc/index.ts`), so a clone that bypassed the registry would
 * stream output fine and silently swallow every keystroke — and no credential
 * or host-key prompt could ever be answered, which is the whole reason this
 * story runs `git` in a PTY at all.
 *
 * Being a single id also caps concurrency at one clone, which the focused
 * sub-view already implies.
 *
 * **The dot is load-bearing, and so is the absence of a colon.**
 *
 * This id travels on `pty:write` as `sessionId`, where `assertId` requires
 * `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`. An id with a colon fails that guard,
 * and because `pty:write` is a `send` channel the rejection is logged and
 * dropped rather than returned — so every keystroke would vanish silently and
 * no credential prompt could ever be answered, which is the one thing this
 * whole design exists to make possible.
 *
 * The dot also makes collision impossible: `deriveProjectId` (story 101) kebabs
 * a directory basename to `[a-z0-9-]`, so no project can ever be given this id.
 */
export const CLONE_ENTITY_ID = 'hive.clone';

/**
 * Payload of `config:clone-start` (story 102).
 *
 * Note what is **absent**: a destination. The renderer supplies the *parent*
 * directory and the URL; main derives the final path segment from the URL
 * itself. That is how this story keeps the epic's rule that no verb takes a
 * destination path (`stories/100-settings-epic.md:86`) while still writing a
 * directory tree.
 *
 * `parentPath` is re-validated in main from scratch — expanded, made absolute,
 * `realpath`'d, confirmed to be a directory — exactly like
 * {@link AddProjectRequest}.
 */
export interface CloneRequest {
  url: string;
  parentPath: string;
  /** The terminal's size at the moment the clone starts. */
  cols: number;
  rows: number;
}

/**
 * What `startClone` answers with.
 *
 * Pre-flight only. It resolves as soon as the process is spawned — the clone
 * itself streams through `pty:data` and concludes on {@link CloneDoneEvent}.
 * `targetPath` is returned so the view can name the folder being created
 * without deriving it a second time and risking a different answer.
 */
export type CloneStartResult =
  | { ok: true; targetPath: string }
  | { ok: false; reason: string };

/**
 * How a clone ended (story 102).
 *
 * Carries the fresh snapshot for the same reason every mutating config verb
 * returns one: the renderer must never have to follow a write with a reload,
 * and must never render a list the write already invalidated. On failure the
 * snapshot is the unchanged current one.
 */
export interface CloneDoneEvent {
  ok: boolean;
  /** The directory that now exists, or `null` when the clone failed. */
  targetPath: string | null;
  /** Why it failed, or `null` on success. */
  reason: string | null;
  snapshot: ConfigSnapshot;
}

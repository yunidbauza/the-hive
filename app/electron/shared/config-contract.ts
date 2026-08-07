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
  /**
   * Per-project runtime overrides (story 104). All three are optional, and
   * absent means "use the top-level value" — never "use an empty string".
   *
   * They are stored on the entry rather than in a parallel map so that removing
   * a project takes its overrides with it, and so a hand-edited file keeps a
   * project's settings next to the project they belong to.
   */
  shell?: string;
  claudeCommand?: string;
  /**
   * Extra environment for every session in this project.
   *
   * Merged by the pty-host on top of the inherited environment
   * (`pty-host/env.ts`), which then forces `TERM`, `COLORTERM` and `PWD` — so
   * those three are rejected at the guard rather than accepted and silently
   * overwritten.
   */
  env?: Record<string, string>;
}

/**
 * The runtime values a session actually spawns with (story 104).
 *
 * Resolved per project: an override when the entry declares one, the top-level
 * value otherwise. Returned by `effectiveRuntime` and used both by the spawn
 * path and by the diagnostic, so the thing being explained is the same thing
 * being run.
 */
export interface EffectiveRuntime {
  shell: string;
  claudeCommand: string;
  env: Record<string, string>;
  /** Which of the two scalars came from the project rather than the top level. */
  shellFromProject: boolean;
  commandFromProject: boolean;
}

/** One `PATH` entry the diagnostic looked in, and what it found. */
export interface PathProbe {
  directory: string;
  /** True when an executable file of that name exists there. */
  found: boolean;
  /** Present when a file exists but is not executable — the confusing case. */
  notExecutable?: boolean;
}

/**
 * Why `claude` was or was not found (story 104).
 *
 * The epic's story table asks for "a PATH diagnostic that says why `claude` was
 * not found". The answer is almost always that the app's `PATH` is not the
 * login shell's `PATH` — a GUI app on macOS inherits launchd's environment, not
 * the one `.zshrc` builds — so the diagnostic reports the `PATH` it actually
 * searched rather than asserting the command is missing.
 */
export interface CommandDiagnostic {
  /** The project the diagnostic ran for, or `null` for the top-level command. */
  projectId: string | null;
  /** The command as resolved, before any lookup. */
  command: string;
  /** True when the command contains a separator and is used as a path directly. */
  isPath: boolean;
  /** Where it was found, or `null` when no candidate was executable. */
  resolved: string | null;
  /** The `PATH` that was searched — the merged env's, never `process.env`'s. */
  path: string;
  probes: PathProbe[];
}

/**
 * Which events raise an OS notification (story 106).
 *
 * Only classes backed by an event main can actually observe. There is
 * deliberately no `waiting`: it is not derivable from a pty — a TUI that has
 * asked a question and a TUI that is thinking both produce no output (story
 * 096) — and the real mechanism is the Claude Code hook named as the next
 * epic's work. Shipping the switch before the event would be a control that
 * silently does nothing, and the epic's rule for the section nav applies here
 * too: absent rather than disabled.
 */
export interface NotificationPrefs {
  /** A session's process exited. */
  sessionDone: boolean;
  /** A session produced no output for `ACTIVITY_IDLE_MS`. */
  sessionIdle: boolean;
  /** A clone finished — whether it succeeded or failed. */
  cloneDone: boolean;
}

/**
 * `sessionIdle` is off, and the other two are on.
 *
 * Idle is a real event but a chatty one: a build that pauses to download is not
 * news, and a notification stream the user stops trusting is worse than no
 * notifications at all. Finishing a session and finishing a clone are both
 * discrete, both worth interrupting for, and both things the user walked away
 * from.
 */
export const DEFAULT_NOTIFICATIONS: NotificationPrefs = {
  sessionDone: true,
  sessionIdle: false,
  cloneDone: true,
};

/** The preference keys, in the order the settings section shows them. */
export const NOTIFICATION_KEYS: readonly (keyof NotificationPrefs)[] = [
  'sessionDone',
  'sessionIdle',
  'cloneDone',
];

/**
 * The Jira connection, as the config file declares it (HIVE-67).
 *
 * Site and email only. The API token is a secret and lives in `safeStorage`
 * under `userData` — this file is deliberately hand-editable, which is exactly
 * what makes it the wrong home for a credential.
 */
export interface JiraConfig {
  /**
   * The Atlassian host, e.g. `behiques.atlassian.net`.
   *
   * A bare hostname, never a URL. `integrations/jira/client.ts` builds
   * `https://<site>/…` and nothing else, so a scheme or a path stored here
   * would produce a malformed request rather than a cleverer one. `assertJiraSite`
   * strips a pasted `https://` and refuses everything else.
   */
  site: string | null;
  /** The account the API token belongs to. Half of the Basic credential. */
  email: string | null;
  /**
   * A JQL override for the WORK tab (HIVE-69).
   *
   * `null` means the default query. When set it **replaces** the default
   * wholesale rather than being appended to — a user who writes JQL expects
   * their query to be the query.
   */
  jql: string | null;
}

/** Nothing configured. Both halves are needed before a request can be made. */
export const DEFAULT_JIRA: JiraConfig = {
  site: null,
  email: null,
  jql: null,
};

/** The block's keys, for the parser's exact-key check. */
export const JIRA_KEYS: readonly (keyof JiraConfig)[] = [
  'site',
  'email',
  'jql',
];

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
   * Notification preferences, always fully resolved (story 106).
   *
   * Defaulted here rather than left partial for the same reason `shell` and
   * `claudeCommand` are: main reads this on every event it might announce, and
   * a consumer that had to remember to apply defaults is one that will
   * eventually forget on one branch.
   */
  notifications: NotificationPrefs;
  /**
   * The Jira connection, always fully resolved (HIVE-67).
   *
   * Defaulted here for the same reason `notifications` is: main reads it on
   * every Jira verb, and a consumer that had to remember to apply defaults is
   * one that will eventually forget on one branch.
   */
  jira: JiraConfig;
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
 * Environment variables a project may never set (story 104).
 *
 * Two groups, refused for two different reasons.
 *
 * **The dynamic loader.** `LD_*` and `DYLD_*` tell the OS to load arbitrary
 * shared libraries into *every* process the spawned shell goes on to fork.
 * That is native code execution, and it is a genuine escalation rather than a
 * theoretical one: story 082's posture is that **the renderer is untrusted
 * input**, so a compromised renderer that can write the config file must not
 * thereby be able to run native code. Before this story `injected` was always
 * `{}`, so this path did not exist; refusing these keeps it from opening.
 *
 * The `pty-host` deny-list is not the answer here — it exists to strip
 * *Electron's own* leakage from the inherited environment (`ELECTRON_*`,
 * `NODE_OPTIONS`), a different job, and it runs a process boundary away from
 * the guard that should have refused the value in the first place.
 *
 * **Interpreter hooks.** `NODE_OPTIONS` (`--require` runs a file),
 * `BASH_ENV` (sourced by non-interactive bash) and `ELECTRON_RUN_AS_NODE` are
 * the same trick in a different coat.
 *
 * Refused rather than silently dropped: a setting that vanishes is worse than
 * one that names itself.
 */
export const UNSAFE_ENV_PREFIXES: readonly string[] = ['LD_', 'DYLD_'];

export const UNSAFE_ENV_KEYS: readonly string[] = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ELECTRON_RUN_AS_NODE',
];

/**
 * Variables the pty-host sets for itself, after merging anything injected.
 *
 * Accepting one would store a setting that `buildEnv` then overwrites — a
 * setting that does nothing is worse than a setting that is refused.
 */
export const RESERVED_ENV_KEYS: readonly string[] = ['TERM', 'COLORTERM', 'PWD'];

/**
 * The variables that identify a **Claude session** (HIVE-64).
 *
 * A third group, refused for a third reason. The two lists above are security
 * boundaries; this one is an identity boundary. `claude` reads these to decide
 * which conversation it belongs to, so a session that inherits them joins the
 * launching session instead of starting its own — every new session opening
 * under somebody else's name, and renaming one renaming all of them.
 *
 * `pty-host/env.ts` strips these from the inherited environment, and **imports
 * these constants rather than restating them**. Two lists that must agree is
 * exactly how the message row and the terminal drifted apart in HIVE-65; one
 * definition with two consumers cannot.
 *
 * Refused here as well as stripped there, for the reason the loader list
 * already gives: *a setting that vanishes is worse than one that names
 * itself.* Without this, `CLAUDE_CONFIG_DIR` typed into a project's runtime
 * settings would save, display as set, and then be silently discarded on every
 * spawn — the user watching `claude` ignore a setting the UI says is applied.
 *
 * The cost is real and is the point: a project cannot set any `CLAUDE_*`
 * variable. Anything the user exports from their own shell profile still
 * arrives, because sessions run a login shell.
 */
export const SESSION_ENV_PREFIXES: readonly string[] = ['CLAUDE_'];

/**
 * The session marker with no underscore, which no prefix above can catch.
 *
 * Separate from {@link SESSION_ENV_PREFIXES} because `'CLAUDECODE'` does not
 * start with `'CLAUDE_'`. Dropping it would reopen the leak on its own.
 */
export const SESSION_ENV_KEYS: readonly string[] = ['CLAUDECODE'];

/** Why an environment variable name was refused, or `null` if it is fine. */
export function unsafeEnvReason(key: string): string | null {
  if (RESERVED_ENV_KEYS.includes(key)) {
    return `"${key}" is set by the terminal and cannot be overridden`;
  }
  if (UNSAFE_ENV_KEYS.includes(key)) {
    return `"${key}" can make other programs run code and cannot be set here`;
  }
  if (UNSAFE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return `"${key}" controls the dynamic loader and cannot be set here`;
  }
  if (
    SESSION_ENV_KEYS.includes(key) ||
    SESSION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  ) {
    return `"${key}" identifies a Claude session and is set per session, not per project`;
  }
  return null;
}

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
    notifications: { ...DEFAULT_NOTIFICATIONS },
    jira: { ...DEFAULT_JIRA },
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
 * Payload of `config:rename-project` (story 103).
 *
 * `name` only. The `id` is never rewritten: sessions reference projects by
 * `entity.project`, so an id that drifted when a folder was renamed would
 * strand them. The display name is what the user edits; the id is machinery.
 */
export interface RenameProjectRequest {
  id: string;
  name: string;
}

/**
 * Payload of `config:repoint-project` (story 103).
 *
 * The path is re-validated in main from scratch, exactly like
 * {@link AddProjectRequest} — the native dialog is a UX step, not a capability
 * grant. `origin` is absent on purpose: re-pointing changes where a project
 * *is*, never where it came from, and the mutation spreads the existing entry
 * so a cloned project stays cloned without this having to say so.
 */
export interface RepointProjectRequest {
  id: string;
  path: string;
}

/**
 * Payload of `config:reorder-projects` (story 103).
 *
 * The **whole** ordering, not a delta. Both input paths — a drop and a menu
 * item — produce a full list, the verb is idempotent, and it can be validated
 * exactly: main requires these ids to be a permutation of the ids on disk at
 * write time.
 *
 * That check is the reason for the shape. The config is deliberately not
 * watched (story 107 owns reload), so the renderer's list can be older than the
 * file; a delta applied to a config someone hand-edited in between would
 * silently drop the project that edit added, or resurrect one it removed.
 */
export interface ReorderProjectsRequest {
  ids: readonly string[];
}

/**
 * Change the top-level runtime settings (story 104).
 *
 * Both fields are optional so the UI can save one without restating the other,
 * but a *present* field is always a real value — clearing a top-level setting
 * is not offered, because there is no lower level to fall back to and a session
 * with no shell cannot start.
 */
export interface SetRuntimeRequest {
  shell?: string;
  claudeCommand?: string;
}

/**
 * Change notification preferences (story 106).
 *
 * Partial in the same way {@link SetRuntimeRequest} is: only the classes named
 * are touched, so moving one switch never restates another. There is no `null`
 * case — unlike a per-project override, a preference has no lower level to fall
 * back to, so "off" is a value rather than an absence.
 */
export interface SetNotificationsRequest {
  sessionDone?: boolean;
  sessionIdle?: boolean;
  cloneDone?: boolean;
}

/**
 * Change the Jira site and account email (HIVE-67).
 *
 * `null` clears a field and is distinct from absent, following
 * {@link SetProjectRuntimeRequest}: without it the UI could set a site but
 * never take it back, and an emptied field would have to be stored as `""`.
 *
 * There is deliberately no `token` here. The token is a secret and does not go
 * in the config file — it reaches `safeStorage` through `jira:set-token`, which
 * is a different channel with a different payload for exactly that reason.
 */
export interface SetJiraRequest {
  site?: string | null;
  email?: string | null;
  /** HIVE-69's override. `null` restores the default query. */
  jql?: string | null;
}

/** Payload of `jira:set-token` (HIVE-67). The one payload carrying a secret. */
export interface SetJiraTokenRequest {
  token: string;
}

/**
 * Payload of `jira:search` (HIVE-68).
 *
 * `jql` is optional, and absent means {@link JIRA_DEFAULT_JQL} rather than an
 * empty query. Optional now so HIVE-69 wires a configured override into an
 * existing parameter instead of changing a signature.
 */
export interface JiraSearchRequest {
  jql?: string;
}

/** Payload of `jira:issue` (HIVE-68). */
export interface JiraIssueRequest {
  key: string;
}

/** Payload of `jira:transitions` (HIVE-70). Read per issue, always. */
export interface JiraTransitionsRequest {
  key: string;
}

/**
 * Payload of `jira:apply-transition` (HIVE-70).
 *
 * The id came from a `jira:transitions` read for this same key. It is validated
 * again here anyway: main does not trust that the renderer round-tripped a value
 * it was handed, and the id reaches a request body.
 */
export interface ApplyJiraTransitionRequest {
  key: string;
  transitionId: string;
}

/** Payload of `jira:comments` and `jira:links` (HIVE-71). */
export interface JiraConversationRequest {
  key: string;
}

/**
 * Payload of `jira:add-comment` (HIVE-71).
 *
 * `markdown`, not ADF. The renderer sends what the user typed and main converts
 * it — putting a document builder in the renderer would mean shipping the
 * vendored parser into the browser bundle and trusting a structure the guard
 * cannot meaningfully check.
 */
export interface AddJiraCommentRequest {
  key: string;
  markdown: string;
}

/**
 * Change one project's runtime overrides (story 104).
 *
 * Here `null` is meaningful and distinct from absent: **absent leaves the
 * override alone, `null` removes it.** The UI needs both — saving the shell
 * field must not wipe an env map the user cannot see from that row, and
 * clearing a field has to mean "fall back to the top level" rather than
 * "override with an empty string", which would spawn `""`.
 */
export interface SetProjectRuntimeRequest {
  id: string;
  shell?: string | null;
  claudeCommand?: string | null;
  env?: Record<string, string> | null;
}

/** Which command to explain. Omitted id means the top-level command. */
export interface DiagnoseCommandRequest {
  id?: string;
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
 * destination path (the settings epic, HIVE-51) while still writing a
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

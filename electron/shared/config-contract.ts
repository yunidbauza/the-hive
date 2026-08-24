import {
  NOTIFICATION_KINDS,
  defaultNotificationPrefs,
  type NotificationDelivery,
  type NotificationKind,
  type NotificationPrefs,
} from './notification-contract';

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
  /**
   * A short alias the user can type instead of the id (HIVE-94).
   *
   * Two to four lowercase letters, unique across the file, **derived** from the
   * name when the entry does not declare one and editable afterwards. It exists
   * because the id is a kebab slug of the folder name — up to forty characters
   * — and `spawn incorpx-server …` is the whole name every time.
   *
   * An **alias, never an identity**: sessions reference projects through
   * `entity.project`, so the id stays the thing that is stored and the key
   * stays the thing that is typed. Changing a key strands nothing.
   *
   * Required here but optional in the file: `parse.ts` accepts an entry without
   * one and {@link ProjectConfig} is the *resolved* shape, so by the time a
   * snapshot exists every project has a key — see `resolveProjects`.
   */
  key: string;
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
 * One configured variable, and what the shell actually ended up with (story
 * 108).
 *
 * The design decision this exists to make observable: injected environment
 * is applied before the shell starts, and a login shell's rc file — which
 * runs afterward — can overwrite anything set here. `overridden` is the
 * user-facing signal for exactly that; `actual: null` is the sub-case where
 * the rc file did not merely change the value but dropped the variable
 * entirely, which the view names differently ("dropped" vs "overridden by").
 */
export interface EnvVarVerdict {
  key: string;
  /** What was injected — the value from the merged workspace+project env. */
  configured: string;
  /** What the shell reported for this key, or `null` if it had none at all. */
  actual: string | null;
  /** True when the shell reported a different value than was injected. */
  overridden: boolean;
}

/**
 * Why a configured variable did or did not survive to reach the shell's own
 * environment (story 108).
 *
 * Scoped to one project's runtime, exactly like {@link CommandDiagnostic} —
 * the shell probed is the shell that project's sessions would actually spawn,
 * via the same `effectiveRuntime`. Only the variables the user configured are
 * reported; see {@link EnvVarVerdict} and `compareEnv` for why dumping the
 * shell's whole environment would be the wrong answer.
 */
export interface EnvDiagnostic {
  /** The project the diagnostic ran for, or `null` for the top-level env. */
  projectId: string | null;
  /** The shell that was probed — `effectiveRuntime(...).shell`. */
  shell: string;
  /**
   * Present when the probe itself could not run — the shell could not be
   * started, or did not exit cleanly. `vars` is always empty when this is
   * set: a failed observation is not a partial one.
   */
  error: string | null;
  vars: EnvVarVerdict[];
}

/**
 * The exact argv the environment diagnostic runs the shell with (story 108).
 *
 * A shared constant rather than a string literal duplicated in
 * `env-diagnostic.ts` (which runs it) and `env-diagnostic-view.tsx` (which
 * displays it) — a second, hand-typed copy is exactly the kind of drift that
 * turned a missing `-i` into a defect in the first place.
 *
 * **`-i`, not just `-l -c`.** zsh sources `.zshrc` only for *interactive*
 * shells, and a real session's `<shell> -l` on a PTY is interactive — so a
 * merely-login, non-interactive probe misses the exact file this diagnostic
 * exists to expose, reporting a variable as "kept" while a real session would
 * have gotten the rc file's value. Measured directly: `zsh -l -c printenv`
 * does not see a variable set in `.zshrc`; `zsh -l -i -c printenv` does.
 *
 * **A residual gap remains, and is surfaced rather than hidden.** The probe
 * has no TTY, so an rc file gated on `[[ -t 0 ]]` can still diverge from a
 * real session. `EnvDiagnosticView` renders this exact argv next to the
 * result precisely so the user can see what was, and was not, exercised.
 */
export const ENV_PROBE_ARGS: readonly string[] = ['-l', '-i', '-c', 'printenv'];

/**
 * The marker that brackets the login-env probe's own output (HIVE-84).
 *
 * A login shell is *expected* to print things this app did not ask for — a
 * version-manager banner, an oh-my-zsh update notice, a motd. Reading a
 * transcript that has been prefixed by a banner would treat the banner's tail
 * as a variable, and a banner containing an `=` would silently produce a
 * plausible-looking bogus entry. Taking only what falls between the first and
 * last marker removes that whole class of failure rather than trying to filter
 * it record by record.
 *
 * Deliberately not a value anybody would set: it exists to be absent from a
 * real environment.
 */
export const LOGIN_ENV_DELIMITER = '__hive_login_env_boundary__';

/**
 * What separates one variable from the next in the login-env transcript
 * (HIVE-86).
 *
 * **NUL, because it is the one byte an environment variable cannot contain.**
 * `execve` stores the environment as NUL-terminated strings, so a value holding
 * a NUL is not representable — which makes it the only separator a value can
 * never counterfeit. A newline is *not* such a byte, and assuming it was is the
 * defect this replaced.
 *
 * @see LOGIN_ENV_PROBE_ARGS for the transcript this delimits.
 */
export const LOGIN_ENV_RECORD_SEPARATOR = '\0';

/**
 * The only variables the login shell is allowed to hand back (HIVE-84).
 *
 * An allowlist rather than a merge, because "import my environment" and
 * "import the three things this app actually reads" differ by an unbounded set
 * of variables that would change app behaviour with no diagnostic — an rc file
 * exporting `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE` or a proxy setting would be
 * doing so to a process the user is not thinking about.
 *
 * `PATH` is the one that matters and the reason this exists: a GUI-launched
 * app inherits launchd's four-entry `PATH`, so a Homebrew `gh` is genuinely
 * invisible. The two token variables are here because Settings reports on them
 * by name — and reports them as *absent* today for the same rc-file reason.
 *
 * **Presence, never value, leaves this process.** The values are written into
 * `process.env` so `gh` can use them; what the renderer is told is which names
 * were imported. See `integrations/gh.ts` for the same rule stated for reads.
 *
 * Since HIVE-86 this list is also enforced **at the shell**, not merely
 * filtered after the fact — see {@link LOGIN_ENV_PROBE_ARGS}.
 */
export const LOGIN_ENV_IMPORT_KEYS: readonly string[] = [
  'PATH',
  'GH_TOKEN',
  'GITHUB_TOKEN',
];

/**
 * The shell commands that print one `KEY=VALUE` record, NUL-terminated.
 *
 * **Deliberately free of variable-expansion syntax.** An earlier draft used
 * `"KEY=${KEY-}"`, which is POSIX and reads better — and which fish rejects at
 * parse time (`${` is not a variable there; fish spells it `{$VAR}`), aborting
 * the whole `-c` string before a single byte is printed. `defaultShell()` reads
 * `getpwuid`, so a fish user's login shell is genuinely what gets probed, and
 * that draft would have handed them no markers, no import, and the HIVE-84
 * defect back — a regression, since the `printenv` protocol it replaced used
 * only `printf`, `printenv` and `;`, all of which fish supports.
 *
 * So the value is fetched by `printenv KEY`, an external command, and the `=`
 * is printed separately. Nothing here is interpreted as syntax by any shell
 * this app can be pointed at.
 *
 * Two consequences the parser must know about, both handled in `parseLoginEnv`:
 *
 * - `printenv` terminates its output with a newline of its own, so every record
 *   carries exactly one trailing `\n` that is not part of the value.
 * - An **unset** variable makes `printenv` print nothing and exit non-zero. The
 *   record is then bare `KEY=` with no trailing newline, which reads as unset —
 *   the answer we want. (An rc file running `set -e` would abort the probe at
 *   that point; the result is a reported failure, never a wrong value.)
 *
 * The name is checked rather than trusted. Every caller today passes a
 * compile-time constant, so this can only fire during development — which is
 * exactly when a key like `FOO'; rm -rf ~; :'` should stop the build instead of
 * becoming a shell command. It is the guard that lets the interpolation below
 * be read as safe without having to re-derive that fact from the call site.
 */
function loginEnvRecordExpr(key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(
      `LOGIN_ENV_IMPORT_KEYS: ${JSON.stringify(key)} is not a shell-safe variable name`,
    );
  }
  return `printf '%s=' '${key}'; printenv '${key}'; printf '\\0';`;
}

/**
 * The exact argv the login-environment import runs the shell with (HIVE-84,
 * reshaped by HIVE-86).
 *
 * The same `-l -i -c` as {@link ENV_PROBE_ARGS}, and for the same measured
 * reason: zsh sources `.zshrc` only for *interactive* shells, and `.zshrc` is
 * overwhelmingly where a developer's `PATH` is actually assembled — Homebrew's
 * shellenv, nvm, mise, pyenv. A merely-login, non-interactive probe would come
 * back with a `PATH` missing exactly the entries this import exists to
 * recover.
 *
 * ## Why not `printenv` (HIVE-86)
 *
 * The original protocol printed the whole environment, one `KEY=VALUE` per
 * line, and split the transcript on newlines. That is only lossless while no
 * value contains a newline — and values do. The case that broke it is
 * completely ordinary: `~/.zshrc` running
 * `export PATH="$PATH:$(npm bin -g)"`, where `npm bin` was removed in npm 9+
 * and substitutes a multi-line error message *into `PATH` itself*. `printenv`
 * emitted it faithfully; the parser then truncated `PATH` at the first newline
 * and dropped every entry after it. A continuation line that happened to read
 * `GH_TOKEN=…` would have been adopted as a real variable.
 *
 * So the transcript is now **NUL-delimited** — see
 * {@link LOGIN_ENV_RECORD_SEPARATOR} for why that byte in particular — and the
 * shell is asked for {@link LOGIN_ENV_IMPORT_KEYS} **by name** rather than for
 * everything. Naming them moves the allowlist to the only place it is fully
 * effective: a value this app never asked for is now never printed, never
 * buffered, and never in reach of a parsing mistake. The JS-side filter in
 * `importLoginEnv` stays as the second line of defence.
 *
 * The leading `\0` before the opening marker keeps rc-file banner output — a
 * version-manager notice, a motd — in a record of its own instead of glued to
 * the marker, so the marker is still matched by equality.
 *
 * The command is a single `-c` string, which is the one place in this codebase
 * a shell is handed a string to interpret — unavoidable, since asking a shell
 * what its environment is means asking the shell. It is safe because every
 * part of the string is a **compile-time constant**: the marker, and the
 * allowlist's own key names, each checked by {@link loginEnvRecordExpr}.
 * Nothing from the renderer, the config file, or the environment reaches it.
 * The shell *path* is still an argv entry, never part of this string.
 */
export const LOGIN_ENV_PROBE_ARGS: readonly string[] = [
  '-l',
  '-i',
  '-c',
  [
    `printf '\\0%s\\0' '${LOGIN_ENV_DELIMITER}';`,
    ...LOGIN_ENV_IMPORT_KEYS.map(loginEnvRecordExpr),
    `printf '%s\\0' '${LOGIN_ENV_DELIMITER}'`,
  ].join(' '),
];

/**
 * Whether the app imports its `PATH` from the login shell. Default **on**.
 *
 * On, because the failure it fixes is the default experience of an installed
 * build, and the workaround — hand-editing a `PATH` into the config file —
 * requires the user to first understand launchd. Off exists for the rc file
 * this app should not fight: one that is slow, prompts, or has side effects
 * worth not triggering once per launch.
 */
export const DEFAULT_IMPORT_LOGIN_ENV = true;

/** Which project's environment to diagnose. Omitted id means the top-level env. */
export interface DiagnoseEnvRequest {
  id?: string;
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
export type { NotificationPrefs } from './notification-contract';

/**
 * `sessionIdle` is off, and the other two are on.
 *
 * Idle is a real event but a chatty one: a build that pauses to download is not
 * news, and a notification stream the user stops trusting is worse than no
 * notifications at all. Finishing a session and finishing a clone are both
 * discrete, both worth interrupting for, and both things the user walked away
 * from.
 */
export const DEFAULT_NOTIFICATIONS = defaultNotificationPrefs();

/** The preference keys, in the order the settings section shows them. */
export const NOTIFICATION_KEYS: readonly NotificationKind[] = NOTIFICATION_KINDS;

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
  /** The login shell for every session, already defaulted by `defaultShell()`. */
  shell: string;
  /** The bootstrap command a session runs (story 096), already defaulted. */
  claudeCommand: string;
  /**
   * Environment applied to every session, under any project's own (story 108).
   *
   * Always fully resolved — `{}` rather than absent — for the reason
   * `notifications` is: main reads this on every spawn, and a consumer that
   * must remember to apply a default is one that will forget on one branch.
   */
  env: Record<string, string>;
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
   * Whether sessions authenticate on the Claude.ai plan (HIVE-79).
   *
   * `true` — the default — strips {@link AUTH_ENV_KEYS} from every session the
   * app spawns, so `claude` uses the subscription credentials and its status
   * line reports the rate limits the header renders. `false` inherits whatever
   * the user exported, which is the pre-HIVE-79 behaviour and means the two
   * limit gauges stay empty.
   */
  subscriptionAuth: boolean;
  /**
   * Whether the app injects its status line, and so whether the header's gauges
   * have anything to show (HIVE-79).
   *
   * See {@link DEFAULT_SESSION_METRICS} for what turning it off costs and buys.
   */
  sessionMetrics: boolean;
  /**
   * Whether the app imports {@link LOGIN_ENV_IMPORT_KEYS} from the login shell
   * at startup (HIVE-84).
   *
   * `true` — the default — is what makes a Finder-launched build see the same
   * `PATH` a terminal does, and so the only reason `gh` is findable in a
   * packaged app at all. `false` keeps launchd's inherited environment, which
   * is the pre-HIVE-84 behaviour.
   */
  importLoginEnv: boolean;
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

/**
 * What a project key is allowed to look like (HIVE-94).
 *
 * Two to four lowercase letters — no digits, no separators. The bound is what
 * makes the key worth having: a key that could be eight characters long would
 * drift back towards the id it exists to shorten, and one that could carry a
 * digit would let the collision fallback mint `is2`, which is a slug rather
 * than an alias.
 *
 * It lives in the contract rather than in `guards.ts` because **three** layers
 * need it and they must not disagree: the IPC guard refuses a bad one, the
 * config reader reports one, and the inline editor in Settings has to grey out
 * *Enter to save* while the user is still typing. `guards.ts` is the boundary
 * and pulls in the whole request surface behind it, so the renderer imports
 * this file — as it already does for `unsafeEnvReason`.
 */
export const PROJECT_KEY_PATTERN = /^[a-z]{2,4}$/;

/** The one sentence every layer uses to say what a key must be. */
export const PROJECT_KEY_HINT = '2–4 lowercase letters';

/**
 * Whether a string is a usable project key.
 *
 * A function rather than a bare `.test()` at each call site so the pattern is
 * never copied, and never accidentally given the `g` flag's stateful `lastIndex`
 * by a future edit.
 */
export const isProjectKey = (value: string): boolean =>
  PROJECT_KEY_PATTERN.test(value);

/**
 * Every string a project already answers to, lowercased (HIVE-94).
 *
 * A key is not unique merely by being unlike the other keys. `resolveProjectRef`
 * searches **one address space** — key, then id, then name — and it searches key
 * *first*, so a key that happens to equal another project's id silently takes
 * that id's spawns. That is not hypothetical: a project at `~/repos/web` (id
 * `web`) renamed to "Frontend" derives the key `fro` and leaves `web` free, and
 * the next project called "Web Extension Builder" mints exactly `web` — after
 * which `spawn web`, which had always meant the first, starts an agent in the
 * second with no warning anywhere.
 *
 * So this is the set every *generated* key must avoid and every *typed* key is
 * refused against. Ids and names are folded to lowercase because the resolver
 * matches case-insensitively; a value that could never be a key (a forty
 * character id) is harmless in the set and cheaper to include than to filter.
 *
 * A project's own handles are not excluded here — callers drop the entry being
 * keyed, because a project answering to its own id under two fields is not a
 * collision with anything.
 */
export function projectAliases(project: {
  id: string;
  name?: string | null;
  key?: string | null;
}): string[] {
  const aliases = [project.id.toLowerCase()];
  if (project.name) aliases.push(project.name.toLowerCase());
  if (project.key) aliases.push(project.key.toLowerCase());
  return aliases;
}

/** The last-resort shell: used off darwin when the password database has no usable entry. */
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

/**
 * The credentials that make `claude` bill an API account instead of a plan.
 *
 * Removed from every session the Hive spawns unless
 * {@link ConfigSnapshot.subscriptionAuth} is turned off (HIVE-79).
 *
 * ## Why an app would touch a user's credentials at all
 *
 * Because leaving them alone silently costs the user the feature this epic
 * exists for. `claude` prefers `ANTHROPIC_API_KEY` when it is exported, and a
 * session authenticated that way reports **no `rate_limits` at all** in its
 * status line — the field is documented as subscriber-only. So on any machine
 * where the key is exported (which is most machines belonging to people who
 * also build against the API), the header's session and weekly gauges would
 * read `—` forever, for a reason nothing on screen could explain.
 *
 * ## Why this is not the app quietly deciding how the user pays
 *
 * It is a **billing** change and it is treated as one: it is a documented
 * config key, not a hidden behaviour, and setting `"subscriptionAuth": false`
 * restores the inherited credentials exactly. What it changes is only which of
 * the user's *own* two credentials a session picks up, and the default matches
 * what a session manager for a Claude.ai plan is for.
 *
 * Unlike {@link SESSION_ENV_KEYS} these are **not** in the pty host's
 * unconditional deny list, because the removal is a choice rather than a
 * correctness fix — the host is told which names to drop on each spawn.
 */
export const AUTH_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];

/**
 * Sessions authenticate on the user's Claude.ai plan by default.
 *
 * See {@link AUTH_ENV_KEYS} for why the default is this way round.
 */
export const DEFAULT_SUBSCRIPTION_AUTH = true;

/**
 * Whether the app injects its own status line into the sessions it spawns.
 *
 * On by default, because it is the only source of the context and rate-limit
 * numbers the header renders — see `metrics-contract.ts`. Off restores the
 * user's own status line inside Hive sessions and leaves all three header
 * gauges empty.
 *
 * It is switchable at all because injecting a status line is **not free inside
 * the terminal**: Claude Code drops most of its footer keyboard hints (`esc to
 * interrupt`, `? for shortcuts`, the voice-dictation hint) whenever one is
 * configured, whether or not it renders anything. A user who would rather keep
 * those hints than see the gauges is making a reasonable trade, and before this
 * key existed they had no way to make it.
 */
export const DEFAULT_SESSION_METRICS = true;

/**
 * The one definition of "what a spawned session's environment looks like"
 * (story 092, extended by story 108's fix round).
 *
 * Originally lived only in `electron/pty-host/env.ts`, which is fine for the
 * pty-host itself but was wrong for the env diagnostic
 * (`electron/main/config/env-diagnostic.ts`): main may not import
 * `electron/pty-host/**` (the process-boundary zone in `eslint.config.mjs`
 * only grants it `electron/shared/**`), so the diagnostic had been building
 * its own, slightly different environment by hand — `{ ...baseEnv,
 * ...runtime.env }`, with none of what follows applied.
 *
 * That divergence was not cosmetic. A packaged app launched from Finder has
 * no `TERM` in main's own environment (the same launch mode `shell.ts`
 * already distrusts `$SHELL` for), while every real session gets
 * `TERM=xterm-256color` forced on it below. An rc file that branches on
 * `TERM` — `[[ $TERM == dumb ]] && return`, which oh-my-zsh and
 * powerlevel10k both do — would take a different branch under the probe than
 * under a real session, and the diagnostic would report a variable as "kept"
 * that a real session would actually see overridden. Living here and being
 * called by both `buildEnv` (pty-host) and `diagnoseEnv` (main) is what
 * makes that impossible: there is exactly one place this logic can drift.
 */
export const TERM = 'xterm-256color';

/** See {@link TERM} — advertises 24-bit colour so tools do not quantise to 256. */
export const COLORTERM = 'truecolor';

/**
 * Variables stripped by exact name before a session's environment is built.
 *
 * `ELECTRON_RUN_AS_NODE` is Electron's own leakage — a child that itself
 * launches Electron would silently become a Node process instead.
 * `NODE_OPTIONS` and `NODE_PATH` point a `node` the user runs at Electron's
 * own bundled runtime and `node_modules` rather than their project's.
 *
 * {@link SESSION_ENV_KEYS} is spread in rather than spelled out: the config
 * layer refuses those names and this layer strips them, and two hand-maintained
 * copies of the same list is how the message row and the terminal drifted apart
 * in HIVE-65.
 */
export const SESSION_ENV_DENY_EXACT: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_PATH',
  ...SESSION_ENV_KEYS,
];

/**
 * Variables stripped by prefix before a session's environment is built.
 *
 * `ELECTRON_*` is internal wiring never meaningful to a user shell;
 * `GDK_PIXBUF_*` and `CHROME_*` are Chromium sandbox/runtime leakage.
 *
 * ## Why `CLAUDE_*` is on this list, and why it matters most here
 *
 * Launch The Hive from a terminal that is *itself* inside a Claude Code session
 * — `pnpm desktop:dev` typed into one, which is exactly how it gets developed —
 * and Electron inherits that session's variables: `CLAUDE_CODE_SESSION_ID`,
 * `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDECODE=1`, and the rest. Every pty then
 * hands them to `claude`, and every agent The Hive spawns **joins the launching
 * session instead of starting its own**.
 *
 * The symptoms are bizarre until the cause is known, and were all observed:
 *
 * - Every new session opened already carrying the launching session's display
 *   name, ignoring the `--name` the app passed it.
 * - Renaming any one session renamed *all* of them, and the developer's own
 *   outer session along with them, because there was only ever one session.
 * - `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`
 *   in sessions nobody had configured that way.
 *
 * Stripping here is the right layer and is not lossy: {@link buildSessionEnv}
 * seeds from the *ambient* environment, and sessions run a **login shell**, so
 * any `CLAUDE_*` the user genuinely exports from their own profile is
 * re-established by that shell. What is removed is only the leakage from
 * however the app happened to be started. `unsafeEnvReason` refuses these names
 * at the point they are typed so the removal is never *silent* — a setting that
 * vanishes is worse than one that names itself.
 */
export const SESSION_ENV_DENY_PREFIXES: readonly string[] = [
  'ELECTRON_',
  'GDK_PIXBUF_',
  'CHROME_',
  ...SESSION_ENV_PREFIXES,
];

function isSessionEnvDenied(key: string): boolean {
  return (
    SESSION_ENV_DENY_EXACT.includes(key) ||
    SESSION_ENV_DENY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * Build the environment a spawned session ends up with — and, since story
 * 108's fix round, the environment the env diagnostic probes, so the two can
 * never quietly diverge again.
 *
 * Start from a copy of the base environment, delete the deny-list, apply
 * whatever was injected explicitly, then force `TERM`, `COLORTERM` and `PWD`.
 * Those three are last on purpose: they are the terminal's identity, and an
 * injected override of `TERM` is far more likely to be a mistake than an
 * intention.
 *
 * `stripEnv` is the caller's own names, on top of the deny list, and the
 * distinction is worth keeping: everything on {@link SESSION_ENV_DENY_EXACT} is
 * removed because inheriting it *breaks* a child process, which is a fact about
 * the environment. `stripEnv` is whatever the caller was told to drop by the
 * user's config, which is a preference — see {@link AUTH_ENV_KEYS}. It applies
 * to `injected` as well as to the ambient copy, exactly as the deny list does:
 * a project that could re-add a name the user asked to have removed would make
 * the setting silently conditional on which project was open.
 */
export function buildSessionEnv(
  base: NodeJS.ProcessEnv,
  cwd: string,
  injected: Record<string, string> = {},
  stripEnv: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  const stripped = new Set(stripEnv);
  const isRemoved = (key: string): boolean =>
    isSessionEnvDenied(key) || stripped.has(key);

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || isRemoved(key)) continue;
    env[key] = value;
  }

  for (const [key, value] of Object.entries(injected)) {
    if (isRemoved(key)) continue;
    env[key] = value;
  }

  env.TERM = TERM;
  env.COLORTERM = COLORTERM;
  env.PWD = cwd;

  return env;
}

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
    subscriptionAuth: DEFAULT_SUBSCRIPTION_AUTH,
    sessionMetrics: DEFAULT_SESSION_METRICS,
    importLoginEnv: DEFAULT_IMPORT_LOGIN_ENV,
    env: {},
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
 * Payload of `config:set-project-key` (HIVE-94).
 *
 * A mirror of {@link RenameProjectRequest}, and for the same reason: `id` names
 * the entry and is never rewritten. The difference is only in what is being
 * edited — the name is what the project is *called*, the key is what it is
 * *typed as* — and in uniqueness, which a name does not have to satisfy and a
 * key does. Main checks that against the file it is about to write, not against
 * the renderer's snapshot, because the config is deliberately not watched.
 */
export interface SetProjectKeyRequest {
  id: string;
  key: string;
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
 * Change the top-level runtime settings (story 104, extended by 108).
 *
 * All fields are optional so the UI can save one without restating the
 * others. `shell` and `claudeCommand` may not be cleared — there is no lower
 * level to fall back to, and a session with no shell cannot start — but `env`
 * is different: it is the whole map rather than a scalar, so `{}` is a real,
 * offered value and is how the last workspace variable is removed. See
 * {@link SetRuntimeRequest.env}.
 */
export interface SetRuntimeRequest {
  shell?: string;
  claudeCommand?: string;
  /**
   * The whole map, replacing what is stored — not a patch.
   *
   * `{}` is meaningful and is how the last variable is removed. Unlike `shell`,
   * there is no `null` case: absent already means "leave it alone".
   */
  env?: Record<string, string>;
  /**
   * Whether to import the login shell's environment at startup (HIVE-84).
   *
   * A plain boolean, not nullable: unlike a per-project override there is no
   * lower level to fall back to, so "off" is a value rather than an absence —
   * the same reasoning {@link SetNotificationsRequest} states for a preference.
   *
   * **Takes effect on the next launch**, because the import runs once at boot.
   * The Settings control says so rather than implying a live change.
   */
  importLoginEnv?: boolean;
}

/**
 * Change notification preferences (story 106).
 *
 * Partial in the same way {@link SetRuntimeRequest} is: only the classes named
 * are touched, so moving one switch never restates another. There is no `null`
 * case — unlike a per-project override, a preference has no lower level to fall
 * back to, so "off" is a value rather than an absence.
 */
export type SetNotificationsRequest = Partial<
  Record<NotificationKind, NotificationDelivery>
>;

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

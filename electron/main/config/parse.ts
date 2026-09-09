import {
  BIND_KEYS,
  JIRA_KEYS,
  NOTIFICATION_KEYS,
  RECEIVER_KEYS,
  REMOTE_KEYS,
  SERVER_BIND_KEYS,
  SERVER_DEVICE_KEYS,
  SERVER_KEYS,
  SLACK_KEYS,
  SUPPORTED_CONFIG_VERSIONS,
  isAbsoluteContainerPath,
  isContainerFreshness,
  isContainerProbe,
  isEnvArgTemplate,
  isHostAlias,
  isOrigin,
  isRemoteTarget,
  isServerBindHost,
  unsafeEnvReason,
  type ContainerConfig,
  type JiraConfig,
  type NotificationPrefs,
  type ProjectOrigin,
  type ReceiverBindConfig,
  type ReceiverConfig,
  type RemoteConfig,
  type RemoteMode,
  type ServerBindConfig,
  type ServerConfig,
  type ServerDevice,
  type SlackConfig,
} from '@shared/config-contract';
import { PROJECT_KEY_HINT, isProjectKey } from '@shared/config-contract';
import { assertId } from '@shared/guards';
import {
  LEGACY_NOTIFICATION_KEYS,
  NOTIFICATION_DELIVERIES,
  RETIRED_SESSION_KEYS,
  isNotificationDelivery,
} from '@shared/notification-contract';

/**
 * Parsing and shape-validation for `~/.hive/config.json` (story 090).
 *
 * Pure — no filesystem, no path resolution. That split is what lets every
 * shape rule below be tested against a string rather than against a directory
 * tree, and it keeps the one module that touches `fs` small enough to read.
 *
 * The config file is **user-authored input arriving from disk**, and it gets
 * exactly the treatment story 082 gives input arriving from the renderer:
 * hand-written guards, no casts, an explicit key allowlist, and `__proto__`
 * rejected outright. The difference is only in what failure means — a renderer
 * payload that fails validation is refused, whereas a config file that fails
 * validation must still let the app launch.
 */

/** One entry as the file declared it, before any path resolution. */
export interface RawProject {
  id: string;
  path: string;
  /**
   * The typing alias (HIVE-94). Absent when the file omits it.
   *
   * Optional on read even though `ProjectConfig.key` is required: a config
   * written before this build — or by hand — has no keys, and refusing to load
   * it would make a new field a breaking change. `resolveProjects` generates
   * one for every entry that arrives without it, and `loadConfig` writes them
   * back once so the next read is stable.
   */
  key?: string;
  /** Absent when the file omitted it; `resolveProject` supplies the default. */
  name?: string;
  icon?: string;
  origin?: ProjectOrigin;
  /** Story 104's per-project runtime overrides. Absent means "inherit". */
  shell?: string;
  claudeCommand?: string;
  env?: Record<string, string>;
  /** HIVE-133's per-project container block. Absent means "inherit". */
  container?: ContainerConfig;
}

export interface ParsedConfig {
  /** `null` when the file did not name one; the caller applies the default. */
  shell: string | null;
  claudeCommand: string | null;
  /** Whether the app injects its own status line (HIVE-79). `null` = unstated. */
  sessionMetrics: boolean | null;
  /**
   * Whether sessions authenticate on the Claude.ai plan (HIVE-79).
   *
   * `null` for "the file did not say", which `loadConfig` resolves to
   * {@link DEFAULT_SUBSCRIPTION_AUTH}. Distinct from an explicit `false`, which
   * is a user choosing to keep their exported API credentials.
   */
  subscriptionAuth: boolean | null;
  /**
   * Whether the app imports its `PATH` from the login shell (HIVE-84).
   *
   * `null` for "the file did not say", resolved to
   * {@link DEFAULT_IMPORT_LOGIN_ENV}. An explicit `false` is a user who has
   * decided this app should not run their rc file once per launch.
   */
  importLoginEnv: boolean | null;
  /**
   * The workspace environment block, exactly as the file declared it.
   *
   * `undefined` when absent — kept undefined rather than defaulted to `{}` for
   * the same reason `notifications` is kept partial: the write path must be
   * able to tell "the user chose this" from "the file said nothing", which is
   * what stops an untouched file from growing a block it never had.
   */
  env?: Record<string, string>;
  projects: RawProject[];
  /**
   * Story 106's notification block, exactly as the file declared it.
   *
   * `undefined` when the file has no block at all — which every config written
   * before this story does. Partial when it names only some classes; the caller
   * merges `DEFAULT_NOTIFICATIONS` over it. Kept partial here rather than
   * defaulted so the write path can tell "the user chose this" from "the file
   * said nothing", which is what keeps an untouched file from growing a block
   * it never asked for.
   */
  notifications?: Partial<NotificationPrefs>;
  /**
   * HIVE-67's Jira block, exactly as the file declared it.
   *
   * `undefined` when the file has none — which every config written before this
   * story does. Partial when it names only one field; the caller merges
   * `DEFAULT_JIRA` under it. Kept partial here rather than defaulted so the
   * write path can tell "the user chose this" from "the file said nothing",
   * which is what keeps an untouched file from growing a block it never asked
   * for.
   */
  jira?: Partial<JiraConfig>;
  /**
   * HIVE-131's receiver block, exactly as the file declared it.
   *
   * `undefined` when the file has none — which every config written before this
   * story does. Kept partial here rather than defaulted for the same reason
   * `jira` is: the write path must be able to tell "the user chose this" from
   * "the file said nothing", which is what keeps an untouched file from growing
   * a block it never asked for.
   *
   * `bind` is partial one level down too (HIVE-134): a file that names the
   * block but only one of its three fields must not have the other two
   * silently promoted to "the user chose the default", which is exactly what a
   * fully-resolved `ReceiverBindConfig` here would do the next time the file is
   * written back.
   */
  receiver?: Partial<Omit<ReceiverConfig, 'bind'>> & { bind?: Partial<ReceiverBindConfig> };
  /**
   * HIVE-142's server block, exactly as the file declared it.
   *
   * `undefined` when the file has none — which every config written before
   * this story does. Kept partial here rather than defaulted for the same
   * reason `receiver` is: the write path must be able to tell "the user chose
   * this" from "the file said nothing", which is what keeps an untouched file
   * from growing a block it never asked for.
   *
   * `bind` is partial one level down too, for the same reason `receiver.bind`
   * is: a file that names the block but only one of its three fields must not
   * have the other two silently promoted to "the user chose the default".
   *
   * `devices` is kept as the fully-validated array {@link optionalDevices}
   * produces rather than partial per entry — a device with a missing field is
   * not "half a device the caller merges a default under", it is a paired
   * device this file cannot describe, so the whole entry is dropped rather
   * than salvaged.
   */
  server?: Partial<Omit<ServerConfig, 'bind'>> & { bind?: Partial<ServerBindConfig> };
  /**
   * HIVE-144's remote block, exactly as the file declared it.
   *
   * `undefined` when the file has none — which every config written before
   * this story does. Kept partial here rather than defaulted for the same
   * reason `server` is: the write path must be able to tell "the user chose
   * this" from "the file said nothing", which is what keeps an untouched file
   * from growing a block it never asked for.
   *
   * `host` is validated by {@link isRemoteTarget} only when this block's own
   * `mode` names `'remote'` — an absent or `'local'` mode leaves `host`
   * unvalidated, which is what keeps a never-attached install's empty default
   * from reporting an error it never earned. See `RemoteConfig.host`'s doc
   * comment.
   */
  remote?: Partial<RemoteConfig>;
  /**
   * HIVE-124's slack block, exactly as the file declared it.
   *
   * `undefined` when the file has none — which every config written before
   * this story does. Partial when it names only one field; the caller merges
   * `DEFAULT_SLACK` under it. Kept partial here rather than defaulted for the
   * same reason `jira` and `receiver` are: the write path must be able to tell
   * "the user chose this" from "the file said nothing", which is what keeps an
   * untouched file from growing a block it never asked for.
   */
  slack?: Partial<SlackConfig>;
  errors: string[];
  /** The version the file declared, or `null` when it was unreadable. */
  version: number | null;
  /**
   * True when the reader rejected the file **wholesale** (story 101).
   *
   * Only the paths that abandon the document set this: unparseable JSON, a
   * non-object top level, a forbidden key, an unsupported version.
   *
   * An unknown top-level key or a bad entry is *advisory* — it is reported and
   * the rest of the file still applies. The write path depends on the
   * difference: `errors.length > 0` cannot be its refusal test, because a file
   * carrying one unknown key is exactly the file story 101 promises to
   * preserve across a write, and treating that as a refusal would make it
   * permanently unwritable.
   */
  fatal: boolean;
}

/**
 * Keys that must never be read off a parsed document.
 *
 * `JSON.parse('{"__proto__": {...}}')` produces an *own* property named
 * `__proto__` — unlike an object literal, where the same text sets the
 * prototype. Nothing here spreads the parsed object into another, which is the
 * usual path to pollution, but rejecting the key outright is cheaper than
 * reasoning about every future caller.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const TOP_LEVEL_KEYS = [
  'version',
  'shell',
  'claudeCommand',
  // Story 108's workspace environment. Listed for the same reason the
  // per-project overrides below are: a hand-written block must be read, not
  // reported as a mistake.
  'env',
  'projects',
  // Story 106. Listed so a hand-written block is read rather than reported as
  // an unknown key — the same courtesy story 104 extended to the per-project
  // runtime overrides below.
  'notifications',
  // HIVE-67, for the same reason. The block holds the site and the account
  // email; the API token is a secret and is deliberately not in this file.
  'jira',
  // HIVE-131, for the same reason. The container host alias — a name, never an
  // address with a port; the port belongs to the receiver.
  'receiver',
  // HIVE-142, for the same reason. The paired-device roster included: a
  // device's credential is a SHA-256 digest, not the token it was derived
  // from, and a digest is not a secret — see `ServerDevice.credential` — which
  // is why this block may hold it in a file the product invites the user to
  // hand-edit.
  'server',
  // HIVE-144, for the same reason. The attach mode and where to reach a
  // server elsewhere on the tailnet; the device credential is a secret and is
  // deliberately not in this file — see `RemoteConfig`'s doc comment.
  'remote',
  // HIVE-124, for the same reason. The socket-mode switch and the commander
  // allow-list; the two Slack tokens are secrets and are deliberately not in
  // this file.
  'slack',
  // HIVE-79. A boolean rather than a block, and the only key in this file that
  // changes how a session *authenticates* — see `AUTH_ENV_KEYS`.
  'subscriptionAuth',
  // HIVE-79. Whether the app injects its own status line into sessions.
  'sessionMetrics',
  // HIVE-84. Whether the app asks the login shell for its `PATH` at startup.
  'importLoginEnv',
];
/**
 * `shell`, `claudeCommand` and `env` are story 104's per-project overrides.
 * `container` is HIVE-133's per-project container block.
 *
 * They are listed here so a hand-written override is *read* rather than
 * reported as an unknown key. Unlisted keys are still preserved across a write
 * — the mutations spread the raw entry — but they are ignored on load, which is
 * not what a user who typed `"shell"` into their config expects to happen.
 */
const PROJECT_KEYS = [
  'id',
  'path',
  'key',
  'name',
  'icon',
  'origin',
  'shell',
  'claudeCommand',
  'env',
  'container',
];

/** POSIX-portable environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The same limits the IPC guard applies (`guards.ts`).
 *
 * Hand-editing the config file is an explicitly supported workflow, so this
 * reader is a real entry point and not a formality — a rule enforced on only
 * one of the two paths is a rule with a documented bypass.
 */
const MAX_ENV_ENTRIES = 200;
const MAX_ENV_VALUE = 4096;

/** C0 (including CR, LF and ESC), DEL, and the C1 block. */
function hasControlCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Read an entry's `env` map, rejecting the whole map on any bad member.
 *
 * All-or-nothing rather than per-key salvage: an env map is a set of
 * assumptions a command is run under, and running with half of them is a
 * stranger outcome than running with none and a message saying so.
 */
function optionalEnv(
  record: Record<string, unknown>,
  label: string,
  errors: string[],
): Record<string, string> | undefined {
  const value = record.env;
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push(`${label}.env: expected an object — ignored`);
    return undefined;
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_ENV_ENTRIES) {
    errors.push(`${label}.env: too many variables (max ${MAX_ENV_ENTRIES}) — env ignored`);
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${label}.env: forbidden key "${key}" — env ignored`);
      return undefined;
    }
    if (!ENV_NAME.test(key)) {
      errors.push(`${label}.env: "${key}" is not a valid variable name — env ignored`);
      return undefined;
    }
    /**
     * Shared with the IPC guard, deliberately: a hand-edited `LD_PRELOAD` is
     * exactly as dangerous as one posted over the bridge, and the file is the
     * path an attacker would reach for precisely *because* it looks like the
     * unguarded one.
     */
    const unsafe = unsafeEnvReason(key);
    if (unsafe !== null) {
      errors.push(`${label}.env: ${unsafe} — env ignored`);
      return undefined;
    }
    if (typeof raw !== 'string') {
      errors.push(`${label}.env.${key}: expected a string — env ignored`);
      return undefined;
    }
    if (raw.length > MAX_ENV_VALUE) {
      errors.push(`${label}.env.${key}: too long — env ignored`);
      return undefined;
    }
    if (hasControlCharacters(raw)) {
      errors.push(`${label}.env.${key}: control characters are not allowed — env ignored`);
      return undefined;
    }
    env[key] = raw;
  }
  return env;
}

/**
 * HIVE-133's per-project container block.
 *
 * **All-or-nothing, like `optionalEnv` above.** A block with one bad field is
 * dropped entirely rather than half-applied: a container project missing its
 * `hiveDir` would spawn a session whose `--settings` names a path the container
 * cannot open, and failing at `claude` startup with an error about a file is
 * further from the cause than not being containerised at all. The project stays
 * usable as a host project, and the error names the field.
 */
/**
 * The block's own keys, checked the way every other block in this file is
 * (final-review fix) — `optionalJira` and `optionalReceiver` both run
 * `checkKeys` before validating any individual field, and this was the one
 * level of the file that did not: a hand-written `hostalias` (lowercase `a`)
 * fell through every check below as simply absent, so the block parsed as
 * valid with the typo silently ignored. `assertContainer` in `guards.ts`
 * already rejects that same typo via `assertShape` — closing this makes the
 * reader as strict as the guard on the one axis where it was looser, not just
 * as strict as it can afford to be.
 */
const CONTAINER_KEYS = ['workspace', 'hiveDir', 'envArg', 'probe', 'freshness', 'hostAlias'];

function optionalContainer(
  record: Record<string, unknown>,
  label: string,
  errors: string[],
): ContainerConfig | undefined {
  const value = record.container;
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push(`${label}.container: expected an object — ignored`);
    return undefined;
  }

  const at = `${label}.container`;
  if (!checkKeys(value, CONTAINER_KEYS, at, errors)) return undefined;

  /* Absolute, because a container path is joined onto, never resolved against a
     cwd this process does not have inside the container. */
  const absolute = (key: 'workspace' | 'hiveDir'): string | null => {
    if (!isAbsoluteContainerPath(value[key])) {
      errors.push(
        `${label}.container.${key}: required, and must be an absolute path — container ignored`,
      );
      return null;
    }
    return value[key];
  };

  const workspace = absolute('workspace');
  const hiveDir = absolute('hiveDir');
  if (workspace === null || hiveDir === null) return undefined;

  /*
    Validated, never defaulted. Absent stays absent all the way to
    `effectiveRuntime`, which is the layer that knows what to inherit from —
    the same division `ParsedConfig.shell` and `subscriptionAuth` already use.
  */
  if (value.envArg !== undefined && !isEnvArgTemplate(value.envArg)) {
    errors.push(
      `${label}.container.envArg: must contain {name} and {value} — container ignored`,
    );
    return undefined;
  }

  let probe: string | undefined;
  if (value.probe !== undefined) {
    if (!isContainerProbe(value.probe)) {
      errors.push(`${label}.container.probe: expected a non-empty string — container ignored`);
      return undefined;
    }
    probe = value.probe;
  }

  if (value.freshness !== undefined && !isContainerFreshness(value.freshness)) {
    errors.push(
      `${label}.container.freshness: expected "exec-env" or "rewrite" — container ignored`,
    );
    return undefined;
  }

  /*
    `isHostAlias` rather than a second spelling of "looks like a hostname". The
    per-project override names a network destination exactly as the global one
    does — it decides which host receives authenticated hook payloads — so it
    gets the same rule, not a looser one.
  */
  if (value.hostAlias !== undefined && !isHostAlias(value.hostAlias)) {
    errors.push(`${label}.container.hostAlias: not a valid hostname — container ignored`);
    return undefined;
  }

  /*
    Conditional spread, matching the entry build below: an `undefined`-valued
    own key would be reported as unknown the next time this file is read.
  */
  return {
    workspace,
    hiveDir,
    ...(value.envArg === undefined ? {} : { envArg: value.envArg }),
    ...(probe === undefined ? {} : { probe }),
    ...(value.freshness === undefined ? {} : { freshness: value.freshness }),
    ...(value.hostAlias === undefined ? {} : { hostAlias: value.hostAlias }),
  };
}

const PROJECT_ORIGINS: readonly string[] = ['local', 'cloned'];

function isProjectOrigin(value: unknown): value is ProjectOrigin {
  return typeof value === 'string' && PROJECT_ORIGINS.includes(value);
}

/**
 * `"//"`-prefixed keys are comments and are ignored.
 *
 * JSON has no comment syntax, and the template this story writes has to
 * explain itself in the file the user opens. `package.json` in this repo
 * already uses the same `"//"` convention for exactly that, so the idiom is
 * borrowed rather than invented.
 */
const isComment = (key: string): boolean => key.startsWith('//');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check a document's own keys, collecting problems instead of throwing.
 *
 * Returns `false` only for the one failure that makes everything after it
 * meaningless — a forbidden key. An unknown key is reported and skipped: a
 * typo in an optional field should name itself, not silently discard the
 * projects the user got right.
 */
function checkKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): boolean {
  let safe = true;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${label}: forbidden key "${key}" — ignoring the whole file`);
      safe = false;
      continue;
    }
    if (isComment(key) || allowed.includes(key)) continue;
    errors.push(`${label}: unknown key "${key}" — ignored`);
  }
  return safe;
}

/**
 * An optional boolean, defaulted by the caller when absent or malformed.
 *
 * Same discipline as {@link optionalString}: a wrong type is *reported and
 * ignored* rather than fatal, because one mistyped key must not stop the app
 * launching — and for this key in particular, a fatal parse would leave the
 * user with no sessions at all over a preference.
 */
function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): boolean | null {
  const value = record[key];
  if (value === undefined) return null;
  if (typeof value !== 'boolean') {
    errors.push(`${label}.${key}: expected true or false — using the default`);
    return null;
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): string | null {
  const value = record[key];
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${label}.${key}: expected a non-empty string — using the default`);
    return null;
  }
  return value;
}

/**
 * Read the notification block, keeping whatever the file got right (story 106).
 *
 * Per-key salvage, unlike `optionalEnv` above, and the difference is
 * deliberate: an env map is a single set of assumptions a command runs under,
 * so half of it is a stranger outcome than none of it. Three independent
 * switches are not that — a typo in one is no reason to silently restore the
 * default for the other two, which is a change the user did not make and would
 * not see.
 */
function optionalNotifications(
  record: Record<string, unknown>,
  label: string,
  errors: string[],
): Partial<NotificationPrefs> | undefined {
  const value = record.notifications;
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push(`${label}.notifications: expected an object — ignored`);
    return undefined;
  }

  const at = `${label}.notifications`;

  /**
   * Checked here rather than through `checkKeys`, for the message.
   *
   * `checkKeys` says "ignoring the whole file", which is true where it is used —
   * a forbidden key at the top level or on a project entry abandons the
   * document. It is not true here: a poisoned block costs the block and nothing
   * else, and telling the user their whole config was discarded would send them
   * looking for a problem that is not there.
   */
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${at}: forbidden key "${key}" — notifications ignored`);
      return undefined;
    }
  }

  /**
   * The three booleans this shape replaced are accepted, not reported.
   *
   * A config written before HIVE-75 holds them, and `resolveNotificationPrefs`
   * migrates them on load. Reporting them as unknown keys would put three
   * errors in the settings pane for a file the app understands perfectly well.
   */
  if (!checkKeys(value, [...NOTIFICATION_KEYS, ...LEGACY_NOTIFICATION_KEYS], at, errors))
    return undefined;

  const prefs: Partial<NotificationPrefs> = {};
  for (const key of NOTIFICATION_KEYS) {
    const raw = value[key];
    if (raw === undefined) continue;
    /**
     * A delivery, not a boolean (HIVE-75).
     *
     * The **legacy booleans are deliberately not read here.** They are not
     * listed in `NOTIFICATION_KEYS` any more, so `checkKeys` above would have
     * already reported them as unknown — except that it does not, because
     * `resolveNotificationPrefs` is what migrates them and it reads the raw
     * block. This loop only has to answer for the keys this build writes.
     */
    if (!isNotificationDelivery(raw)) {
      errors.push(
        `${at}.${key}: expected one of ${NOTIFICATION_DELIVERIES.join(', ')} — using the default`,
      );
      continue;
    }
    prefs[key] = raw;
  }

  /**
   * The legacy values travel through **unread and unvalidated** (HIVE-75,
   * extended HIVE-83).
   *
   * They must reach `resolveNotificationPrefs`, which is the only thing that
   * knows how to migrate them — and this function is what stands between the
   * file and that call. Filtering them out here is what made the first version
   * of this change silently reset the preference it was written to preserve:
   * the migration was correct and never saw its input.
   *
   * Two legacy shapes travel this path, not one: the pre-HIVE-75 booleans
   * (`sessionDone`, `sessionIdle`, `cloneDone`) and — scoped to
   * {@link RETIRED_SESSION_KEYS} only — the pre-HIVE-83 per-kind deliveries
   * `session.waiting` / `session.asked`, which held a `NotificationDelivery`
   * string, not a boolean. Forwarding only booleans silently dropped those
   * two, so a config that had turned session toasts off came back on.
   * `session.ended` stays boolean-only: HIVE-83 retired it outright, so a
   * `NotificationDelivery` on it has nowhere left to go and
   * `resolveNotificationPrefs` would only discard it anyway. `session.idle`
   * is not in this loop at all any more — HIVE-89 revived it as a live kind,
   * so the loop over `NOTIFICATION_KEYS` above reads it like any other. Not
   * validated beyond the type check, because a malformed legacy value is not
   * worth an error on a key this build no longer writes;
   * `resolveNotificationPrefs` ignores anything it does not recognise and
   * falls back to the registry default.
   */
  for (const key of LEGACY_NOTIFICATION_KEYS) {
    const raw = value[key];
    if (typeof raw === 'boolean') {
      (prefs as Record<string, unknown>)[key] = raw;
    } else if (
      (RETIRED_SESSION_KEYS as readonly string[]).includes(key) &&
      isNotificationDelivery(raw)
    ) {
      (prefs as Record<string, unknown>)[key] = raw;
    }
  }

  return prefs;
}

/**
 * The `jira` block (HIVE-67).
 *
 * Structurally identical to {@link optionalNotifications}, including its
 * narrower forbidden-key message and for the same reason: a poisoned block
 * costs the block and nothing else, and telling the user their whole config was
 * discarded would send them looking for a problem that is not there.
 *
 * A field that is present but not a string is reported and skipped, rather than
 * costing the block. Someone who typed a number for `site` has one thing wrong,
 * and losing their email as well would be a second surprise.
 */
function optionalJira(
  record: Record<string, unknown>,
  label: string,
  errors: string[],
): Partial<JiraConfig> | undefined {
  const value = record.jira;
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push(`${label}.jira: expected an object — ignored`);
    return undefined;
  }

  const at = `${label}.jira`;

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${at}: forbidden key "${key}" — jira ignored`);
      return undefined;
    }
  }

  if (!checkKeys(value, JIRA_KEYS, at, errors)) return undefined;

  const jira: Partial<JiraConfig> = {};
  for (const key of JIRA_KEYS) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || raw.trim() === '') {
      errors.push(`${at}.${key}: expected a non-empty string — ignored`);
      continue;
    }
    jira[key] = raw;
  }
  return jira;
}

/**
 * A TCP port from the file, or `null` for the caller's default.
 *
 * The first numeric value in this file, so it defines the shape rather than
 * following one: reported and ignored on a wrong type, exactly as
 * {@link optionalString} and {@link optionalBoolean} treat theirs, because one
 * mistyped key must not stop the app launching.
 *
 * `0` is legal and means "ask the OS", which is why the range starts there
 * rather than at 1.
 */
function optionalPort(
  record: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): number | null {
  const value = record[key];
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65_535) {
    errors.push(`${label}.${key}: expected a port from 0 to 65535 — using the default`);
    return null;
  }
  return value;
}

/**
 * HIVE-134's nested bind block.
 *
 * Per-field salvage, like {@link optionalNotifications} and unlike
 * {@link optionalEnv}: three independent settings, so a typo in one is no
 * reason to restore the defaults for the other two. A bad `allowedOrigins`
 * entry costs that entry and not the list, which is `optionalSlack`'s rule for
 * `commanders` and for its reason — someone who typed one origin wrong should
 * not lose the other three, and losing the whole list silently turns the
 * allowlist into "refuse every origin", a failure that looks exactly like the
 * feature being broken.
 */
function optionalBind(
  record: Record<string, unknown>,
  label: string,
  errors: string[],
): Partial<ReceiverBindConfig> | undefined {
  const value = record.bind;
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push(`${label}.bind: expected an object — ignored`);
    return undefined;
  }

  const at = `${label}.bind`;

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${at}: forbidden key "${key}" — bind ignored`);
      return undefined;
    }
  }

  if (!checkKeys(value, BIND_KEYS, at, errors)) return undefined;

  const bind: Partial<ReceiverBindConfig> = {};

  const host = value.host;
  if (host !== undefined) {
    if (isHostAlias(host)) {
      bind.host = host;
    } else {
      errors.push(`${at}.host: expected a hostname or an IPv4 address — using the default`);
    }
  }

  const port = optionalPort(value, 'port', at, errors);
  if (port !== null) bind.port = port;

  const origins = value.allowedOrigins;
  if (origins !== undefined) {
    if (!Array.isArray(origins)) {
      errors.push(`${at}.allowedOrigins: expected an array — using the default`);
    } else {
      const kept: string[] = [];
      (origins as unknown[]).forEach((entry, index) => {
        if (isOrigin(entry)) {
          kept.push(entry);
          return;
        }
        errors.push(
          `${at}.allowedOrigins[${index}]: expected an origin like http://localhost:5173 — entry ignored`,
        );
      });
      bind.allowedOrigins = kept;
    }
  }

  return bind;
}

/**
 * HIVE-131's receiver block.
 *
 * Structurally identical to {@link optionalJira}, including its block-scoped
 * rejections: a malformed block is reported and dropped, and the rest of the
 * file still applies.
 */
function optionalReceiver(
  record: Record<string, unknown>,
  label: string,
  errors: string[],
):
  | (Partial<Omit<ReceiverConfig, 'bind'>> & { bind?: Partial<ReceiverBindConfig> })
  | undefined {
  const value = record.receiver;
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push(`${label}.receiver: expected an object — ignored`);
    return undefined;
  }

  const at = `${label}.receiver`;

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${at}: forbidden key "${key}" — receiver ignored`);
      return undefined;
    }
  }

  if (!checkKeys(value, RECEIVER_KEYS, at, errors)) return undefined;

  const receiver: Partial<Omit<ReceiverConfig, 'bind'>> & { bind?: Partial<ReceiverBindConfig> } =
    {};
  const raw = value.hostAlias;
  if (raw !== undefined) {
    if (isHostAlias(raw)) {
      receiver.hostAlias = raw;
    } else {
      errors.push(
        `${at}.hostAlias: expected a hostname — no scheme, path or port`,
      );
    }
  }

  const bind = optionalBind(value, at, errors);
  if (bind !== undefined) receiver.bind = bind;

  return receiver;
}

/** A 64-character lowercase hex digest — a SHA-256 output, as text. */
const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * HIVE-142's nested `server.bind` block.
 *
 * Structurally {@link optionalBind}'s twin, with two differences the shape
 * forces: `host` is checked against {@link isServerBindHost}, not
 * {@link isHostAlias}, and `0.0.0.0` gets its own message naming the value
 * rather than the generic "expected a hostname" — see
 * {@link isServerBindHost}'s doc comment for why the wildcard is refused here
 * and not for the receiver. `port` gets the same treatment for `0`: unlike
 * {@link ReceiverBindConfig.port}, `server.bind.port` cannot be OS-assigned —
 * see {@link ServerBindConfig.port}'s own doc comment for why — so `0` is
 * refused here rather than the generic "using the default" salvage
 * `optionalPort` would otherwise apply.
 */
function optionalServerBind(
  record: Record<string, unknown>,
  label: string,
  errors: string[],
): Partial<ServerBindConfig> | undefined {
  const value = record.bind;
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push(`${label}.bind: expected an object — ignored`);
    return undefined;
  }

  const at = `${label}.bind`;

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${at}: forbidden key "${key}" — bind ignored`);
      return undefined;
    }
  }

  if (!checkKeys(value, SERVER_BIND_KEYS, at, errors)) return undefined;

  const bind: Partial<ServerBindConfig> = {};

  const host = value.host;
  if (host !== undefined) {
    if (host === '0.0.0.0') {
      errors.push(
        `${at}.host: 0.0.0.0 binds every interface — name the address this machine is reached at`,
      );
    } else if (isServerBindHost(host)) {
      bind.host = host;
    } else {
      errors.push(`${at}.host: expected a hostname or an IPv4 address — using the default`);
    }
  }

  if (value.port === 0) {
    errors.push(
      `${at}.port: 0 asks the OS for any free port, but server.bind.port must be fixed — a client's config and a LaunchAgent both have to name this port ahead of time — using the default`,
    );
  } else {
    const port = optionalPort(value, 'port', at, errors);
    if (port !== null) bind.port = port;
  }

  const origins = value.allowedOrigins;
  if (origins !== undefined) {
    if (!Array.isArray(origins)) {
      errors.push(`${at}.allowedOrigins: expected an array — using the default`);
    } else {
      const kept: string[] = [];
      (origins as unknown[]).forEach((entry, index) => {
        if (isOrigin(entry)) {
          kept.push(entry);
          return;
        }
        errors.push(
          `${at}.allowedOrigins[${index}]: expected an origin like http://localhost:5173 — entry ignored`,
        );
      });
      bind.allowedOrigins = kept;
    }
  }

  return bind;
}

/**
 * What every `optionalDevices` rejection ends its message with (HIVE-142
 * review, I6).
 *
 * A dropped entry here is not merely absent from *this* load the way a bad
 * project or a bad origin is — `pairDevice`/`revokeDevice`
 * (`server/devices.ts`) read the already-filtered roster and write it back
 * wholesale (`setServer({ devices })`), so a device this parser drops is
 * erased from the file for good the next time anyone pairs or revokes
 * anything, not merely ignored until the typo is fixed. One hand-edit typo
 * costs a real paired device permanently, which "device dropped" alone does
 * not say.
 */
const DEVICE_LOST =
  'device dropped, and erased for good the next time anything pairs or revokes a device';

/**
 * HIVE-142's `devices` array.
 *
 * Whole-entry salvage, unlike `optionalBind`'s per-field rule: a device is an
 * identity plus a credential, and a device short one field is not "the same
 * device with a default filled in" the way a bind missing its port is — it is
 * a paired device this file cannot describe. A bad entry costs that entry, not
 * the roster, the same rule `commanders` and `allowedOrigins` follow — see
 * {@link DEVICE_LOST} for why every message below says what that cost really
 * is, rather than just "dropped".
 */
function optionalDevices(
  record: Record<string, unknown>,
  label: string,
  errors: string[],
): readonly ServerDevice[] | undefined {
  const value = record.devices;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${label}.devices: expected an array — ignored`);
    return undefined;
  }

  const at = `${label}.devices`;
  const kept: ServerDevice[] = [];

  value.forEach((entry, index) => {
    const entryAt = `${at}[${index}]`;

    if (!isPlainObject(entry)) {
      errors.push(`${entryAt}: expected an object — ${DEVICE_LOST}`);
      return;
    }

    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_KEYS.has(key)) {
        errors.push(`${entryAt}: forbidden key "${key}" — ${DEVICE_LOST}`);
        return;
      }
    }

    if (!checkKeys(entry, SERVER_DEVICE_KEYS, entryAt, errors)) return;

    if (typeof entry.id !== 'string' || entry.id.trim() === '') {
      errors.push(`${entryAt}.id: expected a non-empty string — ${DEVICE_LOST}`);
      return;
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      errors.push(`${entryAt}.name: expected a non-empty string — ${DEVICE_LOST}`);
      return;
    }
    if (typeof entry.paired !== 'string' || entry.paired.trim() === '') {
      errors.push(`${entryAt}.paired: expected an ISO date string — ${DEVICE_LOST}`);
      return;
    }
    if (typeof entry.revoked !== 'boolean') {
      errors.push(`${entryAt}.revoked: expected true or false — ${DEVICE_LOST}`);
      return;
    }

    const credential = entry.credential;
    if (
      !isPlainObject(credential) ||
      credential.kind !== 'sha256' ||
      typeof credential.digest !== 'string' ||
      !HEX_SHA256.test(credential.digest)
    ) {
      errors.push(
        `${entryAt}.credential: expected { kind: "sha256", digest: <64-character hex> } — ${DEVICE_LOST}`,
      );
      return;
    }

    kept.push({
      id: entry.id,
      name: entry.name,
      paired: entry.paired,
      revoked: entry.revoked,
      credential: { kind: 'sha256', digest: credential.digest },
    });
  });

  return kept;
}

/**
 * HIVE-142's server block.
 *
 * Structurally {@link optionalReceiver}'s twin: a malformed block is reported
 * and dropped wholesale, while `bind` and `devices` salvage what they can
 * within it.
 */
function optionalServer(
  record: Record<string, unknown>,
  label: string,
  errors: string[],
):
  | (Partial<Omit<ServerConfig, 'bind'>> & { bind?: Partial<ServerBindConfig> })
  | undefined {
  const value = record.server;
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push(`${label}.server: expected an object — ignored`);
    return undefined;
  }

  const at = `${label}.server`;

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${at}: forbidden key "${key}" — server ignored`);
      return undefined;
    }
  }

  if (!checkKeys(value, SERVER_KEYS, at, errors)) return undefined;

  const server: Partial<Omit<ServerConfig, 'bind'>> & { bind?: Partial<ServerBindConfig> } = {};

  const enabled = optionalBoolean(value, 'enabled', at, errors);
  if (enabled !== null) server.enabled = enabled;

  const bind = optionalServerBind(value, at, errors);
  if (bind !== undefined) server.bind = bind;

  const devices = optionalDevices(value, at, errors);
  if (devices !== undefined) server.devices = devices;

  return server;
}

const REMOTE_MODES: readonly RemoteMode[] = ['local', 'remote'];

/**
 * HIVE-144's remote block.
 *
 * Structurally {@link optionalServer}'s twin, per-field salvage rather than
 * whole-block: a file naming a bad `port` alongside a good `mode` and `host`
 * should not lose the two fields it got right.
 *
 * `host`'s validation is the one field-order dependency in this function —
 * `mode` is read first because Ruling 3 (HIVE-144) says `host` is checked by
 * {@link isRemoteTarget} only when *this block's own* `mode` is `'remote'`.
 * An absent `mode` falls back to {@link DEFAULT_REMOTE}'s `'local'` for this
 * purpose, which is what keeps a file naming only `host` (or naming neither)
 * from reporting an error on the empty default every never-attached install
 * carries.
 */
function optionalRemote(
  record: Record<string, unknown>,
  label: string,
  errors: string[],
): Partial<RemoteConfig> | undefined {
  const value = record.remote;
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push(`${label}.remote: expected an object — ignored`);
    return undefined;
  }

  const at = `${label}.remote`;

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${at}: forbidden key "${key}" — remote ignored`);
      return undefined;
    }
  }

  if (!checkKeys(value, REMOTE_KEYS, at, errors)) return undefined;

  const remote: Partial<RemoteConfig> = {};

  let mode: RemoteMode | undefined;
  if (value.mode !== undefined) {
    if (REMOTE_MODES.includes(value.mode as RemoteMode)) {
      mode = value.mode as RemoteMode;
      remote.mode = mode;
    } else {
      errors.push(`${at}.mode: expected "local" or "remote" — using the default`);
    }
  }

  const host = value.host;
  if (host !== undefined) {
    if (typeof host !== 'string') {
      errors.push(`${at}.host: expected a string — using the default`);
    } else if (mode !== 'remote') {
      // Ruling 3 (HIVE-144): unvalidated outside remote mode, so the empty
      // default every never-attached install carries is not an error.
      remote.host = host;
    } else if (isRemoteTarget(host)) {
      remote.host = host;
    } else {
      errors.push(
        `${at}.host: must be loopback or a tailnet address — this socket is plaintext, so anything else would send a credential to the open internet — using the default`,
      );
    }
  }

  const port = optionalPort(value, 'port', at, errors);
  if (port !== null) remote.port = port;

  return remote;
}

/**
 * The `slack` block (HIVE-124).
 *
 * Structurally a sibling of {@link optionalJira}, with two differences the
 * shape forces: `socketMode` is a boolean and `commanders` is an array of
 * strings, so the all-strings loop `optionalJira` uses does not fit.
 *
 * A bad entry inside `commanders` costs that entry, not the list. Someone who
 * typed one id wrong should not lose the other three, and losing the whole
 * allow-list silently turns the command channel off — a failure that looks
 * exactly like the feature being broken.
 */
function optionalSlack(
  record: Record<string, unknown>,
  label: string,
  errors: string[],
): Partial<SlackConfig> | undefined {
  const value = record.slack;
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push(`${label}.slack: expected an object — ignored`);
    return undefined;
  }

  const at = `${label}.slack`;

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${at}: forbidden key "${key}" — slack ignored`);
      return undefined;
    }
  }

  if (!checkKeys(value, SLACK_KEYS, at, errors)) return undefined;

  const slack: Partial<SlackConfig> = {};

  if (value.socketMode !== undefined) {
    if (typeof value.socketMode !== 'boolean') {
      errors.push(`${at}.socketMode: expected a boolean — using the default`);
    } else {
      slack.socketMode = value.socketMode;
    }
  }

  if (value.commanders !== undefined) {
    if (!Array.isArray(value.commanders)) {
      errors.push(`${at}.commanders: expected an array — using the default`);
    } else {
      const ids: string[] = [];
      for (const raw of value.commanders) {
        if (typeof raw !== 'string' || raw.trim() === '') {
          errors.push(`${at}.commanders: expected a non-empty string — entry ignored`);
          continue;
        }
        ids.push(raw.trim());
      }
      slack.commanders = ids;
    }
  }

  return slack;
}

export function parseConfig(text: string, label: string): ParsedConfig {
  const errors: string[] = [];
  // Every `return empty` below is a wholesale rejection, so `fatal` is set
  // once here rather than at each of the four sites.
  const empty: ParsedConfig = {
    shell: null,
    claudeCommand: null,
    subscriptionAuth: null,
    sessionMetrics: null,
    importLoginEnv: null,
    projects: [],
    errors,
    version: null,
    fatal: true,
  };

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    // One error, not one per entry: the file never got as far as having
    // entries, and a wall of derived failures would bury the real cause.
    errors.push(
      `${label}: not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    return empty;
  }

  if (!isPlainObject(document)) {
    errors.push(`${label}: expected a JSON object at the top level`);
    return empty;
  }

  if (!checkKeys(document, TOP_LEVEL_KEYS, label, errors)) return empty;

  const version = document.version;
  if (typeof version !== 'number' || !SUPPORTED_CONFIG_VERSIONS.includes(version)) {
    // Refused rather than guessed at. A future version may move a field, and
    // interpreting it under this version's rules would point a PTY somewhere
    // the user did not ask for.
    errors.push(
      `${label}: unsupported version ${JSON.stringify(version)} — expected one of ${SUPPORTED_CONFIG_VERSIONS.join(', ')}`,
    );
    return empty;
  }

  const shell = optionalString(document, 'shell', label, errors);
  const claudeCommand = optionalString(document, 'claudeCommand', label, errors);
  const notifications = optionalNotifications(document, label, errors);
  const jira = optionalJira(document, label, errors);
  const receiver = optionalReceiver(document, label, errors);
  const server = optionalServer(document, label, errors);
  const remote = optionalRemote(document, label, errors);
  const slack = optionalSlack(document, label, errors);
  const subscriptionAuth = optionalBoolean(
    document,
    'subscriptionAuth',
    label,
    errors,
  );
  const sessionMetrics = optionalBoolean(
    document,
    'sessionMetrics',
    label,
    errors,
  );
  const importLoginEnv = optionalBoolean(
    document,
    'importLoginEnv',
    label,
    errors,
  );
  // Story 108. `optionalEnv` reads its target off `record.env` internally —
  // the same call shape the per-project overrides below use (`optionalEnv(entry, at, errors)`)
  // — so it is handed the document itself, not `document.env`, and it already
  // returns `undefined` untouched when the file declares no block.
  const env = optionalEnv(document, label, errors);

  const raw = document.projects;
  if (raw === undefined) {
    return {
      shell,
      claudeCommand,
      subscriptionAuth,
      sessionMetrics,
      importLoginEnv,
      env,
      notifications,
      jira,
      receiver,
      server,
      remote,
      slack,
      projects: [],
      errors,
      version,
      fatal: false,
    };
  }
  if (!Array.isArray(raw)) {
    errors.push(`${label}.projects: expected an array`);
    return {
      shell,
      claudeCommand,
      subscriptionAuth,
      sessionMetrics,
      importLoginEnv,
      env,
      notifications,
      jira,
      receiver,
      server,
      remote,
      slack,
      projects: [],
      errors,
      version,
      fatal: false,
    };
  }

  const projects: RawProject[] = [];
  raw.forEach((entry, index) => {
    const at = `${label}.projects[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at}: expected an object`);
      return;
    }
    if (!checkKeys(entry, PROJECT_KEYS, at, errors)) return;

    let id: string;
    try {
      // The same rule the IPC boundary applies (story 082): a bounded,
      // printable token. This id is a lookup key that will reach process
      // control, and a path separator inside it is a key that can be made to
      // mean something other than it looks like.
      id = assertId(entry.id, `${at}.id`);
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    if (typeof entry.path !== 'string' || entry.path.trim() === '') {
      errors.push(`${at}.path: expected a non-empty string`);
      return;
    }

    /*
      HIVE-94's alias. Rejected the way `origin` is — the whole entry is
      dropped and the reason reported — rather than silently regenerated. A key
      is a thing the user typed into the file expecting to be able to type it
      into the console, and quietly substituting a different one would leave
      them with a config that does not do what it says.
    */
    let key: string | undefined;
    if (entry.key !== undefined) {
      if (typeof entry.key !== 'string' || !isProjectKey(entry.key)) {
        errors.push(`${at}.key: expected ${PROJECT_KEY_HINT}`);
        return;
      }
      key = entry.key;
    }

    // The three fields story 101 adds. Each is optional: a v1 file omits all
    // of them, and `resolveProject` supplies the defaults in memory.
    let name: string | undefined;
    if (entry.name !== undefined) {
      if (typeof entry.name !== 'string' || entry.name.trim() === '') {
        errors.push(`${at}.name: expected a non-empty string`);
        return;
      }
      name = entry.name;
    }

    let icon: string | undefined;
    if (entry.icon !== undefined) {
      if (typeof entry.icon !== 'string' || entry.icon.trim() === '') {
        errors.push(`${at}.icon: expected a non-empty string`);
        return;
      }
      icon = entry.icon;
    }

    let origin: ProjectOrigin | undefined;
    if (entry.origin !== undefined) {
      if (!isProjectOrigin(entry.origin)) {
        errors.push(`${at}.origin: expected "local" or "cloned"`);
        return;
      }
      origin = entry.origin;
    }

    // Story 104's overrides. `optionalString` reports and returns null for a
    // blank value, which is the right reading: an empty override is not a
    // command, and inheriting beats spawning "".
    const shellOverride = optionalString(entry, 'shell', at, errors);
    const commandOverride = optionalString(entry, 'claudeCommand', at, errors);
    const env = optionalEnv(entry, at, errors);
    const container = optionalContainer(entry, at, errors);

    // Conditional spread, matching `parseSpawnRequest`: an `undefined`-valued
    // own key would be reported as unknown the next time this file is read.
    projects.push({
      id,
      path: entry.path,
      ...(key !== undefined ? { key } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(shellOverride !== null ? { shell: shellOverride } : {}),
      ...(commandOverride !== null ? { claudeCommand: commandOverride } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(container !== undefined ? { container } : {}),
    });
  });

  return {
    shell,
    claudeCommand,
    subscriptionAuth,
    sessionMetrics,
    importLoginEnv,
    env,
    notifications,
    jira,
    receiver,
    server,
    remote,
    slack,
    projects,
    errors,
    version,
    fatal: false,
  };
}

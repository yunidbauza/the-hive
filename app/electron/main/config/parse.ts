import {
  NOTIFICATION_KEYS,
  SUPPORTED_CONFIG_VERSIONS,
  unsafeEnvReason,
  type NotificationPrefs,
  type ProjectOrigin,
} from '@shared/config-contract';
import { assertId } from '@shared/guards';

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
  /** Absent when the file omitted it; `resolveProject` supplies the default. */
  name?: string;
  icon?: string;
  origin?: ProjectOrigin;
  /** Story 104's per-project runtime overrides. Absent means "inherit". */
  shell?: string;
  claudeCommand?: string;
  env?: Record<string, string>;
}

export interface ParsedConfig {
  /** `null` when the file did not name one; the caller applies the default. */
  shell: string | null;
  claudeCommand: string | null;
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
  'projects',
  // Story 106. Listed so a hand-written block is read rather than reported as
  // an unknown key — the same courtesy story 104 extended to the per-project
  // runtime overrides below.
  'notifications',
];
/**
 * `shell`, `claudeCommand` and `env` are story 104's per-project overrides.
 *
 * They are listed here so a hand-written override is *read* rather than
 * reported as an unknown key. Unlisted keys are still preserved across a write
 * — the mutations spread the raw entry — but they are ignored on load, which is
 * not what a user who typed `"shell"` into their config expects to happen.
 */
const PROJECT_KEYS = [
  'id',
  'path',
  'name',
  'icon',
  'origin',
  'shell',
  'claudeCommand',
  'env',
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

const ORIGINS: readonly string[] = ['local', 'cloned'];

function isOrigin(value: unknown): value is ProjectOrigin {
  return typeof value === 'string' && ORIGINS.includes(value);
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

  if (!checkKeys(value, NOTIFICATION_KEYS, at, errors)) return undefined;

  const prefs: Partial<NotificationPrefs> = {};
  for (const key of NOTIFICATION_KEYS) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'boolean') {
      errors.push(`${at}.${key}: expected a boolean — using the default`);
      continue;
    }
    prefs[key] = raw;
  }
  return prefs;
}

export function parseConfig(text: string, label: string): ParsedConfig {
  const errors: string[] = [];
  // Every `return empty` below is a wholesale rejection, so `fatal` is set
  // once here rather than at each of the four sites.
  const empty: ParsedConfig = {
    shell: null,
    claudeCommand: null,
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

  const raw = document.projects;
  if (raw === undefined) {
    return {
      shell,
      claudeCommand,
      notifications,
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
      notifications,
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
      if (!isOrigin(entry.origin)) {
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

    // Conditional spread, matching `parseSpawnRequest`: an `undefined`-valued
    // own key would be reported as unknown the next time this file is read.
    projects.push({
      id,
      path: entry.path,
      ...(name !== undefined ? { name } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(shellOverride !== null ? { shell: shellOverride } : {}),
      ...(commandOverride !== null ? { claudeCommand: commandOverride } : {}),
      ...(env !== undefined ? { env } : {}),
    });
  });

  return {
    shell,
    claudeCommand,
    notifications,
    projects,
    errors,
    version,
    fatal: false,
  };
}

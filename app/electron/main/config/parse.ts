import { CONFIG_VERSION } from '@shared/config-contract';
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
}

export interface ParsedConfig {
  /** `null` when the file did not name one; the caller applies the default. */
  shell: string | null;
  claudeCommand: string | null;
  projects: RawProject[];
  errors: string[];
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

const TOP_LEVEL_KEYS = ['version', 'shell', 'claudeCommand', 'projects'];
const PROJECT_KEYS = ['id', 'path'];

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

export function parseConfig(text: string, label: string): ParsedConfig {
  const errors: string[] = [];
  const empty: ParsedConfig = {
    shell: null,
    claudeCommand: null,
    projects: [],
    errors,
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

  if (document.version !== CONFIG_VERSION) {
    // Refused rather than guessed at. A future version may move a field, and
    // interpreting it under this version's rules would point a PTY somewhere
    // the user did not ask for.
    errors.push(
      `${label}: unsupported version ${JSON.stringify(document.version)} — expected ${CONFIG_VERSION}`,
    );
    return empty;
  }

  const shell = optionalString(document, 'shell', label, errors);
  const claudeCommand = optionalString(document, 'claudeCommand', label, errors);

  const raw = document.projects;
  if (raw === undefined) return { shell, claudeCommand, projects: [], errors };
  if (!Array.isArray(raw)) {
    errors.push(`${label}.projects: expected an array`);
    return { shell, claudeCommand, projects: [], errors };
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

    projects.push({ id, path: entry.path });
  });

  return { shell, claudeCommand, projects, errors };
}

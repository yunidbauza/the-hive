import type {
  AddProjectRequest,
  CloneRequest,
  DiagnoseCommandRequest,
  DiagnoseEnvRequest,
  RemoveProjectRequest,
  RenameProjectRequest,
  ReorderProjectsRequest,
  AddJiraCommentRequest,
  ApplyJiraTransitionRequest,
  JiraConversationRequest,
  JiraIssueRequest,
  JiraSearchRequest,
  JiraTransitionsRequest,
  RepointProjectRequest,
  SetJiraRequest,
  SetJiraTokenRequest,
  SetNotificationsRequest,
  SetProjectKeyRequest,
  SetProjectRuntimeRequest,
  SetRuntimeRequest,
} from './config-contract';
import {
  NOTIFICATION_KEYS,
  PROJECT_KEY_HINT,
  isProjectKey,
  unsafeEnvReason,
} from './config-contract';
import type {
  ReadDirRequest,
  ReadFileRequest,
  WatchRequest,
  WriteFileRequest,
} from './fs-contract';
import { MAX_FILE_BYTES } from './fs-contract';
import type {
  AckRequest,
  ResizeRequest,
  SpawnRequest,
  WriteRequest,
} from './ipc-contract';
import { ISSUE_KEY_PATTERN } from './jira-contract';
import type { NotificationAction } from './notification-contract';
import {
  NOTIFICATION_DELIVERIES,
  isNotificationDelivery,
} from './notification-contract';
import {
  SESSION_EFFORTS,
  SESSION_MODELS,
  SESSION_NAME_MAX,
  SESSION_THEMES,
  isSendableSessionName,
} from './session-contract';
import type { SessionNoteRequest } from './session-history-contract';
import { RESERVED_SKILL_NAME, SKILL_NAME_PATTERN } from './skills-contract';
import type {
  SkillNameRequest,
  SkillWriteRequest,
} from './skills-contract';

/**
 * Payload guards (story 082).
 *
 * Hand-written type guards, not casts. A cast is a lie the compiler agrees to;
 * these return a typed value or throw. No runtime dependency is introduced for
 * this — the payload set is small and closed, and hand-written guards are
 * directly unit-testable, which a schema library's internals are not.
 *
 * The renderer is treated as untrusted input, because terminal output is
 * untrusted input and it renders there. `sessionId` is the highest-value field
 * in the contract: it arrives from the renderer and reaches process control in
 * story 092.
 */

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcValidationError';
  }
}

const fail = (message: string): never => {
  throw new IpcValidationError(message);
};

/**
 * Keys that must never appear on an incoming payload.
 *
 * `JSON.parse('{"__proto__": {...}}')` produces an *own* property named
 * `__proto__`. Spreading or assigning such an object into another can pollute
 * `Object.prototype`, and every later `{}` in the process inherits the
 * attacker's properties. Rejecting the key outright is cheaper and more
 * obvious than sanitising after the fact.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A plain object with an exact key set and no prototype-polluting keys. */
function assertShape(
  value: unknown,
  required: readonly string[],
  label: string,
  /**
   * Keys that may appear but need not.
   *
   * Kept separate from `required` rather than folded into one list, because
   * the two are checked in opposite directions: an unlisted key is rejected,
   * a missing *required* key is rejected, and a missing optional key is the
   * ordinary case. Collapsing them would silently make every field optional.
   */
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(`${label}: expected an object, got ${describe(value)}`);
  }
  const allowed = [...required, ...optional];

  // `Object.keys` sees own enumerable keys, which is what JSON.parse produces —
  // including a literal `__proto__` key.
  const keys = Object.keys(value);
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) {
      return fail(`${label}: forbidden key "${key}"`);
    }
    if (!allowed.includes(key)) {
      // Extra fields are rejected rather than ignored: an unexpected key means
      // the two sides disagree about the contract, and guessing which side is
      // right is how a security boundary erodes.
      return fail(`${label}: unexpected key "${key}"`);
    }
  }
  for (const key of required) {
    if (!keys.includes(key)) return fail(`${label}: missing key "${key}"`);
  }
  return value as Record<string, unknown>;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    return fail(`${label}: expected a string, got ${describe(value)}`);
  }
  return value;
}

/**
 * A session id must be a non-empty, bounded, printable token.
 *
 * It is used to look up a live PTY and — once story 092 lands — reaches process
 * control. An unbounded string is a memory and log-injection concern; a string
 * with control characters or path separators is a lookup key that can be made
 * to mean something other than it looks like.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertId(value: unknown, label: string): string {
  const id = assertString(value, label);
  if (!ID_PATTERN.test(id)) return fail(`${label}: malformed id`);
  return id;
}

/**
 * A project key (HIVE-94) — the alias a user types instead of an id.
 *
 * Narrower than {@link assertId} on purpose, and not a relaxation of it: the
 * pattern is closed to two-to-four lowercase letters, so nothing that reaches a
 * `cwd`, a lookup table, or a log line can be smuggled through this field. The
 * pattern itself lives in `config-contract.ts` because the config reader and
 * the Settings editor need the same rule — see {@link PROJECT_KEY_PATTERN}.
 *
 * Trimmed first, like a name is: the inline editor commits on blur, and a key
 * that arrived with a trailing space would be refused for a reason invisible on
 * screen.
 */
export function assertProjectKey(value: unknown, label: string): string {
  const key = assertString(value, label).trim();
  if (!isProjectKey(key)) return fail(`${label}: expected ${PROJECT_KEY_HINT}`);
  return key;
}

/** Terminal geometry. Bounded on both ends — a PTY cannot be 0 or 100000 wide. */
function assertDimension(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fail(`${label}: expected an integer, got ${describe(value)}`);
  }
  if (value < 1 || value > 10_000) return fail(`${label}: out of range`);
  return value;
}

/**
 * Free text that will be **written into a pty** (story 097).
 *
 * Bounded, and control characters are rejected outright rather than stripped.
 * A `\r` would submit a line the user never typed; an ESC would let a payload
 * address the cursor, set the window title, or switch to the alternate screen
 * in a terminal the user is reading and trusts. Rejecting names the field that
 * was wrong; stripping would silently send something other than what was asked
 * for, which is the worse failure for a routing layer.
 *
 * The range is tested by code point rather than a regex literal, so this file
 * stays free of control bytes and `no-control-regex` never has to be disabled.
 */
const MAX_TEXT = 4096;

/**
 * Upper bound on a reorder payload (story 103).
 *
 * Generous — nobody maps a thousand repositories — but finite, which is the
 * point: the legitimate value is bounded by the projects on disk.
 */
const MAX_PROJECT_IDS = 1000;

function assertText(value: unknown, label: string): string {
  const text = assertString(value, label);
  if (text.length === 0) return fail(`${label}: must not be empty`);
  if (text.length > MAX_TEXT) return fail(`${label}: too long`);
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // C0 (which includes CR, LF and ESC), DEL, and the C1 block.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return fail(`${label}: control characters are not allowed`);
    }
  }
  return text;
}

/**
 * A boolean, and **never a coercion** of one (HIVE-84).
 *
 * `Boolean('false')` is `true`, and `Boolean(0)` is `false` — a bridge that
 * coerced would turn a renderer bug into a silently inverted setting, which for
 * a switch that governs whether this app runs the user's rc file is the wrong
 * way to be lenient. The notification guard already states this rule in prose;
 * this is the first payload that needs it enforced.
 */
function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') return fail(`${label}: expected a boolean`);
  return value;
}

/**
 * One of a closed set of literals, or a refusal naming what was allowed.
 *
 * **The only guard in this file whose output reaches a command line**
 * (story 109). `model` and `effort` are interpolated into the string main
 * writes into a login shell, so `assertText` — bounded, printable, no control
 * characters — would not be enough: a space is printable, and
 * `opus --dangerously-skip-permissions` is a perfectly well-formed piece of
 * free text. Membership of a fixed list is what makes the value unquotable
 * rather than merely quoted, which is the difference between a guard that has
 * to be right and one that cannot be wrong.
 *
 * The message lists the permitted values, because the realistic reader of it is
 * whoever added a model to the picker and not to the contract.
 */
function assertOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  const text = assertString(value, label);
  if (!allowed.includes(text)) {
    return fail(`${label}: expected one of ${allowed.join(', ')}`);
  }
  return text as T[number];
}

export function parseSpawnRequest(input: unknown): SpawnRequest {
  const raw = assertShape(
    input,
    ['sessionId', 'projectId', 'cols', 'rows'],
    'spawn',
    ['task', 'model', 'effort', 'name', 'theme', 'resume'],
  );
  return {
    sessionId: assertId(raw.sessionId, 'spawn.sessionId'),
    projectId: assertId(raw.projectId, 'spawn.projectId'),
    cols: assertDimension(raw.cols, 'spawn.cols'),
    rows: assertDimension(raw.rows, 'spawn.rows'),
    /**
     * Spread rather than `task: undefined`. The returned object is compared
     * key-for-key by this module's own tests ("does not pass through anything
     * beyond the declared fields"), and an own property whose value is
     * undefined is still a key.
     */
    ...(raw.task === undefined
      ? {}
      : { task: assertText(raw.task, 'spawn.task') }),
    ...(raw.model === undefined
      ? {}
      : { model: assertOneOf(raw.model, SESSION_MODELS, 'spawn.model') }),
    ...(raw.effort === undefined
      ? {}
      : { effort: assertOneOf(raw.effort, SESSION_EFFORTS, 'spawn.effort') }),
    /**
     * The display name, when the renderer has a better one than the id
     * (HIVE-78).
     *
     * `model` and `effort` are checked against closed lists; this cannot be,
     * because a name is not drawn from one. So it is matched against
     * {@link SESSION_NAME_PATTERN}, which is the same defence and for the same
     * reason `assertJiraIssueKey` matches rather than escapes: the value is
     * interpolated into a command line a login shell parses, and no character
     * that pattern admits means anything to a shell.
     *
     * Rejected rather than dropped here, unlike `bootstrap.ts` which silently
     * omits the flag. The two are not inconsistent: main's own spawn path can
     * reach `bootstrap.ts` with no guard in between, so it needs a lenient
     * fallback, whereas a *renderer* sending an unsendable name is sending
     * something it constructed wrongly and should hear about.
     */
    ...(raw.name === undefined
      ? {}
      : { name: assertSessionName(raw.name, 'spawn.name') }),
    /**
     * A closed list, like `model` and `effort` and for the same reason: it
     * chooses a **path on a command line** — which of the two settings files
     * the session is started with — and a value outside the list would name a
     * file that does not exist. Rejecting is right rather than defaulting: a
     * renderer sending an unknown theme has a bug, and silently dressing the
     * session in dark would hide it.
     */
    ...(raw.theme === undefined
      ? {}
      : { theme: assertOneOf(raw.theme, SESSION_THEMES, 'spawn.theme') }),
    /**
     * A flag, so the only thing to check is that it is one (HIVE-88). It
     * decides which of two flags a uuid main already holds is placed behind,
     * and never puts a renderer-supplied value on the command line.
     */
    ...(raw.resume === undefined
      ? {}
      : { resume: assertBoolean(raw.resume, 'spawn.resume') }),
  };
}

/**
 * A session's display name, on its way to a command line (HIVE-78).
 *
 * See {@link SESSION_NAME_PATTERN} for what the vocabulary excludes and why it
 * is narrower than the names Claude Code itself accepts.
 */
export function assertSessionName(value: unknown, label: string): string {
  const name = assertString(value, label);
  if (!isSendableSessionName(name)) {
    return fail(`${label}: expected a name like HIVE-73 (max ${SESSION_NAME_MAX})`);
  }
  return name;
}

/**
 * The renderer naming the ticket a session is being worked for (HIVE-87).
 *
 * `entityId` takes {@link assertId} rather than `assertText`: it is a lookup key
 * into the ledger's map, not a string to render, and the same argument that
 * bounds a session id applies — a key with separators or control characters in
 * it is a lookup that can be made to mean something other than it looks like.
 *
 * `ticket` takes `assertText`, which is the guard for a value that will be
 * stored and shown. It is deliberately **not** checked against an issue-key
 * pattern here: the renderer has already asked Jira whether the key names a
 * real issue, which is a far stronger check than any regex, and a second weaker
 * one in this file would only invite someone to trust it instead.
 */
export function parseSessionNoteRequest(input: unknown): SessionNoteRequest {
  const raw = assertShape(input, ['entityId', 'ticket'], 'sessionNote');
  return {
    entityId: assertId(raw.entityId, 'sessionNote.entityId'),
    ticket: assertText(raw.ticket, 'sessionNote.ticket'),
  };
}

export function parseWriteRequest(input: unknown): WriteRequest {
  const raw = assertShape(input, ['sessionId', 'data'], 'write');
  return {
    sessionId: assertId(raw.sessionId, 'write.sessionId'),
    // `data` is arbitrary keystrokes — control characters included. It is NOT
    // pattern-checked; it is only ever written to a pty's stdin, never
    // interpreted here.
    data: assertString(raw.data, 'write.data'),
  };
}

export function parseResizeRequest(input: unknown): ResizeRequest {
  const raw = assertShape(input, ['sessionId', 'cols', 'rows'], 'resize');
  return {
    sessionId: assertId(raw.sessionId, 'resize.sessionId'),
    cols: assertDimension(raw.cols, 'resize.cols'),
    rows: assertDimension(raw.rows, 'resize.rows'),
  };
}

export function parseKillRequest(input: unknown): string {
  return assertId(input, 'kill.sessionId');
}

/**
 * A sequence number: a non-negative integer, bounded (story 093).
 *
 * Bounded because it is used to release accounted-for bytes from a
 * backpressure window. A renderer that acked `Number.MAX_SAFE_INTEGER` would
 * clear the window in one message and disable flow control entirely — which is
 * exactly the sort of thing a guard on this boundary exists to refuse.
 */
function assertSeq(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fail(`${label}: expected an integer, got ${describe(value)}`);
  }
  if (value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return fail(`${label}: out of range`);
  }
  return value;
}

export function parseAckRequest(input: unknown): AckRequest {
  const raw = assertShape(input, ['sessionId', 'seq'], 'ack');
  return {
    sessionId: assertId(raw.sessionId, 'ack.sessionId'),
    seq: assertSeq(raw.seq, 'ack.seq'),
  };
}

/**
 * A filesystem path arriving from the renderer (story 101).
 *
 * **Shape only.** Whether the path is absolute, exists, or is a directory is
 * main's job and is re-checked there from scratch by `resolveProject` — this
 * guard's contract is that what reaches `addProject` is a non-empty string,
 * not that it is safe. Validating a path here as well would be two validators,
 * which is one validator and one bug.
 *
 * Deliberately not bounded like `assertId`: a legitimate path on a deeply
 * nested filesystem is long, and the length limit that protects a lookup key
 * reaching process control buys nothing for a string that is about to be
 * `realpath`'d and rejected if it does not resolve.
 */
function assertPath(value: unknown, label: string): string {
  const path = assertString(value, label);
  if (path.trim() === '') return fail(`${label}: expected a non-empty string`);
  return path;
}

export function parseAddProjectRequest(input: unknown): AddProjectRequest {
  const raw = assertShape(input, ['path'], 'addProject', ['name']);
  /**
   * `name` is a **display string**, not a path: it is rendered, never resolved.
   * `assertText` is the guard for that — bounded and control-character free —
   * where `assertPath` is deliberately unbounded and permissive, which is right
   * for something about to be `realpath`'d and wrong for something about to be
   * persisted and shown.
   */
  const name =
    raw.name === undefined ? undefined : assertText(raw.name, 'addProject.name');

  // Conditional spread for the same reason `parseSpawnRequest` uses it: an
  // `undefined`-valued own key would be written to the config file and then
  // reported as unknown the next time it is read.
  return {
    path: assertPath(raw.path, 'addProject.path'),
    ...(name !== undefined ? { name } : {}),
  };
}

export function parseRemoveProjectRequest(input: unknown): RemoveProjectRequest {
  const raw = assertShape(input, ['id'], 'removeProject');
  return { id: assertId(raw.id, 'removeProject.id') };
}

/**
 * Payload guard for `config:rename-project` (story 103).
 *
 * `name` gets `assertText` for the same reason `addProject.name` does: it is a
 * **display string**, rendered and never resolved, so it is bounded and
 * control-character free where `assertPath` is deliberately neither.
 */
export function parseRenameProjectRequest(input: unknown): RenameProjectRequest {
  const raw = assertShape(input, ['id', 'name'], 'renameProject');
  const name = assertText(raw.name, 'renameProject.name');
  /*
    Trimmed here, not at the call site. `assertText` rejects an empty string but
    not a whitespace-only one, and a project called "   " is indistinguishable
    from an unnamed one on screen. Doing it at the boundary means main and the
    renderer cannot disagree about what counts as blank.
  */
  const trimmed = name.trim();
  if (trimmed === '') return fail('renameProject.name: must not be empty');
  return { id: assertId(raw.id, 'renameProject.id'), name: trimmed };
}

/**
 * `config:set-project-key` (HIVE-94).
 *
 * Shape only. **Uniqueness is not checked here** and could not be: this guard
 * sees one payload, and whether a key is taken is a fact about the file main is
 * about to write — which the renderer's snapshot may already be behind. That
 * check belongs inside the write's mutation, where it can refuse against the
 * bytes on disk, exactly as `addProject` checks a duplicate path.
 */
export function parseSetProjectKeyRequest(input: unknown): SetProjectKeyRequest {
  const raw = assertShape(input, ['id', 'key'], 'setProjectKey');
  return {
    id: assertId(raw.id, 'setProjectKey.id'),
    key: assertProjectKey(raw.key, 'setProjectKey.key'),
  };
}

/**
 * Payload guard for `config:repoint-project` (story 103).
 *
 * `path` gets `assertPath`'s permissiveness, matching
 * {@link parseAddProjectRequest}: this proves the *shape*, and main's
 * `resolveProject` proves the *value* — expanded, made absolute, `realpath`'d,
 * confirmed to be a directory. Two validators disagreeing about what a path may
 * contain is how a rule gets quietly relaxed.
 */
export function parseRepointProjectRequest(
  input: unknown,
): RepointProjectRequest {
  const raw = assertShape(input, ['id', 'path'], 'repointProject');
  return {
    id: assertId(raw.id, 'repointProject.id'),
    path: assertPath(raw.path, 'repointProject.path'),
  };
}

/**
 * Payload guard for `config:reorder-projects` (story 103).
 *
 * Duplicates are rejected here rather than in the verb. A list containing one
 * can never be a permutation of the file's ids, and refusing it at the boundary
 * lets the verb's own check stay a plain set comparison.
 */
export function parseReorderProjectsRequest(
  input: unknown,
): ReorderProjectsRequest {
  const raw = assertShape(input, ['ids'], 'reorderProjects');
  if (!Array.isArray(raw.ids)) {
    return fail(
      `reorderProjects.ids: expected an array, got ${describe(raw.ids)}`,
    );
  }
  /*
    Bounded, like every other guard in this file. The legitimate value can
    never exceed the number of projects on disk, and an unbounded array is
    allocated twice in main before anything rejects it — a wedged main process
    takes every terminal with it.
  */
  if (raw.ids.length > MAX_PROJECT_IDS) {
    return fail('reorderProjects.ids: too many ids');
  }
  /*
    `Array.from` first, so array holes become `undefined` and are rejected.
    `.map`, `.every` and `Set` all *skip* holes, which would let a sparse array
    through this guard and put a literal `null` into the config file. A
    `contextBridge` clone happens to densify it today; main's only shape guard
    should not rest on a renderer-side implementation detail.
  */
  const ids = Array.from(raw.ids as unknown[]).map((id, index) =>
    assertId(id, `reorderProjects.ids[${index}]`),
  );
  if (new Set(ids).size !== ids.length) {
    return fail('reorderProjects.ids: duplicate id');
  }
  return { ids };
}

/**
 * Payload guard for `config:clone-start` (story 102).
 *
 * `url` gets `assertPath`'s permissiveness rather than `assertText`'s bounds:
 * it is about to be handed to `parseCloneUrl`, which is the guard that actually
 * decides whether it is a URL. Two validators disagreeing about what a URL may
 * contain is how a rule gets quietly relaxed — this one proves the *shape*, and
 * `parseCloneUrl` proves the *value*.
 *
 * There is no optional key, and in particular no destination: `assertShape`
 * rejects any key not listed, so a renderer that tried to name where the clone
 * should land is refused here before main ever sees it.
 */
export function parseCloneRequest(input: unknown): CloneRequest {
  const raw = assertShape(
    input,
    ['url', 'parentPath', 'cols', 'rows'],
    'startClone',
  );
  return {
    url: assertPath(raw.url, 'startClone.url'),
    parentPath: assertPath(raw.parentPath, 'startClone.parentPath'),
    cols: assertDimension(raw.cols, 'startClone.cols'),
    rows: assertDimension(raw.rows, 'startClone.rows'),
  };
}

/** POSIX-portable environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The most variables one project may declare. */
const MAX_ENV_ENTRIES = 200;

/**
 * An environment map arriving from the renderer.
 *
 * Values go **verbatim into a spawned process's environment**, which is as
 * close to process control as this bridge gets — so every key is checked
 * against a whitelist pattern rather than merely for absence of the obvious
 * villains, and `assertText` bans control characters in the values (a `\n` in
 * an env value is a plausible way to confuse whatever reads it downstream).
 *
 * Empty values are allowed: `FOO=` is a real and meaningful thing to set, so
 * `assertString` is used for values rather than `assertText`'s non-empty rule —
 * with the control-character check applied separately.
 */
function assertEnv(value: unknown, label: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(`${label}: expected an object, got ${describe(value)}`);
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_ENV_ENTRIES) {
    return fail(`${label}: too many variables (max ${MAX_ENV_ENTRIES})`);
  }

  const env: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (FORBIDDEN_KEYS.has(key)) return fail(`${label}: forbidden key "${key}"`);
    if (!ENV_NAME.test(key)) {
      return fail(`${label}: "${key}" is not a valid variable name`);
    }
    /**
     * The refusal list lives in `config-contract.ts` so this boundary and the
     * config-file reader enforce the *same* rule. Two copies would drift, and
     * the copy that drifted would be the one nobody tested.
     */
    const unsafe = unsafeEnvReason(key);
    if (unsafe !== null) return fail(`${label}: ${unsafe}`);

    const text = assertString(raw, `${label}.${key}`);
    if (text.length > MAX_TEXT) return fail(`${label}.${key}: too long`);
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
        return fail(`${label}.${key}: control characters are not allowed`);
      }
    }
    env[key] = text;
  }
  return env;
}

/**
 * Top-level runtime settings (story 104, extended by 108 for `env`).
 *
 * All three keys are optional so one can be saved without restating the
 * others, but at least one must be present — an empty request is a bug at the
 * call site, not a no-op worth writing the file for. `shell` and
 * `claudeCommand` may not be cleared: there is no lower level to fall back to.
 * `env` has no `null` case either — absent already means "leave it alone" —
 * but `{}` is accepted and meaningful, since it is the whole map replacing
 * what is stored.
 */
export function parseSetRuntimeRequest(input: unknown): SetRuntimeRequest {
  const raw = assertShape(input, [], 'setRuntime', [
    'shell',
    'claudeCommand',
    'env',
    'importLoginEnv',
  ]);
  if (
    raw.shell === undefined &&
    raw.claudeCommand === undefined &&
    raw.env === undefined &&
    raw.importLoginEnv === undefined
  ) {
    return fail('setRuntime: nothing to change');
  }

  return {
    ...(raw.shell !== undefined
      ? { shell: assertText(raw.shell, 'setRuntime.shell') }
      : {}),
    ...(raw.claudeCommand !== undefined
      ? {
          claudeCommand: assertText(
            raw.claudeCommand,
            'setRuntime.claudeCommand',
          ),
        }
      : {}),
    // Reuses the project layer's `assertEnv` verbatim — the refusal list is
    // deliberately shared between this boundary and the config-file reader, so
    // a hand-edited LD_PRELOAD and one posted over the bridge are refused by
    // the same code. A second validator would drift, and the drifted copy is
    // the one nobody tests.
    ...(raw.env !== undefined ? { env: assertEnv(raw.env, 'setRuntime.env') } : {}),
    ...(raw.importLoginEnv !== undefined
      ? {
          importLoginEnv: assertBoolean(
            raw.importLoginEnv,
            'setRuntime.importLoginEnv',
          ),
        }
      : {}),
  };
}

/**
 * Notification preferences (story 106).
 *
 * The smallest payload on the bridge, and still hand-guarded rather than cast:
 * story 082's rules are not waived because a shape looks harmless. The one that
 * earns its keep here is the refusal to coerce — `'false'` is a truthy string,
 * so a guard that accepted it would turn switching a class *off* into switching
 * it on.
 */
export function parseSetNotificationsRequest(
  input: unknown,
): SetNotificationsRequest {
  const raw = assertShape(input, [], 'setNotifications', [
    ...NOTIFICATION_KEYS,
  ]);

  const request: SetNotificationsRequest = {};
  for (const key of NOTIFICATION_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    /**
     * A delivery, not a boolean (HIVE-75).
     *
     * The old guard's reasoning survives the widening intact: an unparseable
     * value must be *rejected*, never coerced, because coercing would turn
     * switching a kind off into switching it on.
     */
    if (!isNotificationDelivery(value)) {
      return fail(
        `setNotifications.${key}: expected one of ${NOTIFICATION_DELIVERIES.join(', ')}`,
      );
    }
    request[key] = value;
  }

  if (Object.keys(request).length === 0) {
    return fail('setNotifications: nothing to change');
  }

  return request;
}

/**
 * The `notifications:mark-read` payload (HIVE-75).
 *
 * A notification id, or `null` for "all of them". Deliberately a guard rather
 * than a `typeof` check at the call site: `null` is a *meaningful* value here,
 * and coercing anything-that-is-not-a-string to it turns a single dismissal
 * into clearing the whole inbox — the loudest possible outcome from the
 * quietest possible bug.
 */
export function parseMarkReadRequest(input: unknown): string | null {
  if (input === null) return null;
  if (typeof input !== 'string' || input === '') {
    return fail('markRead: expected a notification id, or null for all');
  }
  return input;
}

/**
 * The `notifications:dismiss` payload (HIVE-93).
 *
 * An id and only an id. Unlike {@link parseMarkReadRequest}, `null` is **not**
 * meaningful here and is rejected: there is no "dismiss them all", so accepting
 * `null` could only ever mean a caller lost an argument on the way in — and the
 * quiet outcome of guessing would be an emptied inbox.
 */
export function parseDismissRequest(input: unknown): string {
  if (typeof input !== 'string' || input === '') {
    return fail('dismiss: expected a notification id');
  }
  return input;
}

/**
 * The `notifications:act` payload — a notification's action, handed back by
 * the renderer for main to carry out.
 *
 * **Returns `null` rather than throwing**, which is the opposite of every other
 * guard here, and the reason is what the caller does with the answer. A
 * malformed spawn request is a bug worth surfacing loudly; a malformed action
 * is a *click*, and the worst honest outcome of a click main does not
 * understand is that nothing happens. Throwing would reject the promise in the
 * renderer, where the only available response is to log it.
 *
 * `session` is validated the same way every other entity id is. `url` is
 * checked for shape only — whether it is safe to *open* is
 * `isSafeExternalUrl`'s job at the point of opening, and duplicating that
 * policy here would create two allowlists that can disagree.
 */
export function parseNotificationAction(
  input: unknown,
): NotificationAction | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }

  const { type } = input as { type?: unknown };

  switch (type) {
    case 'none':
    case 'update.download':
    case 'update.install':
      return { type };
    case 'session': {
      const { entityId } = input as { entityId?: unknown };
      return typeof entityId === 'string' && entityId !== ''
        ? { type: 'session', entityId }
        : null;
    }
    case 'url': {
      const { url } = input as { url?: unknown };
      return typeof url === 'string' && url !== '' ? { type: 'url', url } : null;
    }
    default:
      return null;
  }
}

/** RFC-1123 label. No leading or trailing hyphen. */
const HOST_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** The DNS limit. Generous for an Atlassian host, and finite, which is the point. */
const MAX_HOST = 253;

/**
 * The Atlassian host, as a bare hostname (HIVE-67).
 *
 * **The only guard in this file whose output is interpolated into a URL that a
 * credential is attached to.** A host taken from a payload unchecked is the
 * difference between an integration and a credential-exfiltration primitive, so
 * this rejects rather than encodes: no scheme survives, no path, no port, no
 * userinfo, no whitespace.
 *
 * A pasted `https://…/` is stripped rather than refused, because copying the
 * URL out of the browser is what everyone will actually do and refusing it
 * teaches nothing. `http://` is refused outright — silently upgrading it would
 * accept a request the user did not make, and honouring it would downgrade the
 * transport a credential rides on.
 *
 * The result is lower-cased. Hostnames are case-insensitive, and normalising
 * here means two configs cannot differ only by case.
 */
export function assertJiraSite(value: unknown, label: string): string {
  const raw = assertString(value, label).trim();
  if (raw.length === 0) return fail(`${label}: must not be empty`);
  if (/^http:\/\//i.test(raw)) {
    return fail(`${label}: must be https — drop the http:// prefix`);
  }

  const stripped = raw.replace(/^https:\/\//i, '').replace(/\/+$/, '');
  if (stripped.length === 0 || stripped.length > MAX_HOST) {
    return fail(`${label}: expected a hostname`);
  }

  const labels = stripped.split('.');
  if (labels.length < 2) {
    return fail(`${label}: expected a hostname like example.atlassian.net`);
  }
  for (const part of labels) {
    if (!HOST_LABEL.test(part)) {
      return fail(
        `${label}: expected a hostname — no scheme, path, port or credentials`,
      );
    }
  }
  return stripped.toLowerCase();
}

/** The address half of a Basic credential. The RFC-5321 maximum. */
const MAX_EMAIL = 320;

/**
 * The account email (HIVE-67).
 *
 * Deliberately not an RFC-5322 parser — this checks the properties that matter
 * *where the value is used*, and lets Jira be the authority on whether the
 * address exists. A **colon is refused** because this string appears before the
 * separator in `email:token`, and one inside it would silently move the
 * boundary of the credential.
 */
export function assertJiraEmail(value: unknown, label: string): string {
  const email = assertText(value, label);
  if (email.length > MAX_EMAIL) return fail(`${label}: too long`);
  if (email.includes(':')) return fail(`${label}: must not contain a colon`);
  if (/\s/.test(email)) return fail(`${label}: must not contain whitespace`);

  const parts = email.split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return fail(`${label}: expected an address like you@example.com`);
  }
  return email;
}

/** Atlassian tokens are around 192 characters. Generous, and finite. */
const MAX_TOKEN = 1024;

/**
 * The API token (HIVE-67).
 *
 * Printable ASCII with no space, which is what a base64-ish Atlassian token is.
 * The refusal names the field and **never echoes the value** — a guard whose
 * error message contains the secret it rejected has leaked that secret into
 * every log that catches the throw.
 */
export function assertJiraToken(value: unknown, label: string): string {
  const token = assertString(value, label);
  if (token.length === 0) return fail(`${label}: must not be empty`);
  if (token.length > MAX_TOKEN) return fail(`${label}: too long`);
  for (const char of token) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e) {
      return fail(`${label}: expected printable ASCII with no spaces`);
    }
  }
  return token;
}

/**
 * The Jira connection settings (HIVE-67).
 *
 * `null` is accepted and distinct from absent — it clears the field — the same
 * three-state shape {@link parseSetProjectRuntimeRequest} uses and for the same
 * reason. There is no `token` key: the token is a secret and arrives on its own
 * channel, so a guard that accepted one here would be letting a credential into
 * the config write path.
 */
export function parseSetJiraRequest(input: unknown): SetJiraRequest {
  const raw = assertShape(input, [], 'setJira', ['site', 'email', 'jql']);

  const request: SetJiraRequest = {
    ...(raw.site !== undefined
      ? {
          site:
            raw.site === null ? null : assertJiraSite(raw.site, 'setJira.site'),
        }
      : {}),
    ...(raw.email !== undefined
      ? {
          email:
            raw.email === null
              ? null
              : assertJiraEmail(raw.email, 'setJira.email'),
        }
      : {}),
    // HIVE-69. Same bounded, control-character-free treatment the search verb
    // gives a query, and for the same reason: JQL is not parsed here.
    ...(raw.jql !== undefined
      ? { jql: raw.jql === null ? null : assertText(raw.jql, 'setJira.jql') }
      : {}),
  };

  if (Object.keys(request).length === 0) {
    return fail('setJira: nothing to change');
  }
  return request;
}

/** The token, on its way to `safeStorage`. The only payload carrying a secret. */
export function parseSetJiraTokenRequest(input: unknown): SetJiraTokenRequest {
  const raw = assertShape(input, ['token'], 'setJiraToken');
  return { token: assertJiraToken(raw.token, 'setJiraToken.token') };
}

/**
 * A Jira issue key (HIVE-68).
 *
 * The epic's replacement for `gh.ts`'s "argv is a constant", finally applied to
 * something: this value is interpolated into a URL path, so the pattern *is* the
 * defence. A key is an uppercase project prefix, a hyphen, and digits — nothing
 * in that shape can carry a path segment, a query, or a fragment, which is why
 * it is **matched rather than escaped**. Encoding a bad key and sending it
 * anyway is exactly what this refuses to do.
 *
 * The pattern itself lives in `jira-contract.ts` rather than here, because
 * HIVE-78 gave the shape a second reader in main — see
 * {@link ISSUE_KEY_PATTERN}.
 */
export function assertJiraIssueKey(value: unknown, label: string): string {
  const key = assertString(value, label);
  if (!ISSUE_KEY_PATTERN.test(key)) {
    return fail(`${label}: expected an issue key like HIVE-68`);
  }
  return key;
}

/**
 * A JQL query (HIVE-68).
 *
 * Bounded and control-character-free, and that is deliberately all it checks.
 * JQL is not parsed here and never will be: a client-side parser would be a
 * thing to maintain forever and would be wrong more often than Jira is.
 *
 * What makes that safe rather than lazy: the string goes into **one**
 * URL-encoded parameter with no larger query built around it, and it runs under
 * the user's own credential and their own Jira permissions. So the failure mode
 * is a query broader than the user intended — not a query that reaches data the
 * account could not already read.
 */
export function parseJiraSearchRequest(input: unknown): JiraSearchRequest {
  const raw = assertShape(input, [], 'jiraSearch', ['jql']);
  return {
    ...(raw.jql !== undefined
      ? { jql: assertText(raw.jql, 'jiraSearch.jql') }
      : {}),
  };
}

export function parseJiraIssueRequest(input: unknown): JiraIssueRequest {
  const raw = assertShape(input, ['key'], 'jiraIssue');
  return { key: assertJiraIssueKey(raw.key, 'jiraIssue.key') };
}

/**
 * A Jira transition id (HIVE-70).
 *
 * Numeric, and bounded. Jira's own ids are small integers as strings; matching
 * that shape means nothing arriving here can carry a path segment or a JSON
 * fragment into the request body, whatever a caller intended.
 *
 * Validated even though the id was handed to the renderer by a `jira:transitions`
 * read moments earlier: main does not trust that a value it gave out came back
 * unchanged, and this one reaches a body that moves an issue.
 */
const TRANSITION_ID = /^[0-9]{1,10}$/;

export function assertJiraTransitionId(value: unknown, label: string): string {
  const id = assertString(value, label);
  if (!TRANSITION_ID.test(id)) {
    return fail(`${label}: expected a numeric transition id`);
  }
  return id;
}

export function parseJiraTransitionsRequest(
  input: unknown,
): JiraTransitionsRequest {
  const raw = assertShape(input, ['key'], 'jiraTransitions');
  return { key: assertJiraIssueKey(raw.key, 'jiraTransitions.key') };
}

/** Reading an issue's conversation or its links (HIVE-71). */
export function parseJiraConversationRequest(
  input: unknown,
): JiraConversationRequest {
  const raw = assertShape(input, ['key'], 'jiraConversation');
  return { key: assertJiraIssueKey(raw.key, 'jiraConversation.key') };
}

/**
 * A comment, as markdown (HIVE-71).
 *
 * `assertText` bounds it and refuses control characters, which is the right
 * check for a value that becomes a *document* rather than a command: markdown
 * is meant to contain `*`, `#`, backticks and angle brackets, and rejecting
 * those would reject the feature. What it must not contain is a control byte,
 * because the converter would carry it into a text node and Jira would reject
 * the whole document with a message naming nothing.
 *
 * Newlines are the one exception, and they are the point — a comment without
 * paragraphs is not a comment. `assertText` refuses them, so this checks the
 * same properties itself rather than pretending the shared guard fits.
 */
const MAX_COMMENT = 32_768;

export function parseAddJiraCommentRequest(
  input: unknown,
): AddJiraCommentRequest {
  const raw = assertShape(input, ['key', 'markdown'], 'addJiraComment');
  const markdown = assertString(raw.markdown, 'addJiraComment.markdown');

  if (markdown.trim() === '') {
    return fail('addJiraComment.markdown: must not be empty');
  }
  if (markdown.length > MAX_COMMENT) {
    return fail('addJiraComment.markdown: too long');
  }
  for (const char of markdown) {
    const code = char.codePointAt(0) ?? 0;
    // Tab, newline and carriage return are prose; everything else in C0, DEL
    // and C1 is not.
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return fail('addJiraComment.markdown: control characters are not allowed');
    }
  }

  return {
    key: assertJiraIssueKey(raw.key, 'addJiraComment.key'),
    markdown,
  };
}

export function parseApplyJiraTransitionRequest(
  input: unknown,
): ApplyJiraTransitionRequest {
  const raw = assertShape(input, ['key', 'transitionId'], 'applyJiraTransition');
  return {
    key: assertJiraIssueKey(raw.key, 'applyJiraTransition.key'),
    transitionId: assertJiraTransitionId(
      raw.transitionId,
      'applyJiraTransition.transitionId',
    ),
  };
}

/**
 * Per-project runtime overrides (story 104).
 *
 * `null` is accepted and distinct from absent — it removes the override. That
 * is the one place this guard is deliberately more permissive than its
 * siblings, and it is load-bearing: without it the UI could set an override but
 * never take it back, and an emptied field would have to be stored as `""`,
 * which spawns a shell named `""`.
 */
export function parseSetProjectRuntimeRequest(
  input: unknown,
): SetProjectRuntimeRequest {
  const raw = assertShape(input, ['id'], 'setProjectRuntime', [
    'shell',
    'claudeCommand',
    'env',
  ]);

  const optionalText = (value: unknown, label: string): string | null =>
    value === null ? null : assertText(value, label);

  return {
    id: assertId(raw.id, 'setProjectRuntime.id'),
    ...(raw.shell !== undefined
      ? { shell: optionalText(raw.shell, 'setProjectRuntime.shell') }
      : {}),
    ...(raw.claudeCommand !== undefined
      ? {
          claudeCommand: optionalText(
            raw.claudeCommand,
            'setProjectRuntime.claudeCommand',
          ),
        }
      : {}),
    ...(raw.env !== undefined
      ? {
          env:
            raw.env === null
              ? null
              : assertEnv(raw.env, 'setProjectRuntime.env'),
        }
      : {}),
  };
}

/** Which command to explain. An absent id means the top-level command. */
export function parseDiagnoseCommandRequest(
  input: unknown,
): DiagnoseCommandRequest {
  const raw = assertShape(input, [], 'diagnoseCommand', ['id']);
  return {
    ...(raw.id !== undefined
      ? { id: assertId(raw.id, 'diagnoseCommand.id') }
      : {}),
  };
}

/**
 * A project-relative path, as the fs verbs accept one.
 *
 * **The highest-value guard in this file.** Every other path in the contract is
 * chosen by the user through a native dialog or written into a file main owns;
 * this one is composed by the renderer, once per click, out of a tree it built
 * from replies it was given.
 *
 * What it rejects, and why each is its own case rather than one clever regex:
 *
 * - **Absolute paths**, POSIX and Windows-drive alike. A guard that only looked
 *   for `..` would pass `/etc/passwd` straight into a `join` that discards the
 *   root it was handed.
 * - **Any `..` segment**, tested per segment rather than as a substring — so a
 *   real file named `..hidden` is allowed and `a/../../b` is not.
 * - **NUL**, which truncates a path inside libuv and makes the string this
 *   guard inspected differ from the one the syscall receives.
 * - **Control characters**, on the argument `assertText` already makes: this
 *   value is about to be rendered in a tab strip and an error message.
 *
 * It does **not** reject a path that escapes by symlink, because it cannot: a
 * symlink is a fact about the disk, not about the string. That check lives in
 * `electron/main/fs/paths.ts`, after `realpath`, and this guard is explicitly
 * not a substitute for it. Both are required — this one catches what `realpath`
 * cannot (a `..` on a path that does not exist yet, which is the write case),
 * and `realpath` catches what this cannot.
 *
 * `''` is valid and means the project root, which is what the tree asks for
 * first.
 */
const MAX_REL_PATH = 1024;

export function assertRelPath(value: unknown, label: string): string {
  const path = assertString(value, label);
  if (path.length > MAX_REL_PATH) return fail(`${label}: too long`);

  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return fail(`${label}: control characters are not allowed`);
    }
  }

  if (path.startsWith('/') || path.startsWith('\\')) {
    return fail(`${label}: must be relative to the project`);
  }
  if (/^[A-Za-z]:/.test(path)) {
    return fail(`${label}: must be relative to the project`);
  }

  for (const segment of path.split(/[/\\]/)) {
    if (segment === '..') return fail(`${label}: must not leave the project`);
  }

  return path;
}

export function parseReadDirRequest(input: unknown): ReadDirRequest {
  const raw = assertShape(input, ['projectId', 'relPath'], 'readDir');
  return {
    projectId: assertId(raw.projectId, 'readDir.projectId'),
    relPath: assertRelPath(raw.relPath, 'readDir.relPath'),
  };
}

export function parseReadFileRequest(input: unknown): ReadFileRequest {
  const raw = assertShape(input, ['projectId', 'relPath'], 'readFile');
  return {
    projectId: assertId(raw.projectId, 'readFile.projectId'),
    relPath: assertRelPath(raw.relPath, 'readFile.relPath'),
  };
}

/**
 * `fs:write-file` — the only verb in this contract that changes a file the user
 * did not name through a dialog.
 *
 * `text` gets neither `assertText` nor a control-character sweep, and that is a
 * decision rather than an omission. Source files legitimately contain tabs,
 * newlines, form feeds and — in a fixture, or a test for terminal escapes —
 * every byte below 0x20. What makes this safe is *where* the bytes land, not
 * what they are: a bounded size, a contained path, and an mtime that has not
 * moved. Rejecting a newline here would leave the editor unable to save the
 * file it had just opened.
 */
export function parseWriteFileRequest(input: unknown): WriteFileRequest {
  const raw = assertShape(
    input,
    ['projectId', 'relPath', 'text', 'baseMtimeMs'],
    'writeFile',
  );

  const text = assertString(raw.text, 'writeFile.text');
  /**
   * Bytes, not UTF-16 units — and in two steps.
   *
   * `read.ts` caps on the file's size in bytes, so measuring `.length` alone
   * let non-ASCII content through at up to three times the limit, and the
   * editor would then refuse to reopen the file it had just written. Both ends
   * of the round trip have to count the same thing.
   *
   * The cheap check runs first because UTF-8 never encodes a string in fewer
   * bytes than it has UTF-16 units — so a string longer than the cap is over it
   * whatever its content, and rejecting there bounds what the exact count is
   * asked to allocate.
   *
   * `TextEncoder`, not `Buffer`: this module is the one both processes may
   * import, and a Node global here would break that (`AGENTS.md` → import
   * zones), however main-only its callers happen to be today.
   */
  if (text.length > MAX_FILE_BYTES) return fail('writeFile.text: too large');
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) {
    return fail('writeFile.text: too large');
  }

  const { baseMtimeMs } = raw;
  if (typeof baseMtimeMs !== 'number' || !Number.isFinite(baseMtimeMs)) {
    return fail('writeFile.baseMtimeMs: expected a finite number');
  }

  return {
    projectId: assertId(raw.projectId, 'writeFile.projectId'),
    relPath: assertRelPath(raw.relPath, 'writeFile.relPath'),
    text,
    baseMtimeMs,
  };
}

export function parseWatchRequest(input: unknown): WatchRequest {
  const raw = assertShape(input, ['projectId'], 'watch');
  return { projectId: assertId(raw.projectId, 'watch.projectId') };
}

/**
 * A skill name — which is also a folder name and a slash command (HIVE-96).
 *
 * Deliberately narrower than {@link assertId} and much narrower than
 * {@link assertRelPath}. Those two admit a value the caller will *resolve*;
 * this one admits a value main will `join` onto a directory it owns, so the
 * job here is to make a path unrepresentable rather than to sanitise one.
 * Nothing downstream re-checks containment, and nothing downstream needs to.
 *
 * {@link RESERVED_SKILL_NAME} is refused here as well as in the reader because
 * the reservation is part of the contract, not an implementation detail of the
 * filesystem layer: the built-in must not be shadowed, whichever way in.
 */
export function assertSkillName(value: unknown, label: string): string {
  const name = assertString(value, label);

  if (!SKILL_NAME_PATTERN.test(name)) {
    return fail(`${label}: must be lowercase letters, digits and dashes`);
  }
  if (name === RESERVED_SKILL_NAME) {
    return fail(`${label}: "${RESERVED_SKILL_NAME}" is reserved`);
  }
  return name;
}

export function parseSkillNameRequest(input: unknown): SkillNameRequest {
  const raw = assertShape(input, ['name'], 'skillName');
  return { name: assertSkillName(raw.name, 'skillName.name') };
}

/**
 * `skills:write` — the file the user typed, under a name this guard validated.
 *
 * `body` gets neither a length cap nor a control-character sweep, and that is a
 * decision rather than an omission — the same one {@link parseWriteFileRequest}
 * documents. A SKILL.md legitimately contains tabs and newlines, and what makes
 * this safe is *where* the bytes land: a directory main chose, under a name
 * that cannot name anywhere else.
 */
export function parseSkillWriteRequest(input: unknown): SkillWriteRequest {
  const raw = assertShape(input, ['name', 'body'], 'skillWrite');
  return {
    name: assertSkillName(raw.name, 'skillWrite.name'),
    body: assertString(raw.body, 'skillWrite.body'),
  };
}

/**
 * Which project's environment to diagnose (story 108). An absent id means the
 * top-level env.
 *
 * A separate guard from {@link parseDiagnoseCommandRequest} rather than a
 * shared one, even though the shape is identical — its error messages are
 * labelled `diagnoseEnv.*`, so a rejected payload names the channel that
 * actually rejected it rather than the unrelated one next to it.
 */
export function parseDiagnoseEnvRequest(input: unknown): DiagnoseEnvRequest {
  const raw = assertShape(input, [], 'diagnoseEnv', ['id']);
  return {
    ...(raw.id !== undefined ? { id: assertId(raw.id, 'diagnoseEnv.id') } : {}),
  };
}

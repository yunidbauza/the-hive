import type {
  AddProjectRequest,
  CloneRequest,
  DiagnoseCommandRequest,
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
  SetProjectRuntimeRequest,
  SetRuntimeRequest,
} from './config-contract';
import { NOTIFICATION_KEYS, unsafeEnvReason } from './config-contract';
import type {
  AckRequest,
  ResizeRequest,
  SpawnRequest,
  WriteRequest,
} from './ipc-contract';
import { SESSION_EFFORTS, SESSION_MODELS } from './session-contract';

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
    ['task', 'model', 'effort'],
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
 * Top-level runtime settings (story 104).
 *
 * Both keys are optional so one can be saved without restating the other, but
 * at least one must be present — an empty request is a bug at the call site,
 * not a no-op worth writing the file for. Neither may be cleared: there is no
 * lower level to fall back to.
 */
export function parseSetRuntimeRequest(input: unknown): SetRuntimeRequest {
  const raw = assertShape(input, [], 'setRuntime', ['shell', 'claudeCommand']);
  if (raw.shell === undefined && raw.claudeCommand === undefined) {
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
    if (typeof value !== 'boolean') {
      return fail(`setNotifications.${key}: expected a boolean`);
    }
    request[key] = value;
  }

  if (Object.keys(request).length === 0) {
    return fail('setNotifications: nothing to change');
  }

  return request;
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
 */
const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

export function assertJiraIssueKey(value: unknown, label: string): string {
  const key = assertString(value, label);
  if (!ISSUE_KEY.test(key)) {
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

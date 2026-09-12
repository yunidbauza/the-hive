import {
  AGENT_NAME_PATTERN,
  isReservedAgentName,
} from './agent-contract';
import type {
  AgentNameRequest,
  AgentRenameRequest,
  AgentRunRequest,
  AgentWriteRequest,
} from './agent-contract';
import {
  NOTIFICATION_KEYS,
  PROJECT_KEY_HINT,
  isAbsoluteContainerPath,
  isContainerFreshness,
  isContainerProbe,
  isEnvArgTemplate,
  isHostAlias,
  isOrigin,
  isProjectKey,
  isServerBindHost,
  unsafeEnvReason,
  SESSION_PLUGIN_NAME,
} from './config-contract';
import type {
  AddProjectRequest,
  BrowseDirRequest,
  CloneRequest,
  ContainerConfig,
  DeviceNameRequest,
  DiagnoseCommandRequest,
  DiagnoseEnvRequest,
  ReceiverBindConfig,
  RemoteMode,
  RemotePairRequest,
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
  ServerBindConfig,
  SetJiraRequest,
  SetJiraTokenRequest,
  SetNotificationsRequest,
  SetSessionPluginRequest,
  SetProjectAutoMergeRequest,
  SetProjectKeyRequest,
  SetProjectRuntimeRequest,
  SetReceiverRequest,
  SetRemoteRequest,
  SetRuntimeRequest,
  SetServerRequest,
  SetSlackRequest,
  SetSlackTokensRequest,
} from './config-contract';
import type {
  ReadDirRequest,
  ReadFileRequest,
  RootRequest,
  SearchRequest,
  WatchRequest,
  WriteFileRequest,
} from './fs-contract';
import { MAX_FILE_BYTES } from './fs-contract';
import type { PrLookup } from './github-contract';
import type {
  AckRequest,
  PromptReport,
  ResizeRequest,
  SpawnRequest,
  SpawnTerminalRequest,
  WriteRequest,
} from './ipc-contract';
import { ISSUE_KEY_PATTERN, type JiraTransitionByName } from './jira-contract';
import {
  LEDGER_KINDS,
  type LedgerAnswerRequest,
  type LedgerKind,
  type LedgerPostRequest,
  type LedgerReadQuery,
} from './ledger-contract';
import type { NotificationAction } from './notification-contract';
import {
  NOTIFICATION_DELIVERIES,
  isNotificationDelivery,
} from './notification-contract';
import {
  SESSION_EFFORTS,
  SESSION_MODELS,
  SESSION_NAME_DISPLAY_MAX,
  SESSION_NAME_MAX,
  isSendableSessionName,
} from './session-contract';
import type {
  SessionNoteRequest,
  SessionPrRequest,
} from './session-history-contract';
import {
  MAX_BUNDLE_DEPTH,
  MAX_BUNDLE_FILES,
  RESERVED_SKILL_NAME,
  SKILL_NAME_PATTERN,
} from './skills-contract';
import type {
  SkillDropRequest,
  SkillFileWriteRequest,
  SkillImportRequest,
  SkillMoveRequest,
  SkillNameRequest,
  SkillPathRequest,
  SkillRenameRequest,
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

/**
 * Exported (HIVE-142 review, M1) so `cli.ts`'s `--pair`/`--revoke` argv
 * parsing can hold a device name to the exact same bound this file's own
 * IPC guards do (`parsePairDeviceRequest`, `parseRevokeDeviceRequest`) —
 * non-empty, capped, no control characters — rather than accepting anything
 * argv hands it and minting a device the config reader silently drops on
 * the next load because its name is empty or unprintable.
 */
export function assertText(value: unknown, label: string): string {
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
    ['task', 'model', 'effort', 'name', 'resume'],
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
     * A flag, so the only thing to check is that it is one (HIVE-88). It
     * decides which of two flags a uuid main already holds is placed behind,
     * and never puts a renderer-supplied value on the command line.
     */
    ...(raw.resume === undefined
      ? {}
      : { resume: assertBoolean(raw.resume, 'spawn.resume') }),
  };
}

export function parseSpawnTerminalRequest(input: unknown): SpawnTerminalRequest {
  const raw = assertShape(
    input,
    ['sessionId', 'projectId', 'cols', 'rows'],
    'spawn-terminal',
    ['cwd'],
  );
  return {
    sessionId: assertId(raw.sessionId, 'spawn-terminal.sessionId'),
    projectId: assertId(raw.projectId, 'spawn-terminal.projectId'),
    cols: assertDimension(raw.cols, 'spawn-terminal.cols'),
    rows: assertDimension(raw.rows, 'spawn-terminal.rows'),
    /**
     * Spread rather than `cwd: undefined`: this module's own tests compare the
     * returned object key-for-key. Absolute first, then the same length cap
     * and control-character ban as any text — the pair the container paths
     * use, for the same reason: this string becomes a process's cwd.
     */
    ...(raw.cwd === undefined
      ? {}
      : { cwd: assertAbsolutePath(raw.cwd, 'spawn-terminal.cwd') }),
  };
}

/** An absolute POSIX path with `assertText`'s bounds on top. */
function assertAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    return fail(`${label}: must be an absolute path`);
  }
  return assertText(value, label);
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
 * into the session history's map, not a string to render, and the same argument that
 * bounds a session id applies — a key with separators or control characters in
 * it is a lookup that can be made to mean something other than it looks like.
 *
 * `ticket` takes `assertText`, which is the guard for a value that will be
 * stored and shown. It is deliberately **not** checked against an issue-key
 * pattern here: the renderer has already asked Jira whether the key names a
 * real issue, which is a far stronger check than any regex, and a second weaker
 * one in this file would only invite someone to trust it instead.
 *
 * `name` is optional and takes `assertText` too, bounded by the display cap
 * rather than by {@link SESSION_NAME_PATTERN} (HIVE-107). The pattern governs
 * what may go on a **command line**; this value is stored and rendered and
 * never sent, so applying it here would reject the de-duplicated `HIVE-73-2`'s
 * more exotic cousins for a risk this path does not carry. The cap is the one
 * `readTitle` already applies to the other source of names, for the same
 * reason: a rail 130px wide, not memory.
 */
export function parseSessionNoteRequest(input: unknown): SessionNoteRequest {
  const raw = assertShape(input, ['entityId', 'ticket'], 'sessionNote', ['name']);
  const name = raw.name === undefined ? undefined : assertText(raw.name, 'sessionNote.name');
  if (name !== undefined && name.length > SESSION_NAME_DISPLAY_MAX) {
    return fail(`sessionNote.name: too long`);
  }
  return {
    entityId: assertId(raw.entityId, 'sessionNote.entityId'),
    ticket: assertText(raw.ticket, 'sessionNote.ticket'),
    ...(name === undefined ? {} : { name }),
  };
}

/**
 * A pull request number: a positive integer, bounded.
 *
 * Bounded for {@link assertSeq}'s reason turned around — nothing downstream
 * spends this, but it is rendered into a `#123` and into an accessible label,
 * and a payload of `1e308` would produce a cell the table cannot lay out. The
 * ceiling is deliberately generous; no repository is near it.
 */
function assertPrNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fail(`${label}: expected an integer, got ${describe(value)}`);
  }
  if (value < 1 || value > 10_000_000) return fail(`${label}: out of range`);
  return value;
}

/**
 * The URL a remembered pull request opens.
 *
 * Checked as an **absolute https URL** rather than as free text, because this
 * is the one field here that becomes an `href`. `assertText` would let
 * `javascript:…` through, and a value the renderer read back out of its own
 * session history and put on a link is exactly the shape of a stored-XSS carrier. The
 * scheme is the whole check: the host is GitHub's business, not this guard's,
 * and pinning it here would break the moment somebody points the app at an
 * enterprise instance.
 */
function assertHttpsUrl(value: unknown, label: string): string {
  const text = assertText(value, label);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail(`${label}: not a URL`);
  }
  if (url.protocol !== 'https:') return fail(`${label}: must be https`);
  return text;
}

/**
 * The renderer telling main which pull request a session produced.
 *
 * `repo` takes {@link assertText} rather than a pattern: it is GitHub's own
 * repository name as the sweep reported it, it is only ever compared and
 * rendered, and it never reaches a path or a command line.
 */
export function parseSessionPrRequest(input: unknown): SessionPrRequest {
  const raw = assertShape(input, ['entityId', 'pr'], 'sessionPr');
  const pr = assertShape(raw.pr, ['number', 'repo', 'url'], 'sessionPr.pr');

  return {
    entityId: assertId(raw.entityId, 'sessionPr.entityId'),
    pr: {
      number: assertPrNumber(pr.number, 'sessionPr.pr.number'),
      repo: assertText(pr.repo, 'sessionPr.pr.repo'),
      url: assertHttpsUrl(pr.url, 'sessionPr.pr.url'),
    },
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

const PROMPT_INPUTS: readonly string[] = ['empty', 'draft', 'unfocused'];

/**
 * The input-box report (HIVE-135). `input` is a closed set: this value is what
 * lets main write into a terminal, so an unknown word is refused rather than
 * read as either answer.
 */
export function parsePromptReport(input: unknown): PromptReport {
  const raw = assertShape(input, ['sessionId', 'input'], 'prompt');
  const state = raw.input;
  if (typeof state !== 'string' || !PROMPT_INPUTS.includes(state)) {
    return fail(`prompt.input: expected one of ${PROMPT_INPUTS.join(', ')}, got ${describe(state)}`);
  }
  return {
    sessionId: assertId(raw.sessionId, 'prompt.sessionId'),
    input: state as PromptReport['input'],
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

/**
 * Longer than any real path — macOS caps a component at 255 bytes and a full
 * path at 1024 — and short enough that nothing pathological gets as far as a
 * syscall.
 */
const MAX_BROWSE_PATH = 4096;

/**
 * Payload guard for `config:browse-directory` (HIVE-146).
 *
 * The path is **not** trusted here, and is not meant to be. It goes on to
 * `browseHomeDirectory`, which resolves it, `realpath`s it and proves
 * containment against the answering machine's home directory. What this bounds
 * is shape and size, so a malformed or enormous payload is refused before it
 * becomes syscalls.
 *
 * `assertPath` is deliberately not reused: it rejects an empty string, and an
 * empty string is this verb's way of asking for home. That is the difference
 * between "the caller named nowhere", which is an error for `addProject`, and
 * "the caller named the default", which is the ordinary first call here.
 */
export function parseBrowseDirRequest(input: unknown): BrowseDirRequest {
  const raw = assertShape(input, ['path'], 'browseDirectory');
  const path = assertString(raw.path, 'browseDirectory.path');
  if (path.length > MAX_BROWSE_PATH) {
    return fail(`browseDirectory.path: too long`);
  }
  /*
    Control characters are refused here rather than left to the syscall.

    A NUL makes Node throw `ERR_INVALID_ARG_VALUE`, which `asFailure` flattens
    to `EUNKNOWN` — a correct refusal wearing a useless code. A newline is
    worse: it reaches the filesystem layer intact and any log line built around
    the path afterwards carries a forged second line. Neither is a containment
    hole, and neither should get as far as a syscall to be one.
  */
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    return fail('browseDirectory.path: contains a control character');
  }
  return { path };
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
 * Payload guard for `config:set-session-plugin` (HIVE-176). A name in the
 * registry's own alphabet, and never `hive`: the app's own plugin arrives by
 * `--plugin-dir` and is not the user's to switch off here.
 */
export function parseSetSessionPluginRequest(input: unknown): SetSessionPluginRequest {
  const raw = assertShape(input, ['plugin', 'off'], 'setSessionPlugin');
  if (typeof raw.plugin !== 'string' || !SESSION_PLUGIN_NAME.test(raw.plugin) || raw.plugin === 'hive') {
    throw new TypeError('setSessionPlugin.plugin: expected a plugin name');
  }
  if (typeof raw.off !== 'boolean') {
    throw new TypeError('setSessionPlugin.off must be a boolean');
  }
  return { plugin: raw.plugin, off: raw.off };
}

/** Payload guard for `config:set-project-auto-merge` (HIVE-166). */
export function parseSetProjectAutoMergeRequest(input: unknown): SetProjectAutoMergeRequest {
  const raw = assertShape(input, ['id', 'autoMerge'], 'setProjectAutoMerge');
  if (typeof raw.autoMerge !== 'boolean') {
    throw new TypeError('setProjectAutoMerge.autoMerge must be a boolean');
  }
  return {
    id: assertId(raw.id, 'setProjectAutoMerge.id'),
    autoMerge: raw.autoMerge,
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
 * HIVE-133's container block, over the bridge.
 *
 * The rules are `config/parse.ts`'s, deliberately: a value the settings pane
 * stores must be a value the file reader accepts on the next load, or the UI
 * saves something that silently disappears. `isHostAlias` is already shared for
 * that reason; this extends the same discipline to the rest of the block.
 *
 * Unlike the reader, this **throws** rather than reporting and dropping. A
 * hand-edited file is salvaged field by field because the user is mid-edit; an
 * IPC payload is either what the pane built or something that has no business
 * being written.
 */
export function assertContainer(value: unknown, label: string): ContainerConfig {
  const raw = assertShape(value, ['workspace', 'hiveDir'], label, [
    'envArg',
    'probe',
    'freshness',
    'hostAlias',
  ]);

  /*
    `isAbsoluteContainerPath` first — the same rule `parse.ts` applies, so a
    value this guard accepts is a value the file reader accepts too. Then
    `assertText`, matching how `probe` below is handled and for the same
    reason (final-review fix): `isAbsoluteContainerPath` only checks for a
    leading `/` on a non-empty string, so on its own it left `workspace` and
    `hiveDir` the one pair of strings on this bridge with no length cap and no
    ban on control characters — both of which end up on a spawned command
    line via `sessionCommand`'s `PathMap`. `assertText` adds both without
    touching the leading-`/` guarantee `isAbsoluteContainerPath` already gave.
  */
  const absolute = (key: 'workspace' | 'hiveDir'): string => {
    if (!isAbsoluteContainerPath(raw[key])) {
      throw new IpcValidationError(`${label}.${key} must be an absolute path`);
    }
    return assertText(raw[key], `${label}.${key}`);
  };

  const workspace = absolute('workspace');
  const hiveDir = absolute('hiveDir');

  /*
    `isEnvArgTemplate` first, then `assertText` — the same pairing `workspace`,
    `hiveDir` and `probe` use, and for a sharper version of the same reason.
    The shape check only asks that both placeholders are present, so alone it
    accepts an unbounded template and one carrying control characters. Unlike a
    *value*, a template's own text is emitted **verbatim** by `expandEnvArgs`,
    never quoted, because it is the runtime's vocabulary rather than user data
    — so whatever survives this check is typed into a pty exactly as written.
  */
  if (raw.envArg !== undefined && !isEnvArgTemplate(raw.envArg)) {
    throw new IpcValidationError(`${label}.envArg must contain {name} and {value}`);
  }
  /*
    `isContainerProbe` first — the same rule `parse.ts` applies, so a value
    this guard accepts is a value the file reader accepts too. `assertText`
    runs *as well as*, not instead of: it adds a length cap and a
    control-character ban that the reader does not enforce. That makes this
    guard strictly stricter than the reader on those two axes, which is the
    safe direction to differ in — the pane can refuse something a hand-edited
    file would tolerate, but nothing a hand-edited file accepts is silently
    dropped by the pane's read. Do not "fix" this back into symmetry by
    dropping `assertText`.
  */
  if (raw.probe !== undefined && !isContainerProbe(raw.probe)) {
    throw new IpcValidationError(`${label}.probe expected a non-empty string`);
  }
  if (raw.freshness !== undefined && !isContainerFreshness(raw.freshness)) {
    throw new IpcValidationError(`${label}.freshness must be "exec-env" or "rewrite"`);
  }
  if (raw.hostAlias !== undefined && !isHostAlias(raw.hostAlias)) {
    throw new IpcValidationError(`${label}.hostAlias is not a valid hostname`);
  }

  /*
    Validated, never defaulted — the file shape in, the file shape out. An
    absent field is how the pane says "inherit", and materialising a default
    here would freeze today's value into the user's config file forever. That
    is the same argument `setNotifications` makes for writing only the classes
    the request names.
  */
  return {
    workspace,
    hiveDir,
    ...(raw.envArg === undefined ? {} : { envArg: assertText(raw.envArg, `${label}.envArg`) }),
    ...(raw.probe === undefined ? {} : { probe: assertText(raw.probe, `${label}.probe`) }),
    ...(raw.freshness === undefined
      ? {}
      : { freshness: raw.freshness as ContainerConfig['freshness'] }),
    ...(raw.hostAlias === undefined ? {} : { hostAlias: raw.hostAlias as string }),
  };
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
    case 'ask': {
      const { thread } = input as { thread?: unknown };
      return typeof thread === 'string' && thread !== ''
        ? { type: 'ask', thread }
        : null;
    }
    case 'agent': {
      const { name } = input as { name?: unknown };
      return typeof name === 'string' && name !== ''
        ? { type: 'agent', name }
        : null;
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

/**
 * A container host alias.
 *
 * The rule itself is {@link isHostAlias}, in `config-contract.ts`, **shared with
 * the file reader** rather than restated here: the set this verb accepts and the
 * set `config/parse.ts` accepts have to be the same set, and two spellings of
 * "looks like a hostname" drift. An earlier pair of spellings disagreed on a
 * length bound, so a 300-character alias hand-written into the file parsed
 * cleanly while the identical string over this channel was refused.
 *
 * Trimming is this side's own courtesy — a user pastes with padding, and the
 * *stored* value is trimmed, so the two sides still agree on every value that
 * reaches the file.
 */
export function assertHostAlias(value: unknown, label: string): string {
  const raw = assertString(value, label).trim();
  if (raw.length === 0) return fail(`${label}: must not be empty`);
  if (!isHostAlias(raw)) {
    return fail(`${label}: expected a hostname — no scheme, port, path or credentials`);
  }
  return raw;
}

/**
 * A TCP port on the bridge.
 *
 * `0` is legal and means "ask the OS for any free port", which is the default
 * and what shipped — so unlike {@link assertPrNumber} the range starts at 0.
 * The bound is `optionalPort`'s in `config/parse.ts`, restated rather than
 * imported because that module is main-process only; the two have to keep
 * agreeing by inspection, the same discipline `assertHostAlias` documents for
 * `isHostAlias`.
 */
function assertPort(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fail(`${label}: expected an integer, got ${describe(value)}`);
  }
  if (value < 0 || value > 65_535) return fail(`${label}: expected a port from 0 to 65535`);
  return value;
}

/**
 * One {@link ReceiverBindConfig.allowedOrigins} entry.
 *
 * Shares {@link isOrigin} with the file reader for {@link assertHostAlias}'s
 * stated reason: the set the reader accepts and the set the bridge accepts have
 * to be the same one, or a value the UI stores is refused on the next load.
 */
function assertOrigin(value: unknown, label: string): string {
  const raw = assertString(value, label);
  if (!isOrigin(raw)) {
    return fail(`${label}: expected an origin like http://localhost:5173`);
  }
  return raw;
}

/**
 * Payload of `config:set-receiver` (HIVE-131, HIVE-134).
 *
 * `bind` validates the same way `hostAlias` does — one shared predicate per
 * field with the file reader (`isHostAlias`, `isOrigin`; `assertPort` restates
 * `optionalPort`'s bound) — but it does not *salvage* the way the reader does.
 * `optionalBind` keeps two good fields when the third is bad, because a typo
 * in a config file a user hand-edited must not cost the whole block. Here the
 * three fields arrive from a live form, so `assertShape`'s ordinary rule holds:
 * reject the request and name what was wrong, rather than silently keeping
 * only the parts that parsed.
 *
 * An empty `bind: {}` is dropped rather than kept as a no-op key, so a request
 * that touches nothing still falls into the "nothing to change" check below —
 * `bind` is not a special case of that rule, it is a value that can itself be
 * empty.
 */
export function parseSetReceiverRequest(input: unknown): SetReceiverRequest {
  const raw = assertShape(input, [], 'setReceiver', ['hostAlias', 'bind']);

  let bind: Partial<ReceiverBindConfig> | undefined;
  if (raw.bind !== undefined) {
    const rawBind = assertShape(raw.bind, [], 'setReceiver.bind', [
      'host',
      'port',
      'allowedOrigins',
    ]);

    let allowedOrigins: string[] | undefined;
    if (rawBind.allowedOrigins !== undefined) {
      if (!Array.isArray(rawBind.allowedOrigins)) {
        return fail(
          `setReceiver.bind.allowedOrigins: expected an array, got ${describe(rawBind.allowedOrigins)}`,
        );
      }
      allowedOrigins = rawBind.allowedOrigins.map((entry, index) =>
        assertOrigin(entry, `setReceiver.bind.allowedOrigins[${index}]`),
      );
    }

    bind = {
      ...(rawBind.host !== undefined
        ? { host: assertHostAlias(rawBind.host, 'setReceiver.bind.host') }
        : {}),
      ...(rawBind.port !== undefined
        ? { port: assertPort(rawBind.port, 'setReceiver.bind.port') }
        : {}),
      ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
    };
  }

  const request: SetReceiverRequest = {
    ...(raw.hostAlias !== undefined
      ? { hostAlias: assertHostAlias(raw.hostAlias, 'setReceiver.hostAlias') }
      : {}),
    ...(bind !== undefined && Object.keys(bind).length > 0 ? { bind } : {}),
  };

  if (Object.keys(request).length === 0) {
    return fail('setReceiver: nothing to change');
  }
  return request;
}

/**
 * `server.bind.host` (HIVE-142).
 *
 * Shares {@link isHostAlias}'s per-label allowlist with `assertHostAlias`, via
 * {@link isServerBindHost}, and refuses exactly one value neither `assertHostAlias`
 * nor the receiver's own bind refuse: `0.0.0.0`. A served machine is always
 * reachable at a Tailscale address, so binding every interface is a wider
 * surface with nothing to buy for it — see {@link isServerBindHost}'s own
 * doc comment.
 */
function assertServerBindHost(value: unknown, label: string): string {
  const raw = assertString(value, label).trim();
  if (raw.length === 0) return fail(`${label}: must not be empty`);
  if (!isServerBindHost(raw)) {
    return fail(
      `${label}: expected a hostname or IPv4 address — not 0.0.0.0, which exposes every interface`,
    );
  }
  return raw;
}

/**
 * `server.bind.port` (HIVE-142 review, I3).
 *
 * Restates {@link assertPort}'s bound and then refuses the one value the
 * receiver's own bind accepts and this one cannot: `0`. Unlike
 * {@link ReceiverBindConfig.port}, `server.bind.port` cannot be OS-assigned —
 * a client's config and a LaunchAgent both have to be told the number ahead
 * of time, and neither can be handed one the kernel only picks at boot (see
 * {@link ServerBindConfig.port}'s own doc comment).
 */
function assertServerBindPort(value: unknown, label: string): number {
  const port = assertPort(value, label);
  if (port === 0) {
    return fail(`${label}: must be fixed, not 0 — a client and any LaunchAgent need to be told the port ahead of time`);
  }
  return port;
}

/**
 * Payload of `config:set-server` (HIVE-142).
 *
 * Shaped exactly like {@link parseSetReceiverRequest}, field for field, and for
 * the same reasons: `bind` validates one field at a time against
 * {@link SERVER_BIND_KEYS}, salvages nothing on a bad field (this arrives from a
 * live form, not a hand-edited file), and an empty `bind: {}` is dropped so a
 * request that touches nothing still falls into the "nothing to change" check.
 *
 * The one difference from `setReceiver` is `enabled`, a plain boolean with
 * nothing else to validate — `off` is a value, not a nullable field, the same
 * reasoning {@link SetSlackRequest.socketMode} states. There is deliberately no
 * `devices` here: replacing the roster is `pairDevice`/`revokeDevice`'s job in
 * main, reached through `server:pair`/`server:revoke`, never through a payload
 * arriving on this channel.
 */
export function parseSetServerRequest(input: unknown): SetServerRequest {
  const raw = assertShape(input, [], 'setServer', ['enabled', 'bind']);

  let bind: Partial<ServerBindConfig> | undefined;
  if (raw.bind !== undefined) {
    const rawBind = assertShape(raw.bind, [], 'setServer.bind', [
      'host',
      'port',
      'allowedOrigins',
    ]);

    let allowedOrigins: string[] | undefined;
    if (rawBind.allowedOrigins !== undefined) {
      if (!Array.isArray(rawBind.allowedOrigins)) {
        return fail(
          `setServer.bind.allowedOrigins: expected an array, got ${describe(rawBind.allowedOrigins)}`,
        );
      }
      allowedOrigins = rawBind.allowedOrigins.map((entry, index) =>
        assertOrigin(entry, `setServer.bind.allowedOrigins[${index}]`),
      );
    }

    bind = {
      ...(rawBind.host !== undefined
        ? { host: assertServerBindHost(rawBind.host, 'setServer.bind.host') }
        : {}),
      ...(rawBind.port !== undefined
        ? { port: assertServerBindPort(rawBind.port, 'setServer.bind.port') }
        : {}),
      ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
    };
  }

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    return fail(`setServer.enabled: expected a boolean, got ${describe(raw.enabled)}`);
  }

  const request: SetServerRequest = {
    ...(raw.enabled !== undefined ? { enabled: raw.enabled as boolean } : {}),
    ...(bind !== undefined && Object.keys(bind).length > 0 ? { bind } : {}),
  };

  if (Object.keys(request).length === 0) {
    return fail('setServer: nothing to change');
  }
  return request;
}

/**
 * Payload of `server:pair` and `server:revoke` (HIVE-142).
 *
 * A device name is free text a person typed — "Yunid's MacBook" — so it runs
 * through {@link assertText}, the same bound every other pasted string on this
 * bridge takes, rather than a closed grammar like {@link assertAgentName}'s.
 */
export function parsePairDeviceRequest(input: unknown): DeviceNameRequest {
  const raw = assertShape(input, ['name'], 'serverPair');
  return { name: assertText(raw.name, 'serverPair.name') };
}

/** Shape-identical to {@link parsePairDeviceRequest}; see its own doc comment. */
export function parseRevokeDeviceRequest(input: unknown): DeviceNameRequest {
  const raw = assertShape(input, ['name'], 'serverRevoke');
  return { name: assertText(raw.name, 'serverRevoke.name') };
}

/**
 * Payload of `config:set-remote` (HIVE-144).
 *
 * This guard validates **shape only** — `mode` is `'local'` or `'remote'`,
 * `host` is a string, `port` is in range — and, as of fix-round 2, no longer
 * enforces Ruling 3's "`host` must satisfy `isRemoteTarget` once mode is
 * remote" rule at all. Two review rounds each closed one payload shape that
 * broke that rule when it lived here: checking `request.mode` against
 * `request.host` in isolation missed `{ host }` alone against a config
 * already remote, and then missed `{ mode: 'remote' }` alone after an earlier
 * call had legitimately stored an unvalidated host under `'local'`. Both are
 * the same defect through a different door — a guard that sees one
 * incremental patch can never resolve "effective mode" from that patch alone,
 * because the config it merges onto is state this function does not have and
 * must not be given (threading config reads into a shared, stateless guard
 * module would be a bigger change than the bug warrants).
 *
 * The invariant now lives in exactly one place: `setRemote`
 * (`electron/main/config/index.ts`), checked once against the merged result
 * `writeConfig` is about to write — the only place that actually holds both
 * the payload and the config it lands on. See that function's own doc
 * comment for the property statement and why a single merged-state check
 * closes every sequence of calls, not just the one shape a review happened
 * to try.
 *
 * That is also why `host` takes no "must not be empty" check of its own:
 * {@link DEFAULT_REMOTE} carries `''`, and a payload restating `mode: 'local'`
 * alongside that empty default is the normal, never-attached state, not a
 * malformed request — and it is also why a bare `{ host }` payload, with no
 * `mode`, is accepted here again: a host-only save while the stored config is
 * genuinely local is harmless (Ruling 3), and one that would leave the
 * effective state remote-with-a-bad-host is caught by `setRemote`,
 * regardless of which field this call happened to carry.
 *
 * Unlike `optionalRemote`, this guard salvages nothing on a bad field: the
 * payload arrives from a live form, not a file a human hand-edited, so one
 * bad field fails the whole request — the same rule {@link
 * parseSetServerRequest} applies to its own three fields.
 *
 * There is no token field, and there never will be: `remote:pair` is the only
 * verb that ever writes one, and it writes to `safeStorage`, never here.
 */
export function parseSetRemoteRequest(input: unknown): SetRemoteRequest {
  const raw = assertShape(input, [], 'setRemote', ['mode', 'host', 'port']);

  let mode: RemoteMode | undefined;
  if (raw.mode !== undefined) {
    if (raw.mode !== 'local' && raw.mode !== 'remote') {
      return fail(`setRemote.mode: expected "local" or "remote"`);
    }
    mode = raw.mode;
  }

  const request: SetRemoteRequest = {
    ...(mode !== undefined ? { mode } : {}),
    ...(raw.host !== undefined
      ? { host: assertString(raw.host, 'setRemote.host') }
      : {}),
    ...(raw.port !== undefined ? { port: assertPort(raw.port, 'setRemote.port') } : {}),
  };

  if (Object.keys(request).length === 0) {
    return fail('setRemote: nothing to change');
  }
  return request;
}

/**
 * Payload of `remote:pair` (HIVE-144).
 *
 * The opposite direction from {@link parsePairDeviceRequest}: that one takes a
 * free-text name typed by a person; this one takes the two values a
 * `server:pair` mint on some *other* machine handed back — a `deviceId` this
 * app already recognises as an id (`assertId`, the same guard every session
 * and project id on this bridge takes), and a `token`, which is exactly the
 * "credential in a payload" shape {@link assertJiraToken} was generalised to
 * describe, not anything specific to Jira.
 */
export function parseRemotePairRequest(input: unknown): RemotePairRequest {
  const raw = assertShape(input, ['deviceId', 'token'], 'remotePair');
  return {
    deviceId: assertId(raw.deviceId, 'remotePair.deviceId'),
    token: assertJiraToken(raw.token, 'remotePair.token'),
  };
}

/**
 * A Slack user id allowed to command an agent with `@hive` (HIVE-124).
 *
 * Non-empty and free of whitespace: a pasted id with trailing whitespace, or
 * two ids pasted as one string separated by a space, are both malformed
 * inputs this guard should refuse rather than quietly repair.
 */
function assertCommanderId(value: unknown, label: string): string {
  const id = assertString(value, label);
  if (id.length === 0) return fail(`${label}: must not be empty`);
  if (/\s/.test(id)) return fail(`${label}: must not contain whitespace`);
  return id;
}

/**
 * Payload of `config:set-slack` (HIVE-124).
 *
 * `commanders` replaces the stored list wholesale — see
 * {@link SetSlackRequest.commanders} — so the array itself is rejected
 * outright when it is not one, and every entry is validated individually, the
 * same two-step shape {@link parseReorderProjectsRequest} uses for its own
 * array.
 */
export function parseSetSlackRequest(input: unknown): SetSlackRequest {
  const raw = assertShape(input, [], 'setSlack', ['socketMode', 'commanders']);

  let commanders: string[] | undefined;
  if (raw.commanders !== undefined) {
    if (!Array.isArray(raw.commanders)) {
      return fail(
        `setSlack.commanders: expected an array, got ${describe(raw.commanders)}`,
      );
    }
    commanders = Array.from(raw.commanders as unknown[]).map((id, index) =>
      assertCommanderId(id, `setSlack.commanders[${index}]`),
    );
  }

  const request: SetSlackRequest = {
    ...(raw.socketMode !== undefined
      ? { socketMode: assertBoolean(raw.socketMode, 'setSlack.socketMode') }
      : {}),
    ...(commanders !== undefined ? { commanders } : {}),
  };

  if (Object.keys(request).length === 0) {
    return fail('setSlack: nothing to change');
  }
  return request;
}

/** The token, on its way to `safeStorage`. The first payload carrying a secret. */
export function parseSetJiraTokenRequest(input: unknown): SetJiraTokenRequest {
  const raw = assertShape(input, ['token'], 'setJiraToken');
  return { token: assertJiraToken(raw.token, 'setJiraToken.token') };
}

/**
 * The two socket-mode tokens, on their way to `safeStorage` (HIVE-124).
 *
 * {@link parseSetJiraTokenRequest} is the model, and {@link assertJiraToken} is
 * reused rather than copied: "printable ASCII, no spaces, bounded" is a
 * statement about *credentials in a payload*, not about Jira, and both `xapp-`
 * and `xoxb-` are exactly that shape.
 *
 * Neither field is required and at least one must be present — the merge shape
 * {@link SetSlackTokensRequest} describes. An empty payload is refused rather
 * than treated as a clear: clearing has its own channel, and a write that
 * silently erased both would be the one mistake this guard can prevent.
 *
 * The `xapp-` / `xoxb-` prefixes are deliberately **not** enforced. Slack has
 * renamed token prefixes before, and a guard that refused a valid token would
 * be a bug the user could not work around; a wrong one fails at `auth.test`
 * with Slack's own message, which is the better report.
 */
export function parseSetSlackTokensRequest(input: unknown): SetSlackTokensRequest {
  const raw = assertShape(input, [], 'setSlackTokens', ['appToken', 'botToken']);

  const request: SetSlackTokensRequest = {
    ...(raw.appToken === undefined
      ? {}
      : { appToken: assertJiraToken(raw.appToken, 'setSlackTokens.appToken') }),
    ...(raw.botToken === undefined
      ? {}
      : { botToken: assertJiraToken(raw.botToken, 'setSlackTokens.botToken') }),
  };

  if (Object.keys(request).length === 0) {
    return fail('setSlackTokens: nothing to change');
  }

  return request;
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

/**
 * `github:search-prs` — the PRs panel's search row.
 *
 * The first `github:` payload there has ever been, and the checks are the ones
 * that keep the channel's claim true.
 *
 * `term` goes through {@link assertText}, which bounds the length and refuses
 * control characters. It is deliberately **not** pattern-matched beyond that: a
 * search term is prose, and a guard that admitted only "safe-looking" words
 * would refuse the ones users actually type. What makes it safe is where it
 * lands — a bound GraphQL variable inside an expression main composed — and
 * `safeSearchTerm` in `query.ts`, which removes the one character that could
 * turn a term into a qualifier.
 *
 * `projectId` is an ordinary entity id. It is looked up in the config main
 * wrote, so an id naming nothing narrows the search to no repositories at all
 * and is refused downstream. That is the safe direction: the failure of a bad
 * id is *fewer* results, never results from somewhere the user did not map.
 */
export function parseSearchPrsRequest(input: unknown): {
  term: string;
  projectId?: string;
} {
  const raw = assertShape(input, ['term'], 'searchPrs', ['projectId']);
  return {
    term: assertText(raw.term, 'searchPrs.term'),
    ...(raw.projectId !== undefined
      ? { projectId: assertId(raw.projectId, 'searchPrs.projectId') }
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

const MAX_STATUS_NAME = 64;

/**
 * `{ key, status }` for the `jira_transition` tool (HIVE-174). The status is a
 * name a person would read in Jira: short, printable, non-empty.
 */
export function parseJiraTransitionByName(input: unknown): JiraTransitionByName {
  const raw = assertShape(input, ['key', 'status'], 'jiraTransition', ['from']);
  const status = assertStatusName(raw.status, 'jiraTransition.status');
  return {
    key: assertJiraIssueKey(raw.key, 'jiraTransition.key'),
    status,
    ...(raw.from === undefined ? {} : { from: assertStatusName(raw.from, 'jiraTransition.from') }),
  };
}

function assertStatusName(value: unknown, label: string): string {
  const status = assertString(value, label).trim();
  if (status === '') return fail(`${label}: must not be empty`);
  if (status.length > MAX_STATUS_NAME) return fail(`${label}: too long`);
  for (const char of status) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return fail(`${label}: control characters are not allowed`);
    }
  }
  return status;
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
    'container',
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
    ...(raw.container !== undefined
      ? {
          container:
            raw.container === null
              ? null
              : assertContainer(raw.container, 'setProjectRuntime.container'),
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

/**
 * `sessionId` is validated as an ordinary entity id and nothing more.
 *
 * That is the whole check it needs, and the reason is where the value is used:
 * main looks it up in the cwd registry **it** populated from that session's own
 * hook payloads, and an id naming no session simply resolves to nothing. There
 * is no path in this payload to sanitise, which is property 1 of
 * `fs-contract.ts` holding exactly as designed.
 */
export function parseReadDirRequest(input: unknown): ReadDirRequest {
  const raw = assertShape(input, ['projectId', 'relPath'], 'readDir', [
    'sessionId',
  ]);
  return {
    projectId: assertId(raw.projectId, 'readDir.projectId'),
    relPath: assertRelPath(raw.relPath, 'readDir.relPath'),
    ...(raw.sessionId !== undefined
      ? { sessionId: assertId(raw.sessionId, 'readDir.sessionId') }
      : {}),
  };
}

export function parseReadFileRequest(input: unknown): ReadFileRequest {
  const raw = assertShape(input, ['projectId', 'relPath'], 'readFile', [
    'sessionId',
  ]);
  return {
    projectId: assertId(raw.projectId, 'readFile.projectId'),
    relPath: assertRelPath(raw.relPath, 'readFile.relPath'),
    ...(raw.sessionId !== undefined
      ? { sessionId: assertId(raw.sessionId, 'readFile.sessionId') }
      : {}),
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
/**
 * `fs:search` — the one fs verb whose payload is prose.
 *
 * `assertText` rather than anything narrower, for the reason
 * `parseSearchPrsRequest` already gives: a search term is prose, and a guard
 * that admitted only "safe-looking" words would refuse the ones people
 * actually type. It is still bounded and still free of control characters,
 * which is what the guard is for — the query never reaches a shell, a regex
 * engine or a path, so there is nothing here for it to escape into.
 *
 * `mode` is checked against the two literals rather than cast: an unknown mode
 * would otherwise fall through to the content branch and read every file in
 * the project to answer a question nobody asked.
 */
export function parseSearchRequest(input: unknown): SearchRequest {
  const raw = assertShape(input, ['projectId', 'query', 'mode'], 'fsSearch', [
    'sessionId',
  ]);
  const mode = assertString(raw.mode, 'fsSearch.mode');
  if (mode !== 'name' && mode !== 'text') {
    return fail('fsSearch.mode: must be "name" or "text"');
  }
  return {
    projectId: assertId(raw.projectId, 'fsSearch.projectId'),
    query: assertText(raw.query, 'fsSearch.query'),
    mode,
    ...(raw.sessionId !== undefined
      ? { sessionId: assertId(raw.sessionId, 'fsSearch.sessionId') }
      : {}),
  };
}

export function parseWriteFileRequest(input: unknown): WriteFileRequest {
  const raw = assertShape(
    input,
    ['projectId', 'relPath', 'text', 'baseMtimeMs'],
    'writeFile',
    ['sessionId'],
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
    ...(raw.sessionId !== undefined
      ? { sessionId: assertId(raw.sessionId, 'writeFile.sessionId') }
      : {}),
  };
}

/**
 * `fs:root` — a project and, optionally, a session. Same two values the reads
 * already carry, validated the same way: an id is an id, and there is no path
 * in this payload either.
 */
export function parseRootRequest(input: unknown): RootRequest {
  const raw = assertShape(input, ['projectId'], 'root', ['sessionId']);
  return {
    projectId: assertId(raw.projectId, 'root.projectId'),
    ...(raw.sessionId !== undefined
      ? { sessionId: assertId(raw.sessionId, 'root.sessionId') }
      : {}),
  };
}

export function parseWatchRequest(input: unknown): WatchRequest {
  const raw = assertShape(input, ['projectId'], 'watch', ['sessionId']);
  return {
    projectId: assertId(raw.projectId, 'watch.projectId'),
    ...(raw.sessionId !== undefined
      ? { sessionId: assertId(raw.sessionId, 'watch.sessionId') }
      : {}),
  };
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

/**
 * A skill-relative path, as the bundle verbs accept one (HIVE-148).
 *
 * `assertRelPath`'s rules, and deliberately not a character class. A charset of
 * `[a-z0-9._-]` looks stricter and buys nothing: traversal is already dead
 * without it, because no `..` segment survives — while it would refuse
 * `README.md`, `Inter-Bold.ttf` and every screenshot with a space in its name,
 * which are exactly the files a user drags into a bundle.
 *
 * What it adds over `assertRelPath` is a depth cap and a refusal of `''`. The
 * empty path means "the project root" there; here every verb names a thing,
 * and a verb that removed the bundle root would be `skills.remove` with a
 * different name.
 *
 * It also **normalises**, not just validates: the return value is
 * `segments.join('/')`, not the string that was passed in. `a//b`, `a/b/c/d/`
 * and `a\b\c\d` all `join` onto a root identically, so nothing downstream
 * broke while this returned the verbatim string — but `readBundle` emits
 * canonical POSIX-separated paths as `BundleEntry.path`, and a request that
 * kept its own separators or doubled slashes would carry a string that can
 * never `===` the manifest entry it names, silently missing a dedupe or an
 * open-buffer lookup keyed on that path.
 *
 * As with `assertRelPath`, this is not a containment check and cannot be one.
 * `electron/main/skills/paths.ts` resolves and calls `contains()` after
 * `realpath`. Both are required.
 */
export function assertSkillPath(value: unknown, label: string): string {
  const path = assertRelPath(value, label);
  if (path === '') return fail(`${label}: names nothing`);

  const segments = path.split(/[/\\]/).filter((segment) => segment !== '');
  if (segments.length > MAX_BUNDLE_DEPTH) {
    return fail(`${label}: deeper than ${String(MAX_BUNDLE_DEPTH)} folders`);
  }
  if (segments.some((segment) => segment === '.')) {
    return fail(`${label}: must not contain a dot segment`);
  }

  return segments.join('/');
}

/**
 * The same rule, plus the bundle root.
 *
 * A separate export rather than a boolean parameter: `import` and `drop` target
 * a directory and default to the root, every other verb names an entry, and a
 * flag repeated at nine call sites is a flag someone eventually passes wrong.
 */
export function assertSkillDir(value: unknown, label: string): string {
  const path = assertString(value, label);
  if (path === '') return '';
  return assertSkillPath(path, label);
}

export function parseSkillNameRequest(input: unknown): SkillNameRequest {
  const raw = assertShape(input, ['name'], 'skillName');
  return { name: assertSkillName(raw.name, 'skillName.name') };
}

/**
 * `skills:rename` — two names, and still not a path between them (HIVE-99).
 *
 * The only guard here with two name fields, which is exactly why both run
 * through {@link assertSkillName} rather than one being trusted because it came
 * from a list the renderer was given. `from` arrives from the page the same way
 * `to` does, and a guard that validated only the new name would let a request
 * name a *source* main never listed.
 *
 * Nothing checks that the two differ, and that is a statement about *this*
 * layer only: whether a request makes sense is not a question about what it can
 * express, which is all a guard decides. Two equal names are two valid names.
 *
 * What happens to one downstream is main's business, and main refuses it — the
 * destination exists, because it is the source. The pane never sends one, so
 * this is unreachable rather than a behaviour anyone relies on; it is written
 * down because an earlier draft of this comment promised the opposite (a
 * harmless no-op) and a future caller could have believed it.
 */
export function parseSkillRenameRequest(input: unknown): SkillRenameRequest {
  const raw = assertShape(input, ['from', 'to'], 'skillRename');
  return {
    from: assertSkillName(raw.from, 'skillRename.from'),
    to: assertSkillName(raw.to, 'skillRename.to'),
  };
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

export function parseSkillPathRequest(input: unknown): SkillPathRequest {
  const raw = assertShape(input, ['name', 'path'], 'skillFilePath');
  return {
    name: assertSkillName(raw.name, 'skillFilePath.name'),
    path: assertSkillPath(raw.path, 'skillFilePath.path'),
  };
}

export function parseSkillFileWriteRequest(
  input: unknown,
): SkillFileWriteRequest {
  const raw = assertShape(input, ['name', 'path', 'body'], 'skillFileWrite');
  return {
    name: assertSkillName(raw.name, 'skillFileWrite.name'),
    path: assertSkillPath(raw.path, 'skillFileWrite.path'),
    body: assertString(raw.body, 'skillFileWrite.body'),
  };
}

export function parseSkillMoveRequest(input: unknown): SkillMoveRequest {
  const raw = assertShape(input, ['name', 'from', 'to'], 'skillFileMove');
  return {
    name: assertSkillName(raw.name, 'skillFileMove.name'),
    from: assertSkillPath(raw.from, 'skillFileMove.from'),
    to: assertSkillPath(raw.to, 'skillFileMove.to'),
  };
}

export function parseSkillImportRequest(input: unknown): SkillImportRequest {
  const raw = assertShape(input, ['name', 'dir'], 'skillFileImport');
  return {
    name: assertSkillName(raw.name, 'skillFileImport.name'),
    dir: assertSkillDir(raw.dir, 'skillFileImport.dir'),
  };
}

/**
 * The only skills verb whose payload holds an absolute path.
 *
 * Guarded here anyway. Preload is what makes a forged path impossible, and this
 * is what makes a *broken* preload visible rather than exploitable — the same
 * belt-and-braces `parseSpawnRequest` applies to values main itself chose.
 */
export function parseSkillDropRequest(input: unknown): SkillDropRequest {
  const raw = assertShape(input, ['name', 'dir', 'sources'], 'skillFileDrop');

  // Declaration order, like every other parser here: a doubly-wrong request
  // reports the field named first in the shape, not whichever check happens
  // to run first in the function body.
  const name = assertSkillName(raw.name, 'skillFileDrop.name');
  const dir = assertSkillDir(raw.dir, 'skillFileDrop.dir');

  if (!Array.isArray(raw.sources)) {
    return fail('skillFileDrop.sources: must be an array');
  }
  if (raw.sources.length > MAX_BUNDLE_FILES) {
    return fail(
      `skillFileDrop.sources: more than ${String(MAX_BUNDLE_FILES)} files`,
    );
  }

  return {
    name,
    dir,
    /*
      `Array.from` first, not a bare `.map`. `Array.prototype.map` skips holes
      — `new Array(3)` has none of its indices set — so a sparse array walks
      straight past the per-element guard below and comes back as a `string[]`
      that is really three holes, no throw. `structuredClone`/`v8.serialize`,
      which is the channel this payload actually crosses, preserves holes
      exactly like that. `Array.from` reads every index up to `.length`,
      turning a hole into `undefined`, which `assertString` then refuses like
      any other wrong-typed element.
    */
    sources: Array.from(raw.sources).map((source, index) => {
      const label = `skillFileDrop.sources[${String(index)}]`;
      const path = assertString(source, label);
      if (!path.startsWith('/')) {
        return fail(`${label}: must be an absolute path`);
      }
      return path;
    }),
  };
}

/**
 * An agent name — a folder name, and the identity a ledger entry is `from`
 * (HIVE-114).
 *
 * The same job as {@link assertSkillName} and for the same reason: main will
 * `join` this onto a directory it owns, so the work here is making a path
 * unrepresentable rather than sanitising one. Nothing downstream re-checks
 * containment.
 *
 * A reserved name — {@link isReservedAgentName} — is refused here as well as in
 * the reader, following the argument `assertSkillName` makes about `done`: a
 * reservation is part of the contract rather than a detail of the filesystem
 * layer. `overmind` matters more than `done` does here — it is the ledger's
 * coordinator identity, and an agent that could take that name could sign its
 * entries as the overmind. Since HIVE-115 the session-id shape is reserved on
 * the same footing, and for a sharper reason: an agent called `sess-01` would
 * have a live *terminal*'s identity, not just a confusing one.
 */
export function assertAgentName(value: unknown, label: string): string {
  const name = assertString(value, label);

  if (!AGENT_NAME_PATTERN.test(name)) {
    return fail(`${label}: must be lowercase letters, digits and dashes`);
  }
  if (isReservedAgentName(name)) {
    return fail(`${label}: "${name}" is reserved`);
  }
  return name;
}

export function parseAgentNameRequest(input: unknown): AgentNameRequest {
  const raw = assertShape(input, ['name'], 'agentName');
  return { name: assertAgentName(raw.name, 'agentName.name') };
}

/**
 * `agents:run` — wake one agent, and say nothing else about how (HIVE-115).
 *
 * Shape-identical to {@link parseAgentNameRequest} and deliberately not an
 * alias of it. The two guards label their failures for the channel that
 * actually rejected the payload — the reason {@link parseDiagnoseEnvRequest}
 * gives for the same duplication next door — and this is the channel where a
 * rejection matters most, because it is the one that starts a process.
 *
 * It runs {@link assertAgentName}, so `run` is bounded by exactly the grammar
 * the five verbs before it are bounded by: a name that cannot be a path and
 * cannot be a reserved identity. Everything the command line is *built* from —
 * the binary, the flags, the environment, the working directory — is read by
 * main from its own config and the definition on disk, and stays unreachable
 * from here.
 *
 * `extra` is the one field that does reach the argv (HIVE-126), and the shape
 * of that reach is the point: `wakeCommand` interpolates it into the single
 * positional `-p` prompt, so it becomes prose *inside* an argument rather than
 * an argument of its own. It cannot become a flag, a path or a variable, and
 * `assertText` — the guard `spawn.task` uses — is what keeps it from carrying a
 * control character or an unbounded length into a spawned process.
 *
 * `assertShape`'s closed key set is load-bearing here rather than tidy: a
 * payload carrying a `trigger`, `args` or `env` is refused outright instead of
 * being silently ignored, so a renderer that starts sending one fails loudly at
 * the boundary rather than developing a belief that main is reading it. HIVE-126
 * opened this set by exactly one key, and `trigger` is the one it kept shut.
 */
export function parseAgentRunRequest(input: unknown): AgentRunRequest {
  const raw = assertShape(input, ['name'], 'agentRun', ['extra']);
  const name = assertAgentName(raw.name, 'agentRun.name');

  if (raw.extra === undefined) return { name };

  return { name, extra: assertText(raw.extra, 'agentRun.extra') };
}

/**
 * `agents:rename` — two names, and no path between them.
 *
 * Both run through {@link assertAgentName} for the reason
 * {@link parseSkillRenameRequest} spells out: `from` arrives from the page
 * exactly as `to` does, and validating only the destination would let a
 * request name a *source* main never listed.
 */
export function parseAgentRenameRequest(input: unknown): AgentRenameRequest {
  const raw = assertShape(input, ['from', 'to'], 'agentRename', ['source']);
  return {
    from: assertAgentName(raw.from, 'agentRename.from'),
    to: assertAgentName(raw.to, 'agentRename.to'),
    // Same decision `parseAgentWriteRequest` documents: the bytes are not
    // pattern-checked, because what makes them safe is *where* they land.
    ...(raw.source === undefined
      ? {}
      : { source: assertString(raw.source, 'agentRename.source') }),
  };
}

/**
 * `agents:write` — the whole file the user typed, under a validated name.
 *
 * `source` gets no length cap and no control-character sweep, the same
 * decision {@link parseSkillWriteRequest} documents: an AGENT.md legitimately
 * contains tabs and newlines, and what makes this safe is *where* the bytes
 * land — a directory main chose, under a name that cannot name anywhere else.
 *
 * The frontmatter inside is deliberately **not** validated here. This layer
 * decides what a payload may express; whether the definition is well-formed is
 * the registry's question, and it answers with field-addressed problems the
 * editor can render. A guard that threw on a half-typed file would turn every
 * keystroke-in-progress into an IPC error.
 */
export function parseAgentWriteRequest(input: unknown): AgentWriteRequest {
  const raw = assertShape(input, ['name', 'source'], 'agentWrite');
  return {
    name: assertAgentName(raw.name, 'agentWrite.name'),
    source: assertString(raw.source, 'agentWrite.source'),
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

/**
 * The ledger's three payloads (HIVE-111).
 *
 * `parseLedgerPostBody` **drops** any `from` it is given rather than
 * validating it. Identity comes from the transport — the `x-hive-session`
 * header, or `OVERMIND` for the renderer — and a body that could name a party
 * would be a party impersonating another with a one-word edit.
 */

/**
 * Same {@link FORBIDDEN_KEYS} discipline `assertShape` applies, for the ledger
 * parsers that cannot use `assertShape` itself: `meta` is an arbitrary
 * caller-supplied map, not a fixed shape, and it is written to disk verbatim
 * by `ledger/index.ts` — a `__proto__` own key surviving this check would
 * survive to persistence, not just to one process's `Object.prototype`.
 *
 * **Top level only**, and deliberately: `Object.keys` does not recurse, so a
 * forbidden key nested inside a `meta` *value* is stored as written. That is
 * safe for every consumer the ledger has, because all of them only ever read
 * values *out* of `meta` (`claims` reads `meta.task`; the renderer renders
 * it) — a plain own property named `__proto__` on a nested object poisons
 * nothing that is merely read. The day a consumer **deep-merges** `meta` into
 * another object, or spreads it into one whose prototype matters, this needs
 * to become a recursive sanitiser; until then a recursive walk over an
 * unbounded caller-supplied map on every write would be cost without a threat
 * behind it.
 */
const asRecord = (input: unknown, label: string): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new TypeError(`${label}: forbidden key "${key}"`);
    }
  }
  return input as Record<string, unknown>;
};

const optionalString = (
  source: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined => {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  return value;
};

const requiredString = (
  source: Record<string, unknown>,
  key: string,
  label: string,
): string => {
  const value = source[key];
  if (typeof value !== 'string') {
    throw new TypeError(`${label}.${key} must be a string`);
  }
  return value;
};

const optionalKind = (
  source: Record<string, unknown>,
  label: string,
): LedgerKind | undefined => {
  const value = source.kind;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(LEDGER_KINDS as readonly string[]).includes(value)) {
    throw new TypeError(`${label}.kind must be one of ${LEDGER_KINDS.join(', ')}`);
  }
  return value as LedgerKind;
};

const optionalMeta = (
  source: Record<string, unknown>,
  label: string,
): Record<string, unknown> | undefined => {
  const value = source.meta;
  if (value === undefined) return undefined;
  return asRecord(value, `${label}.meta`);
};

export function parseLedgerReadQuery(input: unknown): LedgerReadQuery {
  const source = asRecord(input, 'ledger query');
  const query: LedgerReadQuery = {};

  const to = optionalString(source, 'to', 'ledger query');
  if (to !== undefined) query.to = to;
  const from = optionalString(source, 'from', 'ledger query');
  if (from !== undefined) query.from = from;
  const kind = optionalKind(source, 'ledger query');
  if (kind !== undefined) query.kind = kind;
  const thread = optionalString(source, 'thread', 'ledger query');
  if (thread !== undefined) query.thread = thread;
  const since = optionalString(source, 'since', 'ledger query');
  if (since !== undefined) query.since = since;

  const limit = source.limit;
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
      throw new TypeError('ledger query.limit must be a non-negative integer');
    }
    query.limit = limit;
  }

  return query;
}

export function parseLedgerPostBody(input: unknown): Omit<LedgerPostRequest, 'from'> {
  const source = asRecord(input, 'ledger post');
  const kind = optionalKind(source, 'ledger post');
  if (kind === undefined) {
    throw new TypeError(`ledger post.kind must be one of ${LEDGER_KINDS.join(', ')}`);
  }

  const request: Omit<LedgerPostRequest, 'from'> = {
    kind,
    body: requiredString(source, 'body', 'ledger post'),
  };

  const to = optionalString(source, 'to', 'ledger post');
  if (to !== undefined) request.to = to;
  const thread = optionalString(source, 'thread', 'ledger post');
  if (thread !== undefined) request.thread = thread;
  const meta = optionalMeta(source, 'ledger post');
  if (meta !== undefined) request.meta = meta;

  return request;
}

export function parseLedgerAnswerRequest(input: unknown): LedgerAnswerRequest {
  const source = asRecord(input, 'ledger answer');
  const request: LedgerAnswerRequest = {
    thread: optionalString(source, 'thread', 'ledger answer') ?? '',
    body: requiredString(source, 'body', 'ledger answer'),
  };
  if (request.thread === '') throw new TypeError('ledger answer.thread must be a non-empty string');

  const meta = optionalMeta(source, 'ledger answer');
  if (meta !== undefined) request.meta = meta;

  return request;
}

/**
 * `owner/name` as GitHub spells them: an owner is alphanumerics and hyphens,
 * at most 39; a name adds `_` and `.`, at most 100, and is never `.` or `..`.
 * The slug is only ever compared to a sweep's records, never used as a path,
 * so this is about refusing nonsense early with a sentence, not about safety.
 */
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;

/**
 * The body of a `PR_PATH` request (HIVE-173). Strict on both fields: the
 * caller is a model, and "400, repo must be owner/name" is something it can act
 * on where a lookup that quietly matched nothing is not.
 */
export function parsePrLookup(input: unknown): PrLookup {
  const source = asRecord(input, 'pr lookup');
  const repo = source.repo;
  if (typeof repo !== 'string' || !REPO_SLUG.test(repo)) {
    throw new TypeError('pr lookup.repo must be owner/name');
  }
  const number = source.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    throw new TypeError('pr lookup.number must be a positive integer');
  }
  return { repo, number };
}

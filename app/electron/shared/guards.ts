import type { ResizeRequest, SpawnRequest, WriteRequest } from './ipc-contract';

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
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(`${label}: expected an object, got ${describe(value)}`);
  }

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
  for (const key of allowed) {
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

export function parseSpawnRequest(input: unknown): SpawnRequest {
  const raw = assertShape(
    input,
    ['sessionId', 'projectId', 'cols', 'rows'],
    'spawn',
  );
  return {
    sessionId: assertId(raw.sessionId, 'spawn.sessionId'),
    projectId: assertId(raw.projectId, 'spawn.projectId'),
    cols: assertDimension(raw.cols, 'spawn.cols'),
    rows: assertDimension(raw.rows, 'spawn.rows'),
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

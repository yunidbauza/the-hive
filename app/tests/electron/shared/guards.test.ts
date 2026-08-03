// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  IpcValidationError,
  parseAddProjectRequest,
  parseKillRequest,
  parseRemoveProjectRequest,
  parseResizeRequest,
  parseSpawnRequest,
  parseWriteRequest,
} from '../../../electron/shared/guards';

const validSpawn = { sessionId: 'sess-1', projectId: 'proj-1', cols: 80, rows: 24 };

/**
 * The guard matrix story 082 specifies: wrong type, missing field, extra field,
 * prototype-polluting key, and a non-string sessionId — for every payload.
 */
describe('parseSpawnRequest', () => {
  it('accepts a well-formed request and returns a typed value', () => {
    expect(parseSpawnRequest({ ...validSpawn })).toEqual(validSpawn);
  });

  it('does not pass through anything beyond the declared fields', () => {
    const parsed = parseSpawnRequest({ ...validSpawn });
    expect(Object.keys(parsed).sort()).toEqual([
      'cols',
      'projectId',
      'rows',
      'sessionId',
    ]);
  });

  it.each([
    ['not an object', 'sess-1'],
    ['null', null],
    ['an array', []],
    ['undefined', undefined],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSpawnRequest(input)).toThrow(IpcValidationError);
  });

  it('rejects a missing field', () => {
    const { cols: _cols, ...missing } = validSpawn;
    expect(() => parseSpawnRequest(missing)).toThrow(/missing key "cols"/);
  });

  it('rejects an extra field rather than ignoring it', () => {
    // An unexpected key means the two sides disagree about the contract.
    expect(() => parseSpawnRequest({ ...validSpawn, cwd: '/etc' })).toThrow(
      /unexpected key "cwd"/,
    );
  });

  it('rejects a prototype-polluting key', () => {
    // JSON.parse produces an OWN property named __proto__, which a spread
    // would carry into the next object.
    const polluted = JSON.parse(
      '{"sessionId":"s","projectId":"p","cols":80,"rows":24,"__proto__":{"admin":true}}',
    );
    expect(() => parseSpawnRequest(polluted)).toThrow(/forbidden key/);
  });

  it('rejects a non-string sessionId', () => {
    expect(() => parseSpawnRequest({ ...validSpawn, sessionId: 42 })).toThrow(
      /expected a string/,
    );
  });

  it.each([
    ['empty', ''],
    ['a path traversal', '../../etc/passwd'],
    ['a newline (log injection)', 'sess\n1'],
    ['a null byte', 'sess\u00001'],
    ['a shell metacharacter', 'sess;rm -rf /'],
    ['over 128 chars', 'a'.repeat(129)],
  ])('rejects a sessionId that is %s', (_label, id) => {
    expect(() => parseSpawnRequest({ ...validSpawn, sessionId: id })).toThrow(
      IpcValidationError,
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 80.5],
    ['absurd', 100_000],
    ['NaN', Number.NaN],
    ['a string', '80'],
  ])('rejects cols that is %s', (_label, cols) => {
    expect(() => parseSpawnRequest({ ...validSpawn, cols })).toThrow(
      IpcValidationError,
    );
  });
});

describe('parseSpawnRequest — the optional task', () => {
  it('accepts a request with no task at all', () => {
    expect(parseSpawnRequest({ ...validSpawn })).not.toHaveProperty('task');
  });

  it('accepts an ordinary task', () => {
    expect(
      parseSpawnRequest({ ...validSpawn, task: 'fix the hero' }).task,
    ).toBe('fix the hero');
  });

  it('accepts punctuation and non-ASCII text', () => {
    const task = 'rename “widget” → gadget (see #219)';
    expect(parseSpawnRequest({ ...validSpawn, task }).task).toBe(task);
  });

  /**
   * The task is written into a pty, so a control character is not a
   * formatting quirk — it is an instruction to a terminal the user trusts.
   */
  it('rejects a carriage return, which would submit a line nobody typed', () => {
    expect(() =>
      parseSpawnRequest({ ...validSpawn, task: 'ls\rrm -rf /' }),
    ).toThrow(/control characters/);
  });

  it('rejects an escape byte, which could address the cursor', () => {
    expect(() =>
      parseSpawnRequest({ ...validSpawn, task: 'a\u001b[31mb' }),
    ).toThrow(/control characters/);
  });

  it('rejects a NUL', () => {
    expect(() =>
      parseSpawnRequest({ ...validSpawn, task: 'a\u0000b' }),
    ).toThrow(IpcValidationError);
  });

  it('rejects an unbounded task', () => {
    expect(() =>
      parseSpawnRequest({ ...validSpawn, task: 'x'.repeat(4097) }),
    ).toThrow(/too long/);
  });

  it('rejects an empty task rather than spawning a blank instruction', () => {
    expect(() => parseSpawnRequest({ ...validSpawn, task: '' })).toThrow(
      /must not be empty/,
    );
  });

  it('rejects a non-string task', () => {
    expect(() => parseSpawnRequest({ ...validSpawn, task: 42 })).toThrow(
      IpcValidationError,
    );
  });

  it('still rejects an unexpected key — optional is not a free-for-all', () => {
    expect(() => parseSpawnRequest({ ...validSpawn, nope: 1 })).toThrow(
      /unexpected key/,
    );
  });

  it('still rejects a missing required key', () => {
    const { cols: _cols, ...missing } = validSpawn;
    expect(() => parseSpawnRequest({ ...missing, task: 'x' })).toThrow(
      /missing key "cols"/,
    );
  });
});

describe('parseWriteRequest', () => {
  it('accepts keystrokes', () => {
    expect(parseWriteRequest({ sessionId: 'sess-1', data: 'ls -la\r' })).toEqual({
      sessionId: 'sess-1',
      data: 'ls -la\r',
    });
  });

  it('allows control characters in data — they are keystrokes, not content', () => {
    // Ctrl-C. Never interpreted here; only written to a pty's stdin.
    const parsed = parseWriteRequest({ sessionId: 'sess-1', data: '\u0003' });
    expect(parsed.data).toBe('\u0003');
  });

  it('rejects a missing field, an extra field, and a bad id', () => {
    expect(() => parseWriteRequest({ sessionId: 'sess-1' })).toThrow(/missing key/);
    expect(() =>
      parseWriteRequest({ sessionId: 'sess-1', data: 'x', echo: true }),
    ).toThrow(/unexpected key/);
    expect(() => parseWriteRequest({ sessionId: 12, data: 'x' })).toThrow(
      /expected a string/,
    );
  });

  it('rejects non-string data', () => {
    expect(() =>
      parseWriteRequest({ sessionId: 'sess-1', data: { toString: 'evil' } }),
    ).toThrow(/expected a string/);
  });
});

describe('parseResizeRequest', () => {
  it('accepts geometry', () => {
    expect(parseResizeRequest({ sessionId: 's1', cols: 120, rows: 40 })).toEqual({
      sessionId: 's1',
      cols: 120,
      rows: 40,
    });
  });

  it('rejects the whole matrix', () => {
    expect(() => parseResizeRequest(null)).toThrow(IpcValidationError);
    expect(() => parseResizeRequest({ sessionId: 's1', cols: 80 })).toThrow(
      /missing key "rows"/,
    );
    expect(() =>
      parseResizeRequest({ sessionId: 's1', cols: 80, rows: 24, pixel: 1 }),
    ).toThrow(/unexpected key/);
    expect(() => parseResizeRequest({ sessionId: [], cols: 80, rows: 24 })).toThrow(
      /expected a string/,
    );
  });
});

describe('parseKillRequest', () => {
  it('accepts a bare session id', () => {
    expect(parseKillRequest('sess-1')).toBe('sess-1');
  });

  it('rejects a non-string, an empty string, and a malformed id', () => {
    expect(() => parseKillRequest(42)).toThrow(/expected a string/);
    expect(() => parseKillRequest('')).toThrow(/malformed id/);
    expect(() => parseKillRequest('../other')).toThrow(/malformed id/);
  });

  it('rejects an object masquerading as an id', () => {
    expect(() => parseKillRequest({ toString: () => 'sess-1' })).toThrow(
      /expected a string/,
    );
  });
});

describe('parseAddProjectRequest', () => {
  it('accepts a path alone and a path with a name', () => {
    expect(parseAddProjectRequest({ path: '/tmp/x' })).toEqual({ path: '/tmp/x' });
    expect(parseAddProjectRequest({ path: '/tmp/x', name: 'X' })).toEqual({
      path: '/tmp/x',
      name: 'X',
    });
  });

  it('does not create an own name key when none was sent', () => {
    // An `undefined`-valued own key would be written to the config file and
    // reported as unknown the next time it is read.
    expect(Object.keys(parseAddProjectRequest({ path: '/tmp/x' }))).toEqual(['path']);
  });

  it('rejects __proto__', () => {
    expect(() =>
      parseAddProjectRequest(JSON.parse('{"path":"/tmp/x","__proto__":{}}')),
    ).toThrow(/forbidden key/);
  });

  it('rejects a non-string path, a missing path, and an unexpected key', () => {
    expect(() => parseAddProjectRequest({ path: 7 })).toThrow(/expected a string/);
    expect(() => parseAddProjectRequest({})).toThrow(/missing key "path"/);
    expect(() => parseAddProjectRequest({ path: '/x', nope: 1 })).toThrow(
      /unexpected key/,
    );
  });

  it('rejects an empty or whitespace-only path', () => {
    expect(() => parseAddProjectRequest({ path: '' })).toThrow(/non-empty/);
    expect(() => parseAddProjectRequest({ path: '   ' })).toThrow(/non-empty/);
  });

  it('rejects an empty name', () => {
    expect(() => parseAddProjectRequest({ path: '/x', name: '' })).toThrow(
      /must not be empty/,
    );
  });

  /**
   * `name` is a display string, so it takes the bounded, control-character-free
   * guard rather than the deliberately permissive path one. A renderer that
   * skipped the dialog could otherwise persist an unbounded name into the
   * config, and control characters would reach a file the user hand-edits.
   */
  it('bounds the name and rejects control characters in it', () => {
    expect(() =>
      parseAddProjectRequest({ path: '/x', name: 'a'.repeat(4097) }),
    ).toThrow(/too long/);
    expect(() =>
      parseAddProjectRequest({ path: '/x', name: 'evil\u001b[2Jname' }),
    ).toThrow(/control characters/);
  });

  it('still accepts an unbounded path, which is about to be realpath-ed', () => {
    const deep = `/${'nested/'.repeat(700)}repo`;
    expect(parseAddProjectRequest({ path: deep }).path).toBe(deep);
  });
});

describe('parseRemoveProjectRequest', () => {
  it('accepts an id', () => {
    expect(parseRemoveProjectRequest({ id: 'the-hive' })).toEqual({ id: 'the-hive' });
  });

  it('rejects a malformed id, a missing id, and __proto__', () => {
    expect(() => parseRemoveProjectRequest({ id: '../etc' })).toThrow(/malformed id/);
    expect(() => parseRemoveProjectRequest({})).toThrow(/missing key "id"/);
    expect(() =>
      parseRemoveProjectRequest(JSON.parse('{"id":"a","__proto__":{}}')),
    ).toThrow(/forbidden key/);
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  IpcValidationError,
  parseKillRequest,
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

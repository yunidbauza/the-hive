import { describe, expect, it } from 'vitest';

import {
  assertRelPath,
  parseReadDirRequest,
  parseReadFileRequest,
  parseResolveRequest,
  parseSearchRequest,
  parseWatchRequest,
  parseWriteFileRequest,
} from '../../../electron/shared/guards';
import {
  MAX_FILE_BYTES,
  MAX_RESOLVE_CANDIDATES,
} from '../../../electron/shared/fs-contract';

/**
 * The fs payload guards.
 *
 * `assertRelPath` is the highest-value guard in the contract: every other path
 * is chosen through a native dialog or written into a file main owns, and this
 * one is composed by the renderer, once per click.
 *
 * It is **not** a complete defence and is not tested as one — a symlink is a
 * fact about the disk, not about the string, and that check lives in
 * `electron/main/fs/paths.ts`. What is pinned here is the half a string can
 * decide.
 */

describe('assertRelPath', () => {
  it('accepts the empty string, which means the project root', () => {
    expect(assertRelPath('', 'x')).toBe('');
  });

  it('accepts ordinary nested paths', () => {
    expect(assertRelPath('src/features/app.tsx', 'x')).toBe(
      'src/features/app.tsx',
    );
  });

  /**
   * A leading dot is a hidden file, not a traversal. Rejecting these would make
   * `.gitignore` and `.env.example` unopenable — two of the files this app is
   * most often used to read.
   */
  it('accepts dotfiles and names that merely begin with dots', () => {
    expect(assertRelPath('.gitignore', 'x')).toBe('.gitignore');
    expect(assertRelPath('.github/workflows/ci.yml', 'x')).toBe(
      '.github/workflows/ci.yml',
    );
    expect(assertRelPath('..hidden', 'x')).toBe('..hidden');
    expect(assertRelPath('src/..config.json', 'x')).toBe('src/..config.json');
  });

  it('rejects a POSIX absolute path', () => {
    expect(() => assertRelPath('/etc/passwd', 'x')).toThrow(/relative/);
  });

  it('rejects a Windows drive path and a UNC path', () => {
    expect(() => assertRelPath('C:\\Windows\\system32', 'x')).toThrow(/relative/);
    expect(() => assertRelPath('\\\\server\\share', 'x')).toThrow(/relative/);
  });

  it('rejects any parent segment, on either separator', () => {
    expect(() => assertRelPath('../secret', 'x')).toThrow(/leave the project/);
    expect(() => assertRelPath('src/../../secret', 'x')).toThrow(
      /leave the project/,
    );
    expect(() => assertRelPath('src\\..\\..\\secret', 'x')).toThrow(
      /leave the project/,
    );
    expect(() => assertRelPath('a/b/..', 'x')).toThrow(/leave the project/);
  });

  /**
   * NUL truncates a path inside libuv, so the string the guard inspected would
   * differ from the one the syscall receives.
   */
  it('rejects NUL and other control characters', () => {
    expect(() => assertRelPath('a\u0000/../../etc/passwd', 'x')).toThrow(
      /control characters/,
    );
    expect(() => assertRelPath('a\nb', 'x')).toThrow(/control characters/);
    expect(() => assertRelPath('a\u007fb', 'x')).toThrow(/control characters/);
  });

  it('rejects an unbounded path', () => {
    expect(() => assertRelPath('a'.repeat(1025), 'x')).toThrow(/too long/);
  });

  it('rejects a non-string', () => {
    expect(() => assertRelPath(42, 'x')).toThrow(/expected a string/);
    expect(() => assertRelPath(null, 'x')).toThrow(/expected a string/);
  });
});

describe('parseReadDirRequest', () => {
  it('accepts a well-formed request', () => {
    expect(parseReadDirRequest({ projectId: 'demo', relPath: 'src' })).toEqual({
      projectId: 'demo',
      relPath: 'src',
    });
  });

  it('rejects a missing key', () => {
    expect(() => parseReadDirRequest({ projectId: 'demo' })).toThrow(/relPath/);
  });

  it('rejects a malformed project id', () => {
    expect(() =>
      parseReadDirRequest({ projectId: '../..', relPath: '' }),
    ).toThrow(/malformed id/);
  });
});

describe('parseReadFileRequest', () => {
  it('accepts a well-formed request', () => {
    expect(parseReadFileRequest({ projectId: 'demo', relPath: 'a.ts' })).toEqual({
      projectId: 'demo',
      relPath: 'a.ts',
    });
  });

  it('rejects a traversal', () => {
    expect(() =>
      parseReadFileRequest({ projectId: 'demo', relPath: '../a.ts' }),
    ).toThrow(/leave the project/);
  });
});

describe('parseWriteFileRequest', () => {
  const valid = {
    projectId: 'demo',
    relPath: 'a.ts',
    text: 'export {};\n',
    baseMtimeMs: 1_700_000_000_000,
  };

  it('accepts a well-formed request', () => {
    expect(parseWriteFileRequest(valid)).toEqual(valid);
  });

  /**
   * `text` deliberately gets no control-character sweep. Source files contain
   * tabs, newlines and — in a fixture or an escape-sequence test — every byte
   * below 0x20. What makes the write safe is where it lands, not what it says.
   */
  it('accepts control characters in the file body', () => {
    const text = 'line\n\tindented\n\u001b[31mred\u001b[0m\n';
    expect(parseWriteFileRequest({ ...valid, text }).text).toBe(text);
  });

  it('rejects text over the size cap', () => {
    expect(() =>
      parseWriteFileRequest({ ...valid, text: 'a'.repeat(MAX_FILE_BYTES + 1) }),
    ).toThrow(/too large/);
  });

  it('rejects a non-finite base mtime', () => {
    expect(() => parseWriteFileRequest({ ...valid, baseMtimeMs: NaN })).toThrow(
      /finite number/,
    );
    expect(() =>
      parseWriteFileRequest({ ...valid, baseMtimeMs: Infinity }),
    ).toThrow(/finite number/);
    expect(() => parseWriteFileRequest({ ...valid, baseMtimeMs: '0' })).toThrow(
      /finite number/,
    );
  });

  it('rejects a missing base mtime rather than defaulting one', () => {
    // A write with no base cannot detect a conflict, which is the one thing
    // this verb exists to do.
    const { baseMtimeMs: _omitted, ...withoutBase } = valid;
    expect(() => parseWriteFileRequest(withoutBase)).toThrow(/baseMtimeMs/);
  });

  it('rejects an absolute destination', () => {
    expect(() =>
      parseWriteFileRequest({ ...valid, relPath: '/etc/passwd' }),
    ).toThrow(/relative/);
  });

  /**
   * Bytes, not UTF-16 units.
   *
   * `read.ts` caps on the file's size in bytes, so counting `.length` let
   * non-ASCII content through at up to three times the limit — and the editor
   * then refused to reopen the file it had just written.
   */
  it('rejects multi-byte text that fits the cap only when counted as units', () => {
    // Two bytes per character in UTF-8, so 600k characters is 1.2MB.
    const text = 'é'.repeat(600_000);
    expect(text.length).toBeLessThan(MAX_FILE_BYTES);

    expect(() => parseWriteFileRequest({ ...valid, text })).toThrow(/too large/);
  });

  it('accepts multi-byte text that fits the cap in bytes', () => {
    const text = 'é'.repeat(1000);
    expect(parseWriteFileRequest({ ...valid, text }).text).toBe(text);
  });
});

describe('parseWatchRequest', () => {
  it('accepts a project id', () => {
    expect(parseWatchRequest({ projectId: 'demo' })).toEqual({
      projectId: 'demo',
    });
  });

  it('rejects a malformed id', () => {
    expect(() => parseWatchRequest({ projectId: 'a/b' })).toThrow(/malformed id/);
  });
});


describe('parseSearchRequest', () => {
  const good = { projectId: 'nova-web', query: 'badge', mode: 'name' };

  it('accepts a name search and a text search', () => {
    expect(parseSearchRequest(good).mode).toBe('name');
    expect(parseSearchRequest({ ...good, mode: 'text' }).mode).toBe('text');
  });

  /**
   * An unknown mode would otherwise fall through to the content branch and
   * read every file in the project to answer a question nobody asked.
   */
  it('refuses a mode it does not know', () => {
    expect(() => parseSearchRequest({ ...good, mode: 'regex' })).toThrow();
    expect(() => parseSearchRequest({ ...good, mode: 1 })).toThrow();
  });

  /**
   * A search term is prose, so the guard bounds it rather than describing it —
   * the argument `parseSearchPrsRequest` already makes. Quotes and backslashes
   * are things people type; control characters are not.
   */
  it('takes an ordinary query, and refuses an empty or controlled one', () => {
    expect(parseSearchRequest({ ...good, query: 'a b "c" \\d' }).query).toBe(
      'a b "c" \\d',
    );
    expect(() => parseSearchRequest({ ...good, query: '' })).toThrow();
    expect(() =>
      parseSearchRequest({ ...good, query: `a${String.fromCharCode(7)}b` }),
    ).toThrow();
    expect(() =>
      parseSearchRequest({ ...good, query: 'x'.repeat(5000) }),
    ).toThrow();
  });

  it('carries an optional sessionId and refuses an unknown key', () => {
    expect(parseSearchRequest({ ...good, sessionId: 'sess-0z' }).sessionId).toBe(
      'sess-0z',
    );
    expect(() => parseSearchRequest({ ...good, relPath: '../etc' })).toThrow();
  });
});

/**
 * The one guard here that accepts absolute paths and `..` on purpose.
 *
 * A candidate is text a program printed, and containment in
 * `electron/main/fs/resolve.ts` is the defence — a string check that refused
 * `/abs/path` here would only stop the feature from working on the output
 * every compiler prints, while granting nothing, because main refuses the same
 * path a moment later on the evidence that actually settles it. What the
 * string still owns is what a string can decide: shape, count, length, and the
 * control characters no real path contains.
 */
describe('parseResolveRequest', () => {
  const good = { projectId: 'demo', candidates: ['src/a.ts', '/tmp/x', '../y'] };

  it('accepts relative, absolute and parent-relative candidates', () => {
    expect(parseResolveRequest(good)).toEqual(good);
  });

  it('carries an optional session id', () => {
    expect(parseResolveRequest({ ...good, sessionId: 'sess-1' }).sessionId).toBe(
      'sess-1',
    );
  });

  it('accepts an empty candidate list', () => {
    expect(
      parseResolveRequest({ projectId: 'demo', candidates: [] }).candidates,
    ).toEqual([]);
  });

  it('rejects more candidates than the cap', () => {
    const candidates = Array.from(
      { length: MAX_RESOLVE_CANDIDATES + 1 },
      (_unused, index) => `f${index}.ts`,
    );
    expect(() => parseResolveRequest({ projectId: 'demo', candidates })).toThrow(
      /too many/,
    );
  });

  it('rejects candidates that are not an array', () => {
    expect(() =>
      parseResolveRequest({ projectId: 'demo', candidates: 'src/a.ts' }),
    ).toThrow(/expected an array/);
  });

  /**
   * `.map` skips holes, so a sparse array would walk past every per-element
   * check below and come back as a `string[]` of `undefined`s with nothing
   * thrown — and `v8.serialize`, the channel this actually crosses, preserves
   * holes. The same trap `parseSkillFileDropRequest` and
   * `parseReorderProjectsRequest` document.
   */
  it('rejects a sparse array, whose holes would otherwise skip every check', () => {
    expect(() =>
      parseResolveRequest({ projectId: 'demo', candidates: new Array(2) }),
    ).toThrow(/expected a string/);
  });

  it('rejects a non-string, an empty string and a control character', () => {
    expect(() =>
      parseResolveRequest({ projectId: 'demo', candidates: [1] }),
    ).toThrow(/expected a string/);
    expect(() =>
      parseResolveRequest({ projectId: 'demo', candidates: [''] }),
    ).toThrow(/empty/);
    expect(() =>
      parseResolveRequest({ projectId: 'demo', candidates: ['a\u0000b'] }),
    ).toThrow(/control characters/);
    expect(() =>
      parseResolveRequest({ projectId: 'demo', candidates: ['a\u001bb'] }),
    ).toThrow(/control characters/);
    expect(() =>
      parseResolveRequest({ projectId: 'demo', candidates: ['a\u007fb'] }),
    ).toThrow(/control characters/);
    // U+009B is the 8-bit CSI introducer, and terminal output is where these
    // candidates come from. Four of the five sweeps in this file reject C1.
    expect(() =>
      parseResolveRequest({ projectId: 'demo', candidates: ['a\u009bb'] }),
    ).toThrow(/control characters/);
  });

  it('rejects an over-long candidate', () => {
    expect(() =>
      parseResolveRequest({ projectId: 'demo', candidates: ['x'.repeat(1025)] }),
    ).toThrow(/too long/);
  });

  it('rejects a malformed project id and an unexpected key', () => {
    expect(() =>
      parseResolveRequest({ projectId: 'a/b', candidates: [] }),
    ).toThrow(/malformed id/);
    // Declaration order, the convention stated at `parseSkillFileWriteRequest`:
    // a doubly-wrong request reports the field named first in the shape.
    expect(() =>
      parseResolveRequest({ projectId: 'a/b', candidates: 'x' }),
    ).toThrow(/malformed id/);
    expect(() => parseResolveRequest({ ...good, relPath: 'x' })).toThrow(
      /unexpected key/,
    );
  });
});

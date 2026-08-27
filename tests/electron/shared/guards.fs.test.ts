import { describe, expect, it } from 'vitest';

import {
  assertRelPath,
  parseReadDirRequest,
  parseReadFileRequest,
  parseSearchRequest,
  parseWatchRequest,
  parseWriteFileRequest,
} from '../../../electron/shared/guards';
import { MAX_FILE_BYTES } from '../../../electron/shared/fs-contract';

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

import { describe, expect, it } from 'vitest';

import { findCandidates, splitPosition } from '@lib/terminal/file-links';

/**
 * What in a line of terminal output *might* be a file.
 *
 * Deliberately generous: main decides what is on disk, so a false positive
 * here costs one `null` in a round trip that was already being made, while a
 * false negative is a path the user can see and cannot click. The table is the
 * output formats that actually matter — vitest, tsc, eslint, git, Claude Code
 * — plus the prose that must not light up on its own.
 */
const texts = (line: string) => findCandidates(line).map((c) => c.text);

describe('findCandidates', () => {
  it.each([
    ['vitest frame', ' ❯ src/stores/editor-store.ts:291:7', ['src/stores/editor-store.ts:291:7']],
    ['tsc', "src/app.ts(12,7): error TS2322: Type 'x'", ['src/app.ts(12,7)']],
    ['eslint position row', '  14:3  error  no-unused-vars', []],
    ['eslint file header', '/Users/me/repo/src/a.ts', ['/Users/me/repo/src/a.ts']],
    ['git diff --stat', ' src/stores/editor-store.ts  | 12 ++++--', ['src/stores/editor-store.ts']],
    ['claude reading', '● Read docs/terminal-architecture.md', ['docs/terminal-architecture.md']],
    ['dot-relative', 'cat ./README.md ../x/y.json', ['./README.md', '../x/y.json']],
    ['home', 'Skipping ~/.claude/settings.json', ['~/.claude/settings.json']],
    ['bare file with extension', 'wrote package.json', ['package.json']],
    ['directory with a slash', 'cd src/lib', ['src/lib']],
    ['line only', 'at a.ts:12', ['a.ts:12']],
    [
      'trailing punctuation stays outside',
      'see src/a.ts. and (src/b.ts), "src/c.ts"',
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    ],
    ['prose', 'and/or either http/https', ['and/or', 'http/https']],
    ['url is left to the web-links addon', 'open https://claude.ai/code/artifact/x', []],
    ['bare words never', 'Test Files 1 failed', []],
    ['windows drive never', String.raw`C:\Users\x\a.ts`, []],
  ])('%s', (_name, line, expected) => {
    expect(texts(line)).toEqual(expected);
  });

  it('reports 0-based, end-exclusive columns', () => {
    expect(findCandidates(' ❯ src/a.ts:1')).toEqual([
      { text: 'src/a.ts:1', start: 3, end: 13 },
    ]);
  });
});

describe('splitPosition', () => {
  it.each([
    ['src/a.ts', { path: 'src/a.ts' }],
    ['src/a.ts:12', { path: 'src/a.ts', line: 12 }],
    ['src/a.ts:12:7', { path: 'src/a.ts', line: 12, col: 7 }],
    ['src/a.ts(12,7)', { path: 'src/a.ts', line: 12, col: 7 }],
    ['src/a.ts:0', { path: 'src/a.ts' }],
    ['src/a.ts:12:0', { path: 'src/a.ts', line: 12 }],
  ])('%s', (text, expected) => {
    expect(splitPosition(text)).toEqual(expected);
  });
});

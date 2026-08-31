import { describe, expect, it } from 'vitest';

import {
  defaultRungFor,
  matches,
  rungsFor,
  summarise,
} from '@shared/permission-rules';

describe('matches', () => {
  it('lets the blanket rule match anything', () => {
    expect(matches('*', 'Bash', { command: 'rm -rf /' })).toBe(true);
  });

  it('treats a bare tool name as every call to that tool', () => {
    expect(matches('Bash', 'Bash', { command: 'anything' })).toBe(true);
    expect(matches('Bash', 'Read', { file_path: '/a' })).toBe(false);
  });

  it('matches a Bash specifier as a prefix glob over the command', () => {
    expect(matches('Bash(git *)', 'Bash', { command: 'git push origin main' })).toBe(true);
    expect(matches('Bash(git *)', 'Bash', { command: 'npm test' })).toBe(false);
  });

  it('does not let a specifier match a different tool', () => {
    expect(matches('Bash(git *)', 'Read', { command: 'git push' })).toBe(false);
  });

  it('matches a path specifier against file_path', () => {
    expect(matches('Read(/repo/src/**)', 'Read', { file_path: '/repo/src/a/b.ts' })).toBe(true);
    expect(matches('Read(/repo/src/**)', 'Read', { file_path: '/repo/docs/x.md' })).toBe(false);
  });

  it('matches a WebFetch domain specifier against the url host', () => {
    expect(
      matches('WebFetch(domain:github.com)', 'WebFetch', { url: 'https://github.com/a/b' }),
    ).toBe(true);
    expect(
      matches('WebFetch(domain:github.com)', 'WebFetch', { url: 'https://evil.test/x' }),
    ).toBe(false);
  });

  it('globs only the tool segment of an mcp name', () => {
    expect(matches('mcp__hive__*', 'mcp__hive__ledger_read', {})).toBe(true);
    expect(matches('mcp__hive__*', 'mcp__other__ledger_read', {})).toBe(false);
  });

  it('refuses a malformed rule rather than matching wildly', () => {
    expect(matches('', 'Bash', { command: 'x' })).toBe(false);
    expect(matches('Bash(', 'Bash', { command: 'x' })).toBe(false);
  });
});

describe('rungsFor', () => {
  it('offers once, the command family, and the whole tool for Bash', () => {
    const rungs = rungsFor('Bash', { command: 'git push origin main' });
    expect(rungs.map((rung) => rung.id)).toEqual(['allow-once', 'allow-family', 'allow-tool']);
    expect(rungs[1]?.label).toBe('git *');
    expect(rungs[1]?.rule).toBe('Bash(git *)');
    expect(rungs[2]?.rule).toBe('Bash');
    expect(rungs[0]?.rule).toBeUndefined();
  });

  it('uses the domain as the family for WebFetch', () => {
    const rungs = rungsFor('WebFetch', { url: 'https://github.com/a/b' });
    expect(rungs[1]?.rule).toBe('WebFetch(domain:github.com)');
  });

  it('uses the containing directory as the family for a file tool', () => {
    const rungs = rungsFor('Read', { file_path: '/repo/src/a.ts' });
    expect(rungs[1]?.rule).toBe('Read(/repo/src/**)');
  });

  it('drops the family rung for a tool with no specifier', () => {
    const rungs = rungsFor('TodoWrite', {});
    expect(rungs.map((rung) => rung.id)).toEqual(['allow-once', 'allow-tool']);
  });

  it('drops the family rung rather than emit a rule containing a comma', () => {
    const rungs = rungsFor('Bash', { command: 'weird,name --flag' });
    expect(rungs.every((rung) => !(rung.rule ?? '').includes(','))).toBe(true);
  });

  it('drops the family rung when a path has no directory to name', () => {
    const rungs = rungsFor('Read', { file_path: 'notes.md' });
    expect(rungs.map((rung) => rung.id)).toEqual(['allow-once', 'allow-tool']);
  });

  it('gives every rung a caption', () => {
    for (const rung of rungsFor('Bash', { command: 'git push' })) {
      expect(rung.caption.length).toBeGreaterThan(0);
    }
  });
});

describe('defaultRungFor', () => {
  it('prefers the family rung so one click settles the question', () => {
    expect(defaultRungFor(rungsFor('Bash', { command: 'git push' }))).toBe('allow-family');
  });

  it('falls back to the whole tool when there is no family', () => {
    expect(defaultRungFor(rungsFor('TodoWrite', {}))).toBe('allow-tool');
  });
});

describe('summarise', () => {
  it('names the command for Bash', () => {
    expect(summarise('Bash', { command: 'git push origin main' })).toContain('git push origin main');
  });

  it('says something legible for a tool it has no special case for', () => {
    expect(summarise('TodoWrite', {}).length).toBeGreaterThan(0);
  });
});

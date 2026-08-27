import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_FILE_BYTES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_LINES_PER_FILE,
} from '@shared/fs-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveExisting } = vi.hoisted(() => ({ resolveExisting: vi.fn() }));

vi.mock('../../../../electron/main/fs/paths', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveExisting,
}));

const { searchProject } = await import('../../../../electron/main/fs/search');

/**
 * The first thing in the fs layer that recurses.
 *
 * Against a **real temporary tree**, not a mocked one. The whole point of this
 * module is what it does to a directory — prune it, descend it, stop at a
 * bound — and a fake `readdir` would be asserting that the test's own idea of a
 * filesystem matches the code's. `resolveExisting` is the one thing stubbed,
 * because that is the containment guard and it needs a config this test has no
 * business building.
 */

let root: string;

const write = (relative: string, contents: string): void => {
  const absolute = join(root, relative);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents);
};

const search = (query: string, mode: 'name' | 'text' = 'text', now?: () => number) =>
  searchProject({ projectId: 'demo', query, mode }, now);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hive-search-'));
  resolveExisting.mockResolvedValue({ absolute: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('finding text', () => {
  beforeEach(() => {
    write('src/badge.tsx', "const tone = 'danger';\nexport { tone };\n");
    write('src/other.ts', 'const unrelated = 1;\n');
  });

  it('answers with the file, the line and the 1-based line number', async () => {
    const result = await search('danger');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits).toHaveLength(1);
    expect(result.value.hits[0]?.relPath).toBe('src/badge.tsx');
    expect(result.value.hits[0]?.lines[0]?.line).toBe(1);
    expect(result.value.hits[0]?.lines[0]?.text).toBe("const tone = 'danger';");
  });

  it('points the column at the match, after the leading whitespace is trimmed', async () => {
    write('src/indented.ts', '        const deep = 1;\n');

    const result = await search('deep');
    if (!result.ok) return;

    const hit = result.value.hits.find((entry) => entry.name === 'indented.ts');
    expect(hit?.lines[0]?.text).toBe('const deep = 1;');
    expect(hit?.lines[0]?.text.slice(hit.lines[0].column)).toMatch(/^deep/);
  });

  it('matches without regard to case', async () => {
    const result = await search('DANGER');
    if (!result.ok) return;
    expect(result.value.hits).toHaveLength(1);
  });

  /** A literal, never a pattern — see the module doc for why. */
  it('treats the query as a literal, not a regular expression', async () => {
    write('src/regex.ts', 'const a = 1;\n');

    const result = await search('.*');
    if (!result.ok) return;
    expect(result.value.hits).toHaveLength(0);
  });
});

describe('finding names', () => {
  beforeEach(() => {
    write('src/badge.tsx', 'nothing in here matches\n');
    write('src/nested/deep/badge-tone.ts', 'nor here\n');
  });

  it('matches the filename and reports no lines', async () => {
    const result = await search('badge', 'name');
    if (!result.ok) return;

    expect(result.value.hits.map((hit) => hit.relPath).sort()).toEqual([
      'src/badge.tsx',
      'src/nested/deep/badge-tone.ts',
    ]);
    expect(result.value.hits.every((hit) => hit.lines.length === 0)).toBe(true);
  });

  it('composes a project-relative path, so the editor keys it as the tree would', async () => {
    const result = await search('badge-tone', 'name');
    if (!result.ok) return;
    expect(result.value.hits[0]?.relPath).toBe('src/nested/deep/badge-tone.ts');
  });
});

describe('what it refuses to read', () => {
  it('never descends a hidden or generated directory', async () => {
    write('node_modules/pkg/index.js', 'const findme = 1;\n');
    write('.git/config', 'findme\n');
    write('dist/bundle.js', 'findme\n');
    write('src/real.ts', 'const findme = 1;\n');

    const result = await search('findme');
    if (!result.ok) return;

    expect(result.value.hits.map((hit) => hit.relPath)).toEqual(['src/real.ts']);
  });

  it('skips a file past the editor’s own size limit', async () => {
    write('src/huge.ts', `${'x'.repeat(MAX_FILE_BYTES + 1)}\nfindme\n`);
    write('src/small.ts', 'findme\n');

    const result = await search('findme');
    if (!result.ok) return;
    expect(result.value.hits.map((hit) => hit.name)).toEqual(['small.ts']);
  });

  it('skips a binary, by the same NUL sniff the editor uses', async () => {
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x66, 0x00, 0x66]));
    write('src/text.ts', 'f\n');

    const result = await search('f');
    if (!result.ok) return;
    expect(result.value.hits.some((hit) => hit.name === 'blob.bin')).toBe(false);
  });

  it('keeps going when one directory cannot be read', async () => {
    write('src/readable.ts', 'findme\n');
    mkdirSync(join(root, 'locked'), { mode: 0o000 });

    const result = await search('findme');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits).toHaveLength(1);

    // Restore so the temp dir can be removed.
    mkdirSync(join(root, 'locked'), { recursive: true, mode: 0o755 });
  });
});

describe('the bounds', () => {
  /**
   * Every cap here was invented for this verb — nothing in the fs layer
   * recursed before it — so each one gets a test that proves it stops the walk
   * *and* that `capped` says so.
   */
  it('caps the lines it returns per file, and reports the true total', async () => {
    const lines = Array.from({ length: 40 }, () => 'findme').join('\n');
    write('src/many.ts', `${lines}\n`);

    const result = await search('findme');
    if (!result.ok) return;

    expect(result.value.hits[0]?.lines).toHaveLength(MAX_SEARCH_LINES_PER_FILE);
    expect(result.value.hits[0]?.total).toBe(40);
  });

  it('stops at the file cap and says it was capped', async () => {
    for (let i = 0; i < MAX_SEARCH_FILES + 10; i += 1) {
      write(`src/f${i}.ts`, 'findme\n');
    }

    const result = await search('findme');
    if (!result.ok) return;

    expect(result.value.capped).toBe(true);
    expect(result.value.hits.length).toBeLessThanOrEqual(MAX_SEARCH_FILES);
  });

  it('gives up on the clock rather than hanging, and admits it', async () => {
    write('src/a.ts', 'findme\n');
    write('src/b.ts', 'findme\n');

    // A clock already past the budget on its second reading.
    let reading = 0;
    const now = (): number => {
      reading += 1;
      return reading === 1 ? 0 : 10_000;
    };

    const result = await search('findme', 'text', now);
    if (!result.ok) return;
    expect(result.value.capped).toBe(true);
  });

  it('walks nothing for a query below the floor', async () => {
    write('src/a.ts', 'a\n');

    const result = await search('a');
    if (!result.ok) return;

    expect(result.value.hits).toHaveLength(0);
    expect(result.value.capped).toBe(false);
    // The guard is the point: `resolveExisting` is never even reached.
    expect(resolveExisting).not.toHaveBeenCalled();
  });
});

describe('failure', () => {
  it('answers with an error rather than throwing across IPC', async () => {
    resolveExisting.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'EPROJECT' }),
    );

    const result = await search('findme');
    expect(result.ok).toBe(false);
  });
});

// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '../../../../electron/shared/config-contract';
import { MAX_FILE_BYTES } from '../../../../electron/shared/fs-contract';

/**
 * The read verbs, against real files.
 *
 * The hidden-list filter, the binary sniff and the size cap are all decisions
 * about bytes on disk; a mocked `fs` would let each of them pass while
 * asserting nothing about the thing they exist to handle.
 */

const projects: ProjectConfig[] = [];

vi.mock('../../../../electron/main/config', () => ({
  getConfig: () => ({ projects }),
}));

const { readDirectory, readFileContent } = await import(
  '../../../../electron/main/fs/read'
);

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-fs-read-')));
  projects.length = 0;
  projects.push({
    id: 'demo',
    name: 'demo',
    path: root,
    icon: 'ph-folder',
    origin: 'local',
    status: 'ok',
    isRepo: true,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  projects.length = 0;
});

describe('readDirectory', () => {
  it('lists files and directories with their kinds', async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'README.md'), '# hi\n');

    const result = await readDirectory({ projectId: 'demo', relPath: '' });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual(
      expect.arrayContaining([
        { name: 'src', kind: 'dir', size: 0 },
        { name: 'README.md', kind: 'file', size: 5 },
      ]),
    );
  });

  it('hides .git and the noise list, and shows every other dotfile', async () => {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.gitignore'), 'out\n');
    writeFileSync(join(root, '.env.example'), 'A=1\n');

    const result = await readDirectory({ projectId: 'demo', relPath: '' });
    const names = result.ok ? result.value.map((entry) => entry.name) : [];

    expect(names).not.toContain('.git');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('dist');
    // The point of the list: dotfiles are shown unless they are named.
    expect(names).toEqual(
      expect.arrayContaining(['.claude', '.gitignore', '.env.example']),
    );
  });

  /**
   * A `Dirent` reports a symlink as a symlink and nothing else, so a tree built
   * from one shows every linked package directory as an un-expandable file.
   * The extra `stat` is what buys the right kind.
   */
  it('reports a symlinked directory as a directory', async () => {
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'linked'));

    const result = await readDirectory({ projectId: 'demo', relPath: '' });
    const linked = result.ok
      ? result.value.find((entry) => entry.name === 'linked')
      : undefined;

    expect(linked?.kind).toBe('dir');
  });

  it('drops a broken symlink rather than failing the listing', async () => {
    writeFileSync(join(root, 'keep.txt'), 'x');
    symlinkSync(join(root, 'gone'), join(root, 'dangling'));

    const result = await readDirectory({ projectId: 'demo', relPath: '' });
    const names = result.ok ? result.value.map((entry) => entry.name) : [];

    expect(names).toContain('keep.txt');
    expect(names).not.toContain('dangling');
  });

  it('answers with a failure rather than throwing', async () => {
    const result = await readDirectory({ projectId: 'demo', relPath: 'nope' });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('ENOENT');
  });

  it('refuses an unknown project', async () => {
    const result = await readDirectory({ projectId: 'other', relPath: '' });
    expect(!result.ok && result.error.code).toBe('EPROJECT');
  });
});

describe('readFileContent', () => {
  it('reads text with its mtime and size', async () => {
    writeFileSync(join(root, 'a.ts'), 'export {};\n');

    const result = await readFileContent({ projectId: 'demo', relPath: 'a.ts' });

    expect(result.ok).toBe(true);
    if (!result.ok || 'refused' in result.value) throw new Error('expected content');
    expect(result.value.text).toBe('export {};\n');
    expect(result.value.size).toBe(11);
    expect(result.value.mtimeMs).toBeGreaterThan(0);
  });

  it('reads an empty file without calling it binary', async () => {
    writeFileSync(join(root, 'empty.txt'), '');

    const result = await readFileContent({
      projectId: 'demo',
      relPath: 'empty.txt',
    });

    expect(result.ok && 'text' in result.value && result.value.text).toBe('');
  });

  /**
   * A refusal is a **success** at the transport level. The panel renders it as
   * a decline, not as an error, and collapsing the two would make "this file is
   * a PNG" read as "something went wrong".
   */
  it('refuses a binary file as a success, not an error', async () => {
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x1a]));

    const result = await readFileContent({
      projectId: 'demo',
      relPath: 'blob.bin',
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toMatchObject({ refused: 'binary', size: 4 });
  });

  it('refuses a file over the cap, and reports its size', async () => {
    const big = 'a'.repeat(MAX_FILE_BYTES + 1);
    writeFileSync(join(root, 'big.txt'), big);

    const result = await readFileContent({ projectId: 'demo', relPath: 'big.txt' });

    expect(result.ok && result.value).toMatchObject({
      refused: 'too-large',
      size: MAX_FILE_BYTES + 1,
    });
  });

  /**
   * Size is checked before the sniff, so a huge binary reports the fact the
   * user can act on rather than the one they cannot.
   */
  it('prefers too-large over binary when both apply', async () => {
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 10);
    buffer[0] = 0;
    writeFileSync(join(root, 'huge.bin'), buffer);

    const result = await readFileContent({
      projectId: 'demo',
      relPath: 'huge.bin',
    });

    expect(result.ok && result.value).toMatchObject({ refused: 'too-large' });
  });

  it('refuses a directory with EISDIR', async () => {
    mkdirSync(join(root, 'src'));

    const result = await readFileContent({ projectId: 'demo', relPath: 'src' });

    expect(!result.ok && result.error.code).toBe('EISDIR');
  });

  it('refuses a file outside the project through a symlink', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'hive-fs-out-')));
    writeFileSync(join(outside, 'secret.txt'), 'nope\n');
    symlinkSync(outside, join(root, 'link'));

    const result = await readFileContent({
      projectId: 'demo',
      relPath: 'link/secret.txt',
    });

    expect(!result.ok && result.error.code).toBe('EOUTSIDE');
    rmSync(outside, { recursive: true, force: true });
  });
});

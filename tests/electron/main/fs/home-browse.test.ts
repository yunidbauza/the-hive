import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { browseHomeDirectory } from '../../../../electron/main/fs/home-browse';

/**
 * The home directory is the fence, so a test that could not move it would be
 * asserting against whichever machine it runs on.
 *
 * `$HOME` is set rather than `node:os` mocked, which is the pattern
 * `tests/electron/main/config/index.test.ts` established: `os.homedir()`
 * honours `$HOME` on POSIX, the platform this app ships for, so there is no
 * mock that could drift from the real function.
 *
 * Everything below touches actual disk, including the symlinks, because the
 * property under test is what `realpath` resolves to and no in-memory fake can
 * stand in for that.
 */

let home: string;
let originalHome: string | undefined;
const outsides: string[] = [];

/** A directory that is definitely not under `home`. */
async function outside(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hive-outside-')));
  outsides.push(dir);
  return dir;
}

beforeEach(async () => {
  // `realpath` because macOS puts /var/folders behind a /private symlink, and
  // the module resolves home the same way — without it every containment check
  // here would compare a resolved path against an unresolved root and fail for
  // a reason that has nothing to do with the code.
  home = await realpath(await mkdtemp(join(tmpdir(), 'hive-browse-')));
  originalHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(home, { recursive: true, force: true });
  for (const dir of outsides.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('browseHomeDirectory', () => {
  it('lists home when the path is empty', async () => {
    await mkdir(join(home, 'Projects'));

    const result = await browseHomeDirectory({ path: '' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe(home);
    expect(result.value.home).toBe(home);
    expect(result.value.parent).toBeNull();
    expect(result.value.entries.map((entry) => entry.name)).toEqual(['Projects']);
  });

  it('resolves ~ to home', async () => {
    const result = await browseHomeDirectory({ path: '~' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe(result.value.home);
  });

  it('expands a ~/ prefix', async () => {
    await mkdir(join(home, 'Projects'));

    const result = await browseHomeDirectory({ path: '~/Projects' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe(join(home, 'Projects'));
  });

  it('offers directories and never files', async () => {
    await writeFile(join(home, 'notes.txt'), 'x');
    await writeFile(join(home, 'theme.json'), '{}');
    await mkdir(join(home, 'Projects'));

    const result = await browseHomeDirectory({ path: home });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries).toEqual([
      { name: 'Projects', path: join(home, 'Projects'), kind: 'directory', childCount: 0 },
    ]);
  });

  it('reports a parent for a directory below home', async () => {
    const nested = join(home, 'Projects', 'app');
    await mkdir(nested, { recursive: true });

    const result = await browseHomeDirectory({ path: nested });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.parent).toBe(join(home, 'Projects'));
  });

  it('sorts entries by name', async () => {
    for (const name of ['zebra', 'Alpha', 'mango']) {
      await mkdir(join(home, name));
    }

    const result = await browseHomeDirectory({ path: home });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((entry) => entry.name)).toEqual([
      'Alpha',
      'mango',
      'zebra',
    ]);
  });

  it('hides the entries the explorer hides', async () => {
    await mkdir(join(home, 'node_modules'));
    await mkdir(join(home, 'keep'));

    const result = await browseHomeDirectory({ path: home });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((entry) => entry.name)).toEqual(['keep']);
  });

  it('counts the visible children a folder would show', async () => {
    const parent = join(home, 'p');
    await mkdir(join(parent, 'a'), { recursive: true });
    await mkdir(join(parent, 'b'));
    await writeFile(join(parent, 'f.txt'), 'x');
    await mkdir(join(parent, 'node_modules'));

    const result = await browseHomeDirectory({ path: home });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Three: two directories and the file. Not the hidden entry — the count
    // has to match what opening the folder actually renders.
    expect(result.value.entries[0]).toMatchObject({ name: 'p', childCount: 3 });
  });

  describe('the fence', () => {
    it('refuses a path outside home', async () => {
      const elsewhere = await outside();

      const result = await browseHomeDirectory({ path: elsewhere });

      expect(result).toEqual({
        ok: false,
        error: { code: 'EOUTSIDE', message: 'cannot browse that path' },
      });
    });

    /**
     * The prefix bug `contains()` exists for, reached through this verb.
     * Without the separator-suffixed comparison, a sibling directory whose
     * name merely starts with home's would be inside it.
     */
    it('refuses a sibling whose name merely starts with home', async () => {
      const sibling = `${home}-secrets`;
      await mkdir(sibling);
      outsides.push(sibling);

      const result = await browseHomeDirectory({ path: sibling });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EOUTSIDE');
    });

    it('refuses traversal out through ..', async () => {
      const result = await browseHomeDirectory({ path: join(home, '..') });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EOUTSIDE');
    });

    it('refuses a relative path rather than resolving it against cwd', async () => {
      const result = await browseHomeDirectory({ path: 'Projects' });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EOUTSIDE');
    });

    it('refuses following a symlink that leaves home', async () => {
      const elsewhere = await outside();
      const link = join(home, 'escape');
      await symlink(elsewhere, link, 'dir');

      const result = await browseHomeDirectory({ path: link });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EOUTSIDE');
    });

    /**
     * The second half of the fence, and the reason it is not redundant. If an
     * escaping symlink were listed, the very next call would refuse the path
     * this module had just offered — which reads as a broken picker rather
     * than a fence doing its job.
     */
    it('does not offer an escaping symlink as an entry', async () => {
      const elsewhere = await outside();
      await symlink(elsewhere, join(home, 'escape'), 'dir');
      await mkdir(join(home, 'real'));

      const result = await browseHomeDirectory({ path: home });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.entries.map((entry) => entry.name)).toEqual(['real']);
    });

    it('does offer a symlink that stays inside home', async () => {
      await mkdir(join(home, 'real'));
      await symlink(join(home, 'real'), join(home, 'alias'), 'dir');

      const result = await browseHomeDirectory({ path: home });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.entries.map((entry) => entry.name)).toEqual([
        'alias',
        'real',
      ]);
    });

    it('refuses a file, even one inside home', async () => {
      await writeFile(join(home, 'notes.txt'), 'x');

      const result = await browseHomeDirectory({ path: join(home, 'notes.txt') });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EOUTSIDE');
    });
  });

  it('answers a failure rather than throwing for a missing directory', async () => {
    const result = await browseHomeDirectory({ path: join(home, 'nope') });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ENOENT');
  });
});

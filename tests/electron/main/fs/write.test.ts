// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '../../../../electron/shared/config-contract';

/**
 * The write verb, and the conflict check that is the whole reason it is not a
 * one-liner.
 *
 * mtimes are set explicitly with `utimesSync` rather than by writing and
 * hoping: a test that depended on two real writes landing in different
 * filesystem timestamp ticks would be flaky on exactly the coarse-resolution
 * filesystems the check is weakest on.
 */

const projects: ProjectConfig[] = [];

vi.mock('../../../../electron/main/config', () => ({
  getConfig: () => ({ projects }),
}));

const { writeFileContent } = await import('../../../../electron/main/fs/write');

let root: string;

const mtimeOf = (path: string): number => statSync(path).mtimeMs;

/** Move a file's mtime by a whole number of seconds, in either direction. */
function shiftMtime(path: string, seconds: number): void {
  const stats = statSync(path);
  const next = stats.mtime.getTime() / 1000 + seconds;
  utimesSync(path, next, next);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-fs-write-')));
  projects.length = 0;
  projects.push({
    id: 'demo',
    name: 'demo',
    path: root,
    icon: 'ph-folder',
    origin: 'local',
    status: 'ok',
    key: 'demo',
    isRepo: true,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  projects.length = 0;
});

describe('writeFileContent', () => {
  it('writes when the base mtime still matches, and returns the new one', async () => {
    const file = join(root, 'a.ts');
    writeFileSync(file, 'old\n');

    const result = await writeFileContent({
      projectId: 'demo',
      relPath: 'a.ts',
      text: 'new\n',
      baseMtimeMs: mtimeOf(file),
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('new\n');
    // The next base comes from the filesystem, not from `Date.now()`.
    expect(result.ok && result.mtimeMs).toBe(mtimeOf(file));
  });

  it('refuses and writes nothing when the file moved on', async () => {
    const file = join(root, 'a.ts');
    writeFileSync(file, 'agent wrote this\n');
    const stale = mtimeOf(file) - 5000;

    const result = await writeFileContent({
      projectId: 'demo',
      relPath: 'a.ts',
      text: 'mine\n',
      baseMtimeMs: stale,
    });

    expect(result).toMatchObject({ ok: false, conflict: true });
    expect(readFileSync(file, 'utf8')).toBe('agent wrote this\n');
  });

  /**
   * `!==`, not `>`.
   *
   * A file restored from a backup or checked out by `git` can land with an
   * mtime *older* than the buffer's base. That is still a change the user has
   * not seen, and treating "older" as "unchanged" would overwrite it.
   */
  it('refuses when the file went backwards in time', async () => {
    const file = join(root, 'a.ts');
    writeFileSync(file, 'restored\n');
    const base = mtimeOf(file);
    shiftMtime(file, -60);

    const result = await writeFileContent({
      projectId: 'demo',
      relPath: 'a.ts',
      text: 'mine\n',
      baseMtimeMs: base,
    });

    expect(result).toMatchObject({ ok: false, conflict: true });
    expect(readFileSync(file, 'utf8')).toBe('restored\n');
  });

  it('reports the current mtime with the conflict, so an overwrite can succeed', async () => {
    const file = join(root, 'a.ts');
    writeFileSync(file, 'theirs\n');

    const refused = await writeFileContent({
      projectId: 'demo',
      relPath: 'a.ts',
      text: 'mine\n',
      baseMtimeMs: 1,
    });

    expect(refused).toMatchObject({ ok: false, conflict: true });
    const fresh = !refused.ok && refused.conflict ? refused.mtimeMs : 0;

    const retried = await writeFileContent({
      projectId: 'demo',
      relPath: 'a.ts',
      text: 'mine\n',
      baseMtimeMs: fresh,
    });

    expect(retried.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('mine\n');
  });

  it('refuses a directory with EISDIR', async () => {
    mkdirSync(join(root, 'src'));

    const result = await writeFileContent({
      projectId: 'demo',
      relPath: 'src',
      text: 'x',
      baseMtimeMs: 0,
    });

    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && !result.conflict && result.error.code).toBe('EISDIR');
  });

  it('refuses to create a file that does not exist yet', async () => {
    // Creation is not a verb this feature has: the tree reads, and the terminal
    // is where the filesystem is mutated. A missing target is ENOENT from stat.
    const result = await writeFileContent({
      projectId: 'demo',
      relPath: 'new.ts',
      text: 'x',
      baseMtimeMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && !result.conflict && result.error.code).toBe('ENOENT');
  });

  it('refuses an unknown project', async () => {
    const result = await writeFileContent({
      projectId: 'other',
      relPath: 'a.ts',
      text: 'x',
      baseMtimeMs: 0,
    });

    expect(!result.ok && !result.conflict && result.error.code).toBe('EPROJECT');
  });
});

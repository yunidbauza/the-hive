// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveProject } from '../../../../electron/main/config/resolve';

/**
 * Path resolution and the fields derived from it (stories 090, 101).
 *
 * Real temporary directories, for the reason `index.test.ts` records: every
 * assertion here is about what the filesystem actually does, and a mock that
 * answers those questions encodes the assumption under test.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hive-resolve-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveProject — isRepo', () => {
  it('is true when .git is a directory', () => {
    const dir = join(root, 'repo');
    mkdirSync(join(dir, '.git'), { recursive: true });

    expect(resolveProject({ id: 'repo', path: dir }).isRepo).toBe(true);
  });

  /**
   * The case a `statSync(...).isDirectory()` check would get wrong.
   *
   * Inside a git worktree or a submodule, `.git` is a *file* holding a
   * `gitdir:` pointer. A directory-only check would report a perfectly real
   * repository — including the one this project is developed in — as not one.
   */
  it('is true when .git is a file — the worktree and submodule case', () => {
    const dir = join(root, 'wt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');

    expect(resolveProject({ id: 'wt', path: dir }).isRepo).toBe(true);
  });

  it('is false for a plain directory', () => {
    const dir = join(root, 'plain');
    mkdirSync(dir, { recursive: true });

    expect(resolveProject({ id: 'plain', path: dir }).isRepo).toBe(false);
  });

  it('is false when the path never resolved', () => {
    const resolved = resolveProject({ id: 'gone', path: join(root, 'nope') });

    expect(resolved.status).toBe('missing');
    expect(resolved.isRepo).toBe(false);
  });
});

describe('resolveProject — v1 upgrade defaults', () => {
  it('defaults name to the resolved basename, icon and origin to constants', () => {
    const dir = join(root, 'my-project');
    mkdirSync(dir, { recursive: true });

    const resolved = resolveProject({ id: 'my-project', path: dir });

    expect(resolved.name).toBe('my-project');
    expect(resolved.icon).toBe('ph-folder');
    expect(resolved.origin).toBe('local');
  });

  it('prefers the declared name, icon and origin', () => {
    const dir = join(root, 'my-project');
    mkdirSync(dir, { recursive: true });

    const resolved = resolveProject({
      id: 'my-project',
      path: dir,
      name: 'My Project',
      icon: 'ph-globe-hemisphere-west',
      origin: 'cloned',
    });

    expect(resolved.name).toBe('My Project');
    expect(resolved.icon).toBe('ph-globe-hemisphere-west');
    expect(resolved.origin).toBe('cloned');
  });

  it('falls back to the id when the path is unusable and no name was given', () => {
    expect(resolveProject({ id: 'ghost', path: 'relative/x' }).name).toBe('ghost');
  });

  it('keeps a declared name even when the path is unusable', () => {
    const resolved = resolveProject({
      id: 'ghost',
      path: 'relative/x',
      name: 'Ghost',
    });

    expect(resolved.status).toBe('not-absolute');
    expect(resolved.name).toBe('Ghost');
  });
});

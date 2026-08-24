// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveProject,
  resolveProjects,
} from '../../../../electron/main/config/resolve';

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

/**
 * Assigning project keys across the whole list (HIVE-94).
 *
 * `resolveProjects` rather than `resolveProject`, because uniqueness is a fact
 * about the *file* and a single entry cannot answer it. Real directories are
 * not needed here — a key is derived from the name, never from the filesystem —
 * so these use unresolvable paths on purpose and assert only the keys.
 */
describe('resolveProjects — keys', () => {
  const keysOf = (raws: Parameters<typeof resolveProjects>[0]) =>
    resolveProjects(raws, []).map((project) => project.key);

  it('generates a key for every entry that has none', () => {
    expect(
      keysOf([
        { id: 'the-hive', path: '/x/the-hive' },
        { id: 'incorpx-server', path: '/x/incorpx-server' },
        { id: 'ai-sdk', path: '/x/ai-sdk' },
      ]),
    ).toEqual(['hive', 'is', 'as']);
  });

  it('prefers a declared key and generates around it', () => {
    expect(
      keysOf([
        { id: 'a', path: '/x/a', name: 'incorpx-server' },
        { id: 'b', path: '/x/b', name: 'incorpx-sdk', key: 'is' },
      ]),
    ).toEqual(['ise', 'is']);
  });

  /**
   * Every declared key is claimed **before** a single one is generated.
   *
   * Otherwise a generated key could take a literal one out from under an entry
   * further down the file, which would make the keys depend on where in the
   * list a project happened to sit — and the entry that *declared* its key
   * would be the one that lost it.
   */
  it('never lets a generated key steal a declared one further down', () => {
    const keys = keysOf([
      { id: 'a', path: '/x/a', name: 'hive' },
      { id: 'b', path: '/x/b', name: 'something-else', key: 'hive' },
    ]);

    expect(keys[1]).toBe('hive');
    expect(keys[0]).not.toBe('hive');
  });

  /**
   * A generated key must not shadow another project's **id**.
   *
   * The regression this pins, which shipped in review: project A at `~/repos/web`
   * (id `web`) is renamed to "Frontend", so its own key derives as `fro` and
   * leaves `web` free. Adding "Web Extension Builder" then minted exactly `web`
   * — and because `resolveProjectRef` tries key before id, `spawn web` stopped
   * meaning A and silently started an agent in B, with no warning anywhere.
   */
  it('never mints a key that is already another project’s id', () => {
    const keys = keysOf([
      { id: 'web', path: '/x/web', name: 'Frontend' },
      { id: 'web-extension-builder', path: '/x/b', name: 'Web Extension Builder' },
    ]);

    expect(keys[1]).not.toBe('web');
    expect(new Set(keys).size).toBe(2);
  });

  it('never mints a key that is already another project’s name', () => {
    // Same hazard through the third field: a project called "Hive" would become
    // unreachable by name the moment another project held the key `hive`.
    const keys = keysOf([
      { id: 'a', path: '/x/a', name: 'Hive' },
      { id: 'the-hive', path: '/x/b', name: 'The Hive' },
    ]);

    expect(keys[1]).not.toBe('hive');
  });

  /*
    A key the file *declares* is honoured even when it shadows something. It is
    the user's explicit choice in their own file, and silently regenerating it is
    the one thing `parse.ts` refuses to do with a key.
  */
  it('leaves a declared key alone even when it shadows another id', () => {
    expect(
      keysOf([
        { id: 'web', path: '/x/web', name: 'Frontend' },
        { id: 'b', path: '/x/b', name: 'Beta', key: 'web' },
      ])[1],
    ).toBe('web');
  });

  it('does not treat a project’s own id or name as blocking its own key', () => {
    // `hive` is this project's own id; answering to itself under two fields is
    // not a collision with anything.
    expect(keysOf([{ id: 'hive', path: '/x/hive', name: 'hive' }])).toEqual([
      'hive',
    ]);
  });

  /*
    A duplicate *key* is a typo in an alias, not two projects claiming to be the
    same project — so unlike a duplicate id it does not disable anything. The
    later entry is regenerated and the collision is reported.
  */
  it('regenerates a duplicate declared key and reports it', () => {
    const errors: string[] = [];
    const resolved = resolveProjects(
      [
        { id: 'a', path: '/x/a', key: 'ix' },
        { id: 'b', path: '/x/b', name: 'beta', key: 'ix' },
      ],
      errors,
    );

    expect(resolved[0].key).toBe('ix');
    expect(resolved[1].key).toBe('beta');
    expect(resolved[1].status).not.toBe('duplicate-id');
    expect(errors.some((error) => /duplicate key "ix" on "b"/.test(error))).toBe(
      true,
    );
  });

  it('gives every entry a key the pattern accepts, whatever the name', () => {
    const keys = keysOf([
      { id: 'a', path: '/x/a', name: '123' },
      { id: 'b', path: '/x/b', name: '—' },
      { id: 'c', path: '/x/c', name: 'x' },
    ]);

    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^[a-z]{2,4}$/);
  });
});

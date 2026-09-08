// @vitest-environment node
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BundleManifest } from '@shared/skills-contract';

import { readBundle } from '../../../../electron/main/skills/bundle';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hive-bundle-'));
  await writeFile(join(dir, 'SKILL.md'), '---\nname: x\n---\nbody\n', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const at = (m: BundleManifest, path: string) =>
  m.entries.find((entry) => entry.path === path);

describe('readBundle', () => {
  it('lists SKILL.md and every admitted file, with POSIX paths', async () => {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'build.py'), 'print(1)\n', 'utf8');

    const manifest = await readBundle(dir);

    expect(manifest.capped).toBeNull();
    expect(at(manifest, 'SKILL.md')?.excluded).toBeNull();
    expect(at(manifest, 'scripts')?.kind).toBe('directory');
    expect(at(manifest, 'scripts/build.py')?.excluded).toBeNull();
  });

  it('reports the owner-execute bit and reports 0 size for a directory', async () => {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf8');
    await chmod(join(dir, 'scripts', 'run.sh'), 0o755);

    const manifest = await readBundle(dir);

    expect(at(manifest, 'scripts/run.sh')?.executable).toBe(true);
    expect(at(manifest, 'SKILL.md')?.executable).toBe(false);
    expect(at(manifest, 'scripts')?.size).toBe(0);
    expect(at(manifest, 'scripts')?.executable).toBe(false);
  });

  it('lists a skipped name once and does not descend into it', async () => {
    await mkdir(join(dir, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'left-pad', 'index.js'), 'x', 'utf8');

    const manifest = await readBundle(dir);

    expect(at(manifest, 'node_modules')?.excluded).not.toBeNull();
    expect(at(manifest, 'node_modules/left-pad')).toBeUndefined();
    expect(at(manifest, 'node_modules/left-pad/index.js')).toBeUndefined();
  });

  it('excludes a file over the byte cap but still reports its size', async () => {
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(5_000_001), 'utf8');

    const entry = at(await readBundle(dir), 'big.bin');

    expect(entry?.excluded?.code).toBe('too-large');
    expect(entry?.size).toBe(5_000_001);
  });

  it('refuses a symlink inside the bundle rather than following it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'no', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'));

    const entry = at(await readBundle(dir), 'link.txt');

    expect(entry?.excluded?.code).toBe('symlink');
    expect(entry?.excluded?.reason).toMatch(/symlink/i);
    expect(entry?.kind).toBe('file');

    await rm(outside, { recursive: true, force: true });
  });

  /**
   * A symlink's real kind, not the hard-coded `'file'` every one used to
   * report (HIVE-148 review).
   *
   * Still excluded either way — a symlink is never copied — but the pane
   * renders `kind` before it renders `excluded`: a symlink to a directory
   * reported as `'file'` gave it a clickable row, and clicking called
   * `readFile`, which resolves the link and `stat`s a directory — `EISDIR`.
   * Reporting the real kind lets it render, correctly, as an (empty, since
   * this walk never descends through a link) folder instead.
   */
  it('reports a symlink to a directory as a directory, not a file', async () => {
    const target = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    await mkdir(join(target, 'inner'), { recursive: true });
    await symlink(target, join(dir, 'linked-dir'));

    const entry = at(await readBundle(dir), 'linked-dir');

    expect(entry?.kind).toBe('directory');
    expect(entry?.excluded?.code).toBe('symlink');

    await rm(target, { recursive: true, force: true });
  });

  it('reports a dangling symlink as a file, the historical default for one with nothing to ask', async () => {
    await symlink(join(dir, 'nonexistent.txt'), join(dir, 'dangling'));

    const entry = at(await readBundle(dir), 'dangling');

    expect(entry?.kind).toBe('file');
    expect(entry?.excluded?.code).toBe('symlink');
  });

  it('admits a folder at the depth limit and does not enumerate below it', async () => {
    await mkdir(join(dir, 'a', 'b', 'c', 'd'), { recursive: true });
    await writeFile(join(dir, 'a', 'b', 'c', 'd', 'deep.txt'), 'x', 'utf8');

    const manifest = await readBundle(dir);

    /*
      Four segments is the limit `assertSkillPath` enforces, so `a/b/c/d` is a
      path the pane can address and the mirror can create. What cannot exist is
      anything inside it, and that is reported once through `capped` rather than
      on a row for a folder that is itself fine.
    */
    expect(at(manifest, 'a/b/c/d')?.excluded).toBeNull();
    expect(at(manifest, 'a/b/c/d/deep.txt')).toBeUndefined();
    expect(manifest.capped).toMatch(/a\/b\/c\/d/);
  });

  it('leaves capped null when the deepest folder is empty', async () => {
    await mkdir(join(dir, 'a', 'b', 'c', 'd'), { recursive: true });

    const manifest = await readBundle(dir);

    expect(at(manifest, 'a/b/c/d')?.excluded).toBeNull();
    expect(manifest.capped).toBeNull();
  });

  it('caps the walk at 200 files and says so once', async () => {
    for (let i = 0; i < 260; i += 1) {
      await writeFile(join(dir, `f${String(i)}.txt`), 'x', 'utf8');
    }

    const manifest = await readBundle(dir);

    expect(manifest.capped).not.toBeNull();
    expect(manifest.entries.filter((e) => e.kind === 'file')).toHaveLength(200);
  });

  it('does not count a skipped name against the file cap', async () => {
    /*
      A fresh directory rather than the shared `dir` fixture: `dir` already
      holds `SKILL.md` from `beforeEach`, and folding that into "200 real
      files" would leave the arithmetic ambiguous about whether it is one of
      the 200 or an extra 201st file. Written on its own, exactly 200 real
      files plus the skipped `node_modules` is unambiguous: the counter must
      reach exactly 200 and stop, with nothing left to trip it. A budget that
      wrongly counted the skip toward 200 would run out one file early and
      cap on `node_modules` itself, since `node_modules` sorts after every
      `f*.txt` name.
    */
    const capDir = await mkdtemp(join(tmpdir(), 'hive-bundle-cap-'));
    await mkdir(join(capDir, 'node_modules'), { recursive: true });
    for (let i = 0; i < 200; i += 1) {
      await writeFile(join(capDir, `f${String(i)}.txt`), 'x', 'utf8');
    }

    const manifest = await readBundle(capDir);

    expect(manifest.capped).toBeNull();
    expect(manifest.entries.filter((e) => e.kind === 'file')).toHaveLength(200);

    await rm(capDir, { recursive: true, force: true });
  });

  it('answers an empty manifest for a folder that is not there', async () => {
    const manifest = await readBundle(join(dir, 'missing'));

    expect(manifest.entries).toEqual([]);
    expect(manifest.capped).toBeNull();
  });
});

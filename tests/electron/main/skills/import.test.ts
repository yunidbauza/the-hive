// @vitest-environment node
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyInto } from '../../../../electron/main/skills/import';

/**
 * Records every `mkdir`/`chmod` call `copyInto` makes, without changing what
 * they do. Two things in this file cannot be pinned by asserting the final
 * on-disk state alone:
 *
 * - Mode preservation: `fs.copyFile` already replicates the source file's
 *   mode on its own, so a test that only checks the final mode passes with
 *   `copyInto`'s own `chmod` call deleted — it would be asserting the OS, not
 *   the implementation.
 * - Ordering across two directory sources: every file write in the current
 *   design also `mkdir`s its own parent directory, so a scrambled `planned`
 *   order produces the identical final tree. Only the *sequence* of calls
 *   distinguishes the fix from the regression it replaced.
 */
const mkdirCalls: string[] = [];
const chmodCalls: { path: string; mode: number }[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (path: string, options?: unknown) => {
      mkdirCalls.push(path);
      return actual.mkdir(path, options as never);
    },
    chmod: async (path: string, mode: number) => {
      chmodCalls.push({ path, mode });
      return actual.chmod(path, mode);
    },
  };
});

let hiveDir: string;
let skillsDir: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'hive-import-'));
  hiveDir = join(base, 'hive-home');
  outside = join(base, 'outside');
  await mkdir(hiveDir, { recursive: true });
  await mkdir(outside, { recursive: true });

  /*
    `skillsRoot()` is `dirname(configPath())/skills`, and `configPath()` reads
    this variable on every call — the property that lets a test relocate the
    skills tree instead of writing into the developer's own.
  */
  process.env.HIVE_CONFIG_PATH = join(hiveDir, 'config.json');
  skillsDir = join(hiveDir, 'skills');

  // `resolveInSkill` calls `realpath` on the skill folder, which throws if it
  // is not there — so the bundle has to exist on disk before `copyInto` runs.
  await mkdir(join(skillsDir, 'graphify'), { recursive: true });

  mkdirCalls.length = 0;
  chmodCalls.length = 0;
});

afterEach(() => {
  delete process.env.HIVE_CONFIG_PATH;
});

describe('copyInto', () => {
  it('copies a chosen file into the target directory, and calls chmod with the mode it had', async () => {
    const source = join(outside, 'run.sh');
    await writeFile(source, '#!/bin/sh\n', 'utf8');
    await chmod(source, 0o755);

    await copyInto('graphify', 'scripts', [source]);

    const dest = join(skillsDir, 'graphify', 'scripts', 'run.sh');
    const mode = (await stat(dest)).mode;
    // An imported file keeps the mode it had. The shebang rule is for files the
    // pane writes, not for files that arrived with a mode of their own.
    expect(mode & 0o777).toBe(0o755);
    /*
      `fs.copyFile` already replicates the source's mode on its own, so the
      assertion above passes even with `copyInto`'s own `chmod` call deleted.
      This one does not: it fails unless `copyInto` itself calls `chmod(dest,
      0o755)`, independent of whatever `copyFile` already did.

      Compared against the `realpath`d form, not `dest` itself: `resolveInSkill`
      resolves the skill root through `realpath` before composing a
      destination, and on macOS `/var/folders/…` is itself a symlink to
      `/private/var/folders/…` — the two strings name the same file but are
      not `===`.
    */
    expect(chmodCalls).toContainEqual({ path: await realpath(dest), mode: 0o755 });
  });

  it('brings a dropped folder in whole, under the same walk', async () => {
    await mkdir(join(outside, 'references'), { recursive: true });
    await writeFile(join(outside, 'references', 'schema.json'), '{}', 'utf8');

    await copyInto('graphify', '', [join(outside, 'references')]);

    expect(
      await readFile(join(skillsDir, 'graphify', 'references', 'schema.json'), 'utf8'),
    ).toBe('{}');
  });

  it('refuses a skipped name at the door rather than copying then dimming it', async () => {
    await mkdir(join(outside, 'node_modules'), { recursive: true });
    await writeFile(join(outside, 'node_modules', 'x.js'), 'x', 'utf8');

    await expect(
      copyInto('graphify', '', [join(outside, 'node_modules')]),
    ).rejects.toThrow();

    await expect(stat(join(skillsDir, 'graphify', 'node_modules'))).rejects.toThrow();
  });

  it('writes nothing at all when one source is over a cap', async () => {
    await writeFile(join(outside, 'ok.txt'), 'fine', 'utf8');
    await writeFile(join(outside, 'big.bin'), Buffer.alloc(5_000_001));

    await expect(
      copyInto('graphify', '', [
        join(outside, 'ok.txt'),
        join(outside, 'big.bin'),
      ]),
    ).rejects.toThrow();

    /*
      The caps are applied before anything is written, so a refused batch leaves
      no half-copy behind. A user retrying after removing the big file should not
      find the small one already there under a folder they did not create.
    */
    await expect(stat(join(skillsDir, 'graphify', 'ok.txt'))).rejects.toThrow();
  });

  /**
   * Critical 1's exact reported scenario: a folder that is fine on its own
   * terms (four segments deep, counted from *its own* root, which is what
   * `readBundle`'s own cap sees) lands at five once it is placed under the
   * bundle root — `assertSkillPath` would refuse a request naming that path
   * directly, and nothing enforced the same rule against a path this module
   * composes from `dir` + a source's name + an entry's own path.
   */
  it('refuses a folder whose depth-with-prefix exceeds the cap, and leaves an already-shipping file untouched', async () => {
    await writeFile(
      join(skillsDir, 'graphify', 'zz-already-shipping.md'),
      'existing content',
      'utf8',
    );

    // `src/a/b/c/f.txt` — four segments from `src`'s own root (at the cap,
    // not over it), five once `src` itself is prefixed onto the bundle root.
    await mkdir(join(outside, 'src', 'a', 'b', 'c'), { recursive: true });
    await writeFile(join(outside, 'src', 'a', 'b', 'c', 'f.txt'), 'x', 'utf8');

    await expect(copyInto('graphify', '', [join(outside, 'src')])).rejects.toThrow();

    // Nothing from the refused drop landed at all...
    await expect(stat(join(skillsDir, 'graphify', 'src'))).rejects.toThrow();
    // ...and what was already shipping is untouched.
    expect(
      await readFile(join(skillsDir, 'graphify', 'zz-already-shipping.md'), 'utf8'),
    ).toBe('existing content');
  });

  /**
   * Critical 2: the cap is on the bundle, not on the batch. A batch that is
   * fine by itself must still be refused once what the bundle already holds
   * is counted.
   */
  it('refuses a batch that is fine alone but pushes the bundle itself past the file cap', async () => {
    for (let i = 0; i < 199; i += 1) {
      await writeFile(join(skillsDir, 'graphify', `existing-${String(i)}.txt`), 'x', 'utf8');
    }
    // The bundle holds 199 files. Two more would make 201 — over the 200 cap —
    // even though two files is nowhere near the cap on its own.
    await writeFile(join(outside, 'new-a.txt'), 'a', 'utf8');
    await writeFile(join(outside, 'new-b.txt'), 'b', 'utf8');

    await expect(
      copyInto('graphify', '', [join(outside, 'new-a.txt'), join(outside, 'new-b.txt')]),
    ).rejects.toThrow();

    await expect(stat(join(skillsDir, 'graphify', 'new-a.txt'))).rejects.toThrow();
    await expect(stat(join(skillsDir, 'graphify', 'new-b.txt'))).rejects.toThrow();
  });

  /**
   * Important 3: Finder writes `.DS_Store` into any folder it has displayed,
   * so a nested skipped name must not refuse the whole drop — only a
   * *top-level* source that is itself a skipped name gets the hard refusal.
   */
  it('skips a nested .DS_Store rather than refusing the whole dropped folder', async () => {
    await mkdir(join(outside, 'assets'), { recursive: true });
    await writeFile(join(outside, 'assets', 'logo.png'), 'binary-ish', 'utf8');
    await writeFile(join(outside, 'assets', '.DS_Store'), 'finder-junk', 'utf8');

    await copyInto('graphify', '', [join(outside, 'assets')]);

    expect(
      await readFile(join(skillsDir, 'graphify', 'assets', 'logo.png'), 'utf8'),
    ).toBe('binary-ish');
    await expect(
      stat(join(skillsDir, 'graphify', 'assets', '.DS_Store')),
    ).rejects.toThrow();
  });

  /**
   * Important 4: one rule for a symlink, not two. Nested is skipped like any
   * other excluded entry; top-level is refused, because the user named it
   * directly.
   */
  describe('symlinks', () => {
    it('skips a nested symlink rather than following it into the bundle', async () => {
      await mkdir(join(outside, 'secret'), { recursive: true });
      await writeFile(join(outside, 'secret', 'passwords.txt'), 'shh', 'utf8');
      await mkdir(join(outside, 'bundle-src'), { recursive: true });
      await writeFile(join(outside, 'bundle-src', 'real.txt'), 'real', 'utf8');
      await symlink(join(outside, 'secret'), join(outside, 'bundle-src', 'linkdir'));

      await copyInto('graphify', '', [join(outside, 'bundle-src')]);

      expect(
        await readFile(join(skillsDir, 'graphify', 'bundle-src', 'real.txt'), 'utf8'),
      ).toBe('real');
      await expect(
        stat(join(skillsDir, 'graphify', 'bundle-src', 'linkdir')),
      ).rejects.toThrow();
    });

    it('refuses a top-level symlink source rather than following it', async () => {
      await mkdir(join(outside, 'target-dir'), { recursive: true });
      await writeFile(join(outside, 'target-dir', 'inside.txt'), 'x', 'utf8');
      await symlink(join(outside, 'target-dir'), join(outside, 'linkdir'));

      await expect(copyInto('graphify', '', [join(outside, 'linkdir')])).rejects.toThrow();
      await expect(stat(join(skillsDir, 'graphify', 'linkdir'))).rejects.toThrow();
    });
  });

  /** Important 5: refuse rather than silently overwrite, `SKILL.md` included. */
  describe('overwrite refusal', () => {
    it('refuses a destination that already exists rather than replacing it', async () => {
      await writeFile(join(skillsDir, 'graphify', 'notes.md'), 'original', 'utf8');
      await writeFile(join(outside, 'notes.md'), 'replacement', 'utf8');

      await expect(copyInto('graphify', '', [join(outside, 'notes.md')])).rejects.toThrow();

      expect(
        await readFile(join(skillsDir, 'graphify', 'notes.md'), 'utf8'),
      ).toBe('original');
    });

    it('refuses to replace SKILL.md, even at a mode that would leave it executable', async () => {
      await writeFile(
        join(skillsDir, 'graphify', 'SKILL.md'),
        '---\nname: graphify\n---\noriginal\n',
        'utf8',
      );
      const forged = join(outside, 'SKILL.md');
      await writeFile(forged, 'forged manifest', 'utf8');
      await chmod(forged, 0o755);

      /*
        `isSkillManifest` true implies `pathExists` true — SKILL.md always
        exists on disk if it is the actual manifest — so the check cannot
        change *whether* this is refused, only *why*. Asserting the specific
        message is what makes this test fail if the `isSkillManifest` branch
        is ever removed, rather than passing on the generic "already exists"
        refusal underneath it.
      */
      await expect(copyInto('graphify', '', [forged])).rejects.toThrow(
        /SKILL\.md cannot be replaced/,
      );

      const stillThere = await readFile(join(skillsDir, 'graphify', 'SKILL.md'), 'utf8');
      expect(stillThere).toContain('original');
      const mode = (await stat(join(skillsDir, 'graphify', 'SKILL.md'))).mode;
      expect(mode & 0o111).toBe(0); // still not executable
    });
  });

  it('refuses two sources with the same basename in one batch, rather than letting the second silently win', async () => {
    await mkdir(join(outside, 'p'), { recursive: true });
    await mkdir(join(outside, 'q'), { recursive: true });
    await writeFile(join(outside, 'p', 'notes.md'), 'from p', 'utf8');
    await writeFile(join(outside, 'q', 'notes.md'), 'from q', 'utf8');

    await expect(
      copyInto('graphify', '', [
        join(outside, 'p', 'notes.md'),
        join(outside, 'q', 'notes.md'),
      ]),
    ).rejects.toThrow(/named twice/);

    // Total refusal: the first of the pair, processed before the collision
    // was found, must not have landed either.
    await expect(stat(join(skillsDir, 'graphify', 'notes.md'))).rejects.toThrow();
  });

  /**
   * A directory destination was never checked against the disk at all —
   * `assertDestinationFree` runs only on the two file branches. Driven with a
   * bundle already holding a *file* named `refs` and a batch of
   * `[first.txt, refs/]`: planning found nothing wrong (a directory
   * destination was simply never asked about), `first.txt` copied first, and
   * the write loop's own `mkdir('…/refs', { recursive: true })` then threw a
   * raw `EEXIST` naming the resolved host path — after `first.txt` was
   * already on disk, contradicting the refusal the caller received.
   */
  describe('directory destination collisions', () => {
    it('refuses a batch where a directory destination collides with an existing file, writing nothing at all', async () => {
      await writeFile(join(skillsDir, 'graphify', 'refs'), 'a file, not a folder', 'utf8');
      await writeFile(join(outside, 'first.txt'), 'first', 'utf8');
      await mkdir(join(outside, 'refs'), { recursive: true });
      await writeFile(join(outside, 'refs', 'inner.txt'), 'inner', 'utf8');

      await expect(
        copyInto('graphify', '', [join(outside, 'first.txt'), join(outside, 'refs')]),
      ).rejects.toThrow();

      // Total refusal: `first.txt` was planned and would have been written
      // *before* the colliding directory in the old, unguarded write loop.
      await expect(stat(join(skillsDir, 'graphify', 'first.txt'))).rejects.toThrow();
      // The pre-existing file is untouched, not silently replaced by a folder.
      expect(
        await readFile(join(skillsDir, 'graphify', 'refs'), 'utf8'),
      ).toBe('a file, not a folder');
    });

    /**
     * Reachable nested, not only at the top level: a bundle holding a file at
     * `a/b`, with a dropped folder `a` containing `b/c.txt`. `readBundle`
     * always lists a directory entry before its own children, so the `a/b`
     * directory entry is checked — and refused — before `b/c.txt` is ever
     * reached, rather than surfacing several segments later as a raw
     * `ENOTDIR` from a deeper `mkdir`.
     */
    it('refuses a nested directory collision several segments deep', async () => {
      await mkdir(join(skillsDir, 'graphify', 'a'), { recursive: true });
      await writeFile(join(skillsDir, 'graphify', 'a', 'b'), 'a file, not a folder', 'utf8');

      await mkdir(join(outside, 'a', 'b'), { recursive: true });
      await writeFile(join(outside, 'a', 'b', 'c.txt'), 'x', 'utf8');

      /*
        A clean sentence, not merely a rejection: this is what `mkdir`'s own
        `EEXIST`/`ENOTDIR` cannot produce on its own, so asserting the message
        (rather than only `.rejects.toThrow()`) is what proves this is caught
        at plan time by `assertDirectoryFree`, not by the raw failure the
        write loop's own `mkdir` would still surface even with no check here.
      */
      await expect(copyInto('graphify', '', [join(outside, 'a')])).rejects.toThrow(
        /already exists in this skill/,
      );

      await expect(
        stat(join(skillsDir, 'graphify', 'a', 'b', 'c.txt')),
      ).rejects.toThrow();
    });

    it('still merges a directory drop onto an existing directory of the same name', async () => {
      await mkdir(join(skillsDir, 'graphify', 'refs'), { recursive: true });
      await writeFile(join(skillsDir, 'graphify', 'refs', 'old.txt'), 'old', 'utf8');
      await mkdir(join(outside, 'refs'), { recursive: true });
      await writeFile(join(outside, 'refs', 'new.txt'), 'new', 'utf8');

      await copyInto('graphify', '', [join(outside, 'refs')]);

      expect(
        await readFile(join(skillsDir, 'graphify', 'refs', 'old.txt'), 'utf8'),
      ).toBe('old');
      expect(
        await readFile(join(skillsDir, 'graphify', 'refs', 'new.txt'), 'utf8'),
      ).toBe('new');
    });
  });

  /**
   * Important 8: an earlier draft `unshift`ed each folder's own entry onto
   * `planned`, which with two directory sources put the second folder's
   * mkdir ahead of the first folder's files. Reverting `planned.push` back to
   * `planned.unshift` at that line must turn this red.
   */
  it('preserves source order across two dropped folders', async () => {
    await mkdir(join(outside, 'alpha'), { recursive: true });
    await writeFile(join(outside, 'alpha', 'one.txt'), '1', 'utf8');
    await mkdir(join(outside, 'beta'), { recursive: true });
    await writeFile(join(outside, 'beta', 'two.txt'), '2', 'utf8');

    await copyInto('graphify', '', [join(outside, 'alpha'), join(outside, 'beta')]);

    // `realpath`d, for the reason the mode-preservation test above is:
    // `resolveInSkill` resolves the skill root through `realpath` before
    // composing a destination, and the raw and resolved forms are not `===`
    // when a tmp dir sits behind a symlink (macOS's `/var` -> `/private/var`).
    const alphaRoot = await realpath(join(skillsDir, 'graphify', 'alpha'));
    const betaRoot = await realpath(join(skillsDir, 'graphify', 'beta'));
    const alphaIndex = mkdirCalls.indexOf(alphaRoot);
    const betaIndex = mkdirCalls.indexOf(betaRoot);

    expect(alphaIndex).toBeGreaterThanOrEqual(0);
    expect(betaIndex).toBeGreaterThanOrEqual(0);
    expect(alphaIndex).toBeLessThan(betaIndex);

    expect(
      await readFile(join(skillsDir, 'graphify', 'alpha', 'one.txt'), 'utf8'),
    ).toBe('1');
    expect(
      await readFile(join(skillsDir, 'graphify', 'beta', 'two.txt'), 'utf8'),
    ).toBe('2');
  });

  /**
   * `path.join` normalises away a trailing `..` segment, so building this
   * source with `join` alone tests nothing — string concatenation is what
   * preserves the literal segment `basename()` (which does not normalise)
   * then reports.
   */
  it('refuses a source whose basename is ".." (built without join, which would normalise it away)', async () => {
    await mkdir(join(outside, 'sub'), { recursive: true });
    const trailingDotDot = `${join(outside, 'sub')}/..`;
    expect(trailingDotDot.endsWith('/..')).toBe(true);

    await expect(copyInto('graphify', '', [trailingDotDot])).rejects.toThrow();
  });

  /** Minor: a missing source is a sentence, not a raw ENOENT with a host path in it. */
  it('reports a missing source as a sentence rather than a raw ENOENT', async () => {
    await expect(
      copyInto('graphify', '', [join(outside, 'never-existed.txt')]),
    ).rejects.toThrow(/could not be found/);
  });

  /** Minor: `dir` naming an existing file is a sentence, not a raw EEXIST/ENOTDIR. */
  it('refuses a dir that names an existing file rather than a folder', async () => {
    await writeFile(join(skillsDir, 'graphify', 'notes.md'), 'x', 'utf8');
    await writeFile(join(outside, 'y.txt'), 'y', 'utf8');

    await expect(
      copyInto('graphify', 'notes.md', [join(outside, 'y.txt')]),
    ).rejects.toThrow(/not a folder/);
  });
});

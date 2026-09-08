import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { RESERVED_SKILL_NAME } from '@shared/skills-contract';

import { doneSkill } from './done-skill';
import type { SkillsRead } from './read';

/**
 * Generating the plugin directory `--plugin-dir` points at (HIVE-96).
 *
 * The directory is the app's, not the user's: regenerated from
 * `~/.hive/skills` at launch and again before every spawn, and safe to delete.
 * Nothing reads it but `claude`, and nothing writes it but this module.
 */

/**
 * The manifest that makes a directory a plugin.
 *
 * `skills: ['./skills/']` is declared rather than left to auto-discovery.
 * Auto-discovery may well work, but every real installed plugin on this machine
 * declares the field — matching what the binary is demonstrably given beats
 * relying on a default that is not ours to guarantee and would fail silently.
 */
const manifest = (version: string): string =>
  `${JSON.stringify(
    {
      name: 'hive',
      version,
      description: 'Skills The Hive injects into the sessions it starts.',
      skills: ['./skills/'],
    },
    null,
    2,
  )}\n`;

/**
 * Copy one file only when the destination differs, preserving its mode.
 *
 * Size, mtime and mode rather than a content hash: this runs before every
 * spawn, and hashing every file in every bundle to discover that nothing
 * changed would cost more than the copy it avoids. Size and mtime are the pair
 * `rsync` compares for the same reason; mode is added because this is also the
 * only place a mode change ever reaches the mirror, and without it a
 * `chmod +x` on a file whose bytes and mtime are unchanged would never
 * re-copy.
 *
 * `mtime.getTime()`, not `mtimeMs`. `utimes` takes a `Date`, and `Date` holds
 * whole milliseconds only, so the mtime this function sets on `to` always has
 * a zero fractional part. A filesystem that reports one on `from` — APFS does
 * — then never matches `mtimeMs`, and the skip would never fire: every
 * regeneration would `copyFile` (which truncates before rewriting) every file
 * in every bundle, on every spawn. `getTime()` applies the same truncation to
 * both sides of the comparison, so a source that has not moved compares equal
 * after this function is the one that set the destination's mtime.
 *
 * `mode & 0o777` on both sides, not raw `mode`, which also carries file-type
 * bits that are irrelevant here and would make the comparison meaningless.
 */
async function copyIfChanged(from: string, to: string): Promise<void> {
  const source = await stat(from);

  try {
    const destination = await stat(to);
    if (
      destination.size === source.size &&
      destination.mtime.getTime() === source.mtime.getTime() &&
      (destination.mode & 0o777) === (source.mode & 0o777)
    ) {
      return;
    }
  } catch {
    // Not there yet. Fall through and copy.
  }

  await copyFile(from, to);
  // `copyFile` does not carry the mode across. Without this a 755 script lands
  // 644 and the session cannot run it — the failure this story exists to fix,
  // moved one step later.
  await chmod(to, source.mode & 0o777);
  await utimes(to, source.atime, source.mtime);
}

/**
 * Clear whatever is at `path` when it exists and is not a `kind`.
 *
 * A stale `mkdir` throws `EEXIST` over a file that used to be a directory's
 * name, and a stale `copyFile` throws `EISDIR` over a directory that used to
 * be a file's name. Both are permanent: the copy phase below runs before
 * `prune`, so the stale entry is never cleared and every later regeneration
 * throws the same way — which, uncaught two frames up, drops `--plugin-dir`
 * from the spawn entirely and disables every skill, not just this one.
 *
 * `lstat`, not `stat`: a symlink is not a `kind` either way, which is what
 * stops a destination symlink named like an admitted path from surviving to
 * let `mkdir({ recursive: true })` or `copyFile` resolve through it and write
 * outside `pluginRoot`.
 */
async function ensureKind(
  path: string,
  kind: 'file' | 'directory',
): Promise<void> {
  let existing;
  try {
    existing = await lstat(path);
  } catch {
    return;
  }

  const matches =
    kind === 'directory' ? existing.isDirectory() : existing.isFile();
  if (!matches) {
    await rm(path, { recursive: true, force: true });
  }
}

/** Remove anything under `dir` that is not in `expected`, depth-first. */
async function prune(
  dir: string,
  expected: Set<string>,
  rel = '',
): Promise<void> {
  let listing;
  try {
    listing = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const item of listing) {
    const path = rel === '' ? item.name : `${rel}/${item.name}`;
    if (!expected.has(path)) {
      await rm(join(dir, item.name), { recursive: true, force: true });
      continue;
    }
    if (item.isDirectory()) {
      await prune(join(dir, item.name), expected, path);
    }
  }
}

/**
 * Regenerate the plugin directory from `read`.
 *
 * Modelled on `writeHookSettings` (`hooks/settings.ts`): generated up front so
 * that the spawn path *picks a path* rather than negotiating with a live
 * directory.
 *
 * ## Why stale removal is a diff rather than a wipe
 *
 * Deleting `skills/` and rewriting it would be shorter, and wrong. This runs
 * before **every** spawn, so regenerations and spawns interleave — and a wipe
 * leaves a window in which a session that is starting right now reads an empty
 * plugin. The diff only touches entries that should not be there, so a session
 * starting concurrently sees either the old set or the new one, never nothing.
 *
 * The corollary is that this is idempotent, which the tests assert directly:
 * running it twice with the same input must leave the same directory.
 *
 * ## Why this mirrors a folder rather than writing a file (HIVE-148)
 *
 * A skill is its whole folder. Writing only its SKILL.md delivered a command
 * whose first instruction ran a script that was not on disk, with no error on
 * either side. The diff argument above did not change; it got stronger. There
 * are more files to lose in the window a wipe would open, and a prune that
 * lies now has a subtree to delete rather than a file.
 *
 * `SKILL.md` itself is the one entry written directly from `skill.body`
 * rather than mirrored through the entry loop, the same way `/done` already
 * is. `readBundle` walks in name order and stops hard at a file-count cap, so
 * a bundle whose `assets/` or `scripts/` sorts before `SKILL.md` and is large
 * enough can produce a manifest that never lists it — the exact failure this
 * story exists to fix, reproduced one layer along, silently. Writing it
 * unconditionally makes "the file a session executes is missing from the
 * mirror" structurally impossible instead of dependent on another module's
 * walk order or size cap.
 */
export async function writePluginDir(
  pluginRoot: string,
  version: string,
  read: SkillsRead,
  /**
   * Where `/done` reports to, or `null` when nothing is listening (HIVE-93).
   *
   * Passed per call rather than captured once, because this runs before every
   * spawn and the receiver's port is only known after it binds. A directory
   * written during a launch whose receiver never came up holds the inert
   * built-in, and the next regeneration replaces it with the live one — which
   * is why the write below is unconditional rather than skipped when the file
   * already exists.
   */
  doneUrl: string | null = null,
): Promise<void> {
  const skillsDir = join(pluginRoot, 'skills');

  await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  await writeFile(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    manifest(version),
    'utf8',
  );

  /*
    Unconditionally, and over whatever is already there. The app owns `/done`,
    and a copy edited inside userData surviving a launch would make the built-in
    mean something different on one machine than on every other.
  */
  await mkdir(join(skillsDir, RESERVED_SKILL_NAME), { recursive: true });
  await writeFile(
    join(skillsDir, RESERVED_SKILL_NAME, 'SKILL.md'),
    doneSkill(doneUrl),
    'utf8',
  );

  // Only the valid ones. An invalid skill is reported to the pane and left out
  // of the plugin entirely — Claude Code never sees a file this app could not
  // explain.
  for (const skill of read.skills) {
    const destination = join(skillsDir, skill.name);
    await mkdir(destination, { recursive: true });

    // Written directly from `skill.body`, not mirrored below — see the
    // docblock's "SKILL.md itself" paragraph for why.
    await writeFile(join(destination, 'SKILL.md'), skill.body, 'utf8');

    const admitted = skill.manifest.entries.filter(
      (entry) => entry.excluded === null && entry.path !== 'SKILL.md',
    );

    // Directories first, so a file never arrives before its parent exists.
    for (const entry of admitted) {
      if (entry.kind === 'directory') {
        const path = join(destination, entry.path);
        await ensureKind(path, 'directory');
        await mkdir(path, { recursive: true });
      }
    }
    for (const entry of admitted) {
      if (entry.kind === 'file') {
        const to = join(destination, entry.path);
        await ensureKind(to, 'file');
        await copyIfChanged(join(skill.dir, entry.path), to);
      }
    }

    await prune(
      destination,
      new Set(['SKILL.md', ...admitted.map((entry) => entry.path)]),
    );
  }

  const expected = new Set([
    RESERVED_SKILL_NAME,
    ...read.skills.map((skill) => skill.name),
  ]);

  for (const entry of await readdir(skillsDir)) {
    if (!expected.has(entry)) {
      await rm(join(skillsDir, entry), { recursive: true, force: true });
    }
  }
}

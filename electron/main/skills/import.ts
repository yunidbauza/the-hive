import { chmod, copyFile, lstat, mkdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  MAX_BUNDLE_DEPTH,
  MAX_BUNDLE_FILES,
  MAX_BUNDLE_FILE_BYTES,
  SKILL_SKIP_ENTRIES,
} from '@shared/skills-contract';

import { readBundle } from './bundle';
import { isSkillManifest, resolveInSkill } from './paths';

/**
 * Bringing files a user chose into a bundle (HIVE-148).
 *
 * One code path behind two verbs. `import` opens the picker in main and carries
 * no source path across IPC at all; `drop` carries paths only preload can
 * produce. What they do with those paths is identical, and identical is the
 * point: two ways in with two sets of caps would be two chances to disagree
 * about what a bundle may hold.
 *
 * ## Why every source is inspected before any byte is written
 *
 * A copy that fails halfway leaves the user with a partial folder they did not
 * create, under a name they did not choose, and no report of which half
 * landed. Walking first costs one pass and makes a refusal total — which is
 * also why every cap enforced here (size, count, depth, an existing file in
 * the way) is checked while *planning* the copy, never while performing it.
 *
 * ## Symlinks: one rule, not two
 *
 * A symlink is never copied, at any depth — `readBundle` already reports one
 * nested inside a dropped folder as `excluded` and this walk skips it exactly
 * like a skipped name, without refusing the batch, for the reason
 * `skills-contract.ts` gives: a skipped entry is listed rather than hidden so
 * the user can rename around it, and Finder writes `.DS_Store` into any folder
 * it has displayed, so refusing a whole drop for it would make ordinary
 * Finder-dragged folders unusable. A **top-level** source that is itself a
 * symlink is different: the user named it directly, by dragging or by picking
 * it in a dialog, so it is refused with a sentence rather than silently
 * skipped or silently followed. An earlier draft `stat`ed every top-level
 * source, which follows a symlink to whatever it points at and copies *that*
 * in under the link's own name — one rule for a nested link and the opposite
 * one for the same object one path segment up, with neither written down.
 *
 * ## What is refused rather than merged: an existing destination
 *
 * `moveFile` refuses a taken destination rather than replacing it, and
 * `removeFile`/`moveFile` both refuse `SKILL.md` itself through
 * {@link isSkillManifest}. Copying in is a third route to the same two
 * mistakes — reachable by a drag — so it is guarded the same way: a
 * destination that already exists is refused by name, and `SKILL.md`
 * specifically is refused outright, before anything is written. Re-importing
 * an edited file is then an explicit delete-then-import, which is the honest
 * cost of not silently destroying a manifest or a file the user did not mean
 * to replace.
 */
export async function copyInto(
  skillName: string,
  dir: string,
  sources: string[],
): Promise<void> {
  const planned: { from: string; to: string; mode: number }[] = [];

  /*
    The cap is on the bundle, not on the batch. Counting only what is about to
    be added and ignoring what a bundle already holds lets a 100-file drop
    onto a 150-file bundle succeed, after which `readBundle` finds 250 files,
    caps at 200, and the tail of the bundle stops being listed *or mirrored* —
    "nothing was added" would be true of this call and false of the bundle it
    left behind.
  */
  const root = await resolveInSkill(skillName, '');
  const existing = await readBundle(root);
  const existingFiles = existing.entries.filter(
    (entry) =>
      entry.kind === 'file' &&
      entry.excluded?.code !== 'skipped' &&
      entry.excluded?.code !== 'symlink',
  ).length;

  /*
    `dir` naming an existing *file* rather than a folder is refused here, with
    a sentence, rather than left for the write loop's `mkdir(…, { recursive:
    true })` to fail on — that failure is a raw `EEXIST`/`ENOTDIR` naming the
    resolved host path, and every other refusal in this module is a sentence.
    Absent is fine: `mkdir` creates it.
  */
  if (dir !== '') {
    const dirAbs = await resolveInSkill(skillName, dir);
    const dirInfo = await lstat(dirAbs).catch(() => null);
    if (dirInfo !== null && !dirInfo.isDirectory()) {
      throw new Error(`"${dir}" is not a folder in this skill — nothing was added.`);
    }
  }

  for (const source of sources) {
    const name = basename(source);

    /*
      `basename('/tmp/..')` is `'..'`, and joining that onto the bundle walks
      straight out of it. The guard on `dir` cannot catch this: `dir` is the
      renderer's and was validated, while `name` is derived from a path the
      *user* picked. Every destination below also goes through
      `resolveInSkill`, which is the containment check proper — this is the
      cheap refusal that keeps a nonsense name from getting that far.
    */
    if (name === '' || name === '.' || name === '..') {
      throw new Error('That file has no usable name — it was not added.');
    }
    if (SKILL_SKIP_ENTRIES.includes(name)) {
      throw new Error(`"${name}" is never sent to a session — it was not added.`);
    }

    /*
      `lstat`, not `stat` — the top-level symlink rule this function's
      docblock explains. Once this confirms `source` is not itself a link,
      `lstat` and `stat` report identically, so the same `Stats` object serves
      as both the symlink check and the directory/file branch below.

      Caught rather than left to propagate: a missing source is a raw
      `ENOENT` naming the resolved host path, and every other refusal here is
      a sentence with no absolute path in it.
    */
    const info = await lstat(source).catch(() => {
      throw new Error(`"${name}" could not be found — it was not added.`);
    });
    if (info.isSymbolicLink()) {
      throw new Error(`"${name}" is a symlink — it was not added.`);
    }

    if (info.isDirectory()) {
      const manifest = await readBundle(source);
      if (manifest.capped !== null) {
        throw new Error(`"${name}": ${manifest.capped} Nothing was added.`);
      }

      const rootRel = posixJoin(dir, name);
      assertDepth(rootRel, name);

      /*
        The folder's own mkdir first, then its children, appended in source
        order. An earlier draft `unshift`ed each folder onto the whole list,
        which with two directory sources put the second folder's mkdir ahead of
        the first folder's files — the exact ordering this is here to
        guarantee, inverted.
      */
      planned.push({
        from: source,
        to: await resolveInSkill(skillName, rootRel),
        mode: -1,
      });

      for (const entry of manifest.entries) {
        if (entry.excluded !== null) {
          /*
            `skipped` and `symlink` are listed, not refused — this function's
            own docblock says why. `too-large` still refuses the whole batch:
            unlike a name the walk chose to skip on the user's behalf, a file
            over the cap is one the user asked to add and cannot have, so it
            is reported rather than quietly dropped.
          */
          if (entry.excluded.code === 'skipped' || entry.excluded.code === 'symlink') {
            continue;
          }
          throw new Error(
            `${entry.path}: ${entry.excluded.reason} Nothing was added.`,
          );
        }

        const relPath = posixJoin(dir, name, entry.path);
        assertDepth(relPath, entry.path);

        const from = join(source, entry.path);
        const to = await resolveInSkill(skillName, relPath);

        if (entry.kind === 'directory') {
          planned.push({ from, to, mode: -1 });
          continue;
        }

        await assertDestinationFree(skillName, to, relPath);
        planned.push({ from, to, mode: (await stat(from)).mode & 0o777 });
      }
      continue;
    }

    const relPath = posixJoin(dir, name);
    assertDepth(relPath, name);

    if (info.size > MAX_BUNDLE_FILE_BYTES) {
      throw new Error(
        `"${name}" is larger than ${String(MAX_BUNDLE_FILE_BYTES / 1_000_000)} MB — it was not added.`,
      );
    }

    const to = await resolveInSkill(skillName, relPath);
    await assertDestinationFree(skillName, to, relPath);

    planned.push({
      from: source,
      to,
      mode: info.mode & 0o777,
    });
  }

  const newFiles = planned.filter((item) => item.mode !== -1).length;
  if (existingFiles + newFiles > MAX_BUNDLE_FILES) {
    throw new Error(
      `This skill would hold more than ${String(MAX_BUNDLE_FILES)} files — nothing was added.`,
    );
  }

  for (const item of planned) {
    if (item.mode === -1) {
      await mkdir(item.to, { recursive: true });
      continue;
    }
    await mkdir(dirname(item.to), { recursive: true });
    await copyFile(item.from, item.to);
    // The mode it already had. The shebang rule is for files the pane writes.
    await chmod(item.to, item.mode);
  }
}

/**
 * Refuse a destination this batch would step on, before anything is written.
 *
 * `SKILL.md` is refused outright — the same file `removeFile` and `moveFile`
 * protect through {@link isSkillManifest}, and copying over it silently would
 * replace the manifest and, since a copy carries the source's own mode,
 * possibly leave it executable. Anything else that already exists is refused
 * by name rather than overwritten, matching `moveFile`'s wording for the same
 * situation: a destination the pane did not just create is one the user did
 * not ask this call to replace.
 */
async function assertDestinationFree(
  skillName: string,
  to: string,
  relPath: string,
): Promise<void> {
  if (await isSkillManifest(skillName, to)) {
    throw new Error('SKILL.md cannot be replaced by adding a file — delete it first.');
  }
  if (await pathExists(to)) {
    throw new Error(`"${relPath}" already exists in this skill.`);
  }
}

/** Is anything at all sitting on `path` already? */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse a destination deeper than `assertSkillPath` would ever admit.
 *
 * `resolveInSkill` is a containment check, not a depth check, and
 * `assertSkillPath` only ever sees `dir` — the request's own field — never the
 * path this module composes from it plus a source's name and, for a folder,
 * each entry inside it. A three-levels-deep dropped folder lands at depth
 * five with nothing to enforce the cap the manifest itself is bound by: it
 * writes, but `readBundle` cannot list it, no bundle verb can reach it to
 * move or delete it, and — because `readBundle` then reports the *bundle* as
 * `capped` at that folder — the mirror stops listing, and `writePluginDir`'s
 * prune stops shipping, everything the walk did not reach first, including
 * files that were already there before this call. Checked here, against
 * every planned destination, before any of them is written.
 */
function assertDepth(relPath: string, label: string): void {
  const depth = relPath.split('/').filter((segment) => segment !== '').length;
  if (depth > MAX_BUNDLE_DEPTH) {
    throw new Error(`"${label}" is too deep for this skill — nothing was added.`);
  }
}

/**
 * Join skill-relative segments, skipping the empty ones.
 *
 * `dir` is `''` for the bundle root, and `path.join('', 'a')` is `'a'` while
 * `` `${''}/a` `` is `'/a'` — an absolute path, which `assertSkillPath` would
 * have refused and `resolveInSkill` would then resolve against the filesystem
 * root. Small function, load-bearing.
 */
function posixJoin(...parts: string[]): string {
  return parts.filter((part) => part !== '').join('/');
}

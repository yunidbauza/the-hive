import { chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  MAX_BUNDLE_FILES,
  MAX_BUNDLE_FILE_BYTES,
  SKILL_SKIP_ENTRIES,
} from '@shared/skills-contract';

import { readBundle } from './bundle';
import { resolveInSkill } from './paths';

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
 * landed. Walking first costs one pass and makes a refusal total.
 */
export async function copyInto(
  skillName: string,
  dir: string,
  sources: string[],
): Promise<void> {
  const planned: { from: string; to: string; mode: number }[] = [];

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

    const info = await stat(source);

    if (info.isDirectory()) {
      const manifest = await readBundle(source);
      if (manifest.capped !== null) {
        throw new Error(`"${name}": ${manifest.capped} Nothing was added.`);
      }

      /*
        The folder's own mkdir first, then its children, appended in source
        order. An earlier draft `unshift`ed each folder onto the whole list,
        which with two directory sources put the second folder's mkdir ahead of
        the first folder's files — the exact ordering this is here to
        guarantee, inverted.
      */
      planned.push({
        from: source,
        to: await resolveInSkill(skillName, posixJoin(dir, name)),
        mode: -1,
      });

      for (const entry of manifest.entries) {
        if (entry.excluded !== null) {
          throw new Error(
            `${entry.path}: ${entry.excluded.reason} Nothing was added.`,
          );
        }
        const from = join(source, entry.path);
        planned.push({
          from,
          to: await resolveInSkill(
            skillName,
            posixJoin(dir, name, entry.path),
          ),
          mode: entry.kind === 'directory' ? -1 : (await stat(from)).mode & 0o777,
        });
      }
      continue;
    }

    if (info.size > MAX_BUNDLE_FILE_BYTES) {
      throw new Error(
        `"${name}" is larger than ${String(MAX_BUNDLE_FILE_BYTES / 1_000_000)} MB — it was not added.`,
      );
    }

    planned.push({
      from: source,
      to: await resolveInSkill(skillName, posixJoin(dir, name)),
      mode: info.mode & 0o777,
    });
  }

  if (planned.filter((item) => item.mode !== -1).length > MAX_BUNDLE_FILES) {
    throw new Error(`That is more than ${String(MAX_BUNDLE_FILES)} files — nothing was added.`);
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

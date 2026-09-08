import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MAX_BUNDLE_DEPTH,
  MAX_BUNDLE_FILES,
  MAX_BUNDLE_FILE_BYTES,
  SKILL_SKIP_ENTRIES,
  type BundleEntry,
  type BundleManifest,
} from '@shared/skills-contract';

/**
 * Reading a skill folder as the bundle it is (HIVE-148).
 *
 * Pure over a directory handed in, with no `app` import, so its tests run
 * under plain Node — the arrangement `read.ts` and `plugin.ts` already use.
 *
 * ## Why every rejected entry is still listed
 *
 * Delivery admits a subset of the folder. A tree that rendered only the
 * admitted files would let a user edit one that never reaches the session,
 * which is this story's own headline failure one layer up. So the walk reports
 * what it will not send, and says why on the entry itself.
 */

const SKIPPED = {
  code: 'skipped',
  reason: 'Skipped by name — this is never sent to a session.',
} as const;
const TOO_LARGE = {
  code: 'too-large',
  reason: `Larger than ${String(MAX_BUNDLE_FILE_BYTES / 1_000_000)} MB — not sent.`,
} as const;
const SYMLINK = {
  code: 'symlink',
  reason: 'A symlink is not followed — what it points at is not sent.',
} as const;
const CAPPED_FILES = `Stopped at ${String(MAX_BUNDLE_FILES)} files — the rest of this folder is not listed or sent.`;
const cappedDepth = (path: string): string =>
  `${path} is ${String(MAX_BUNDLE_DEPTH)} folders deep — what is inside it is not listed or sent.`;

export async function readBundle(dir: string): Promise<BundleManifest> {
  const entries: BundleEntry[] = [];
  let files = 0;
  let capped: string | null = null;

  const walk = async (rel: string, depth: number): Promise<void> => {
    if (capped !== null) return;

    let listing;
    try {
      listing = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      // A folder that cannot be read costs that folder, not the skill. The
      // per-entry-continue rule `read.ts` sets for skills holds inside one too.
      return;
    }

    for (const item of [...listing].sort((a, b) => a.name.localeCompare(b.name))) {
      if (capped !== null) return;

      const path = rel === '' ? item.name : `${rel}/${item.name}`;

      if (SKILL_SKIP_ENTRIES.includes(item.name)) {
        entries.push({
          path,
          kind: item.isDirectory() ? 'directory' : 'file',
          size: 0,
          executable: false,
          excluded: SKIPPED,
        });
        continue;
      }

      /*
        `Dirent` reports `lstat`, so this is a link and not what it points at —
        which is the whole check. Following one copies whatever is on the other
        end into a directory handed to a model.
      */
      if (item.isSymbolicLink()) {
        entries.push({
          path,
          kind: 'file',
          size: 0,
          executable: false,
          excluded: SYMLINK,
        });
        continue;
      }

      if (item.isDirectory()) {
        /*
          `depth + 1` is this folder's own segment count, and four is the limit
          `assertSkillPath` enforces. So a folder at exactly four is admitted —
          the pane can address it and the mirror creates it — and what cannot
          exist is anything inside it. That truncation is reported once through
          `capped`, not on this folder's row, because `excluded` means "not
          copied" and this folder is copied.
        */
        entries.push({
          path,
          kind: 'directory',
          size: 0,
          executable: false,
          excluded: null,
        });

        if (depth + 1 < MAX_BUNDLE_DEPTH) {
          await walk(path, depth + 1);
        } else if (capped === null && (await hasChildren(join(dir, path)))) {
          capped = cappedDepth(path);
        }
        continue;
      }

      if (!item.isFile()) continue;

      let info;
      try {
        info = await stat(join(dir, path));
      } catch {
        continue;
      }

      if (files >= MAX_BUNDLE_FILES) {
        capped = CAPPED_FILES;
        return;
      }
      files += 1;

      entries.push({
        path,
        kind: 'file',
        size: info.size,
        // Owner-execute only. Group and other are what the copy preserves, not
        // what the pane reasons about.
        executable: (info.mode & 0o100) !== 0,
        excluded: info.size > MAX_BUNDLE_FILE_BYTES ? TOO_LARGE : null,
      });
    }
  };

  await walk('', 0);

  return { entries, capped };
}

/** Is there anything at all in here? Used only to report a truncated depth. */
async function hasChildren(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  BrowseDirRequest,
  BrowseEntry,
  BrowseListing,
} from '@shared/config-contract';
import { HIDDEN_ENTRIES, type FsResult } from '@shared/fs-contract';

import { contains } from './contains';
import { asFailure, FsGuardError } from './paths';

/**
 * Browsing the answering machine's home directory (HIVE-146).
 *
 * ## Why this takes a path when nothing else in `fs/` does
 *
 * `fs-contract.ts`'s first structural property is that no verb takes a path.
 * Every request there names a `projectId` and a project-relative path, and
 * `paths.ts` resolves it against config main wrote itself. That holds because
 * the caller is always reading inside a project that is already mapped.
 *
 * This verb exists for the moment before that is true. The user is choosing a
 * folder to *become* a project, so there is no id to name it by, and a browser
 * that could only walk existing projects would be useless for the one job it
 * has. `fs:read-dir` cannot serve it for exactly that reason — it requires a
 * `projectId` the caller does not have yet.
 *
 * So the path comes from the renderer, and the fence moves rather than
 * disappearing: from "inside this project" to "inside home, proven after
 * `realpath`".
 *
 * ## What the fence is, and what it is not
 *
 * It is **not** a security boundary, and building on it as though it were will
 * lead somebody to the wrong conclusion later. Anyone who can reach this
 * channel has completed the device handshake, and that same handshake carries
 * `pty:spawn`, `fs:write-file` and `agents:run`. A caller who wanted to read
 * `/etc` has a shell available and does not need this verb. Adding a second
 * check here does not hold a line that is already open next door.
 *
 * What it does hold is the shape of an *accident*: an attached client
 * rendering the server's whole disk, with other users' home directories and
 * every system path in a list nobody asked for, one stray click from being
 * mapped as a project. Home is where projects live, so home is what the picker
 * shows. Read it as a sane default view enforced consistently, and size any
 * future work on it accordingly.
 *
 * ## Why it is enforced twice
 *
 * Once on the requested path, and once on every entry offered. The second is
 * not redundant: a symlink inside home pointing at `/etc` would otherwise be
 * listed, and the next call — which does check — would refuse the path this
 * module had just handed out. That reads as a broken picker rather than as a
 * fence working, so the entry never appears in the first place.
 */

/** Files are never offered: a project root is a directory. */
const DIRECTORY: BrowseEntry['kind'] = 'directory';

/**
 * The `realpath`'d home directory.
 *
 * Resolved per call rather than cached at module load. `homedir()` is stable
 * within a process, but `realpath` touches disk, and a module-level cache
 * would be the one value in here a test could not steer.
 */
async function homeRoot(): Promise<string> {
  return realpath(homedir());
}

/**
 * `''` and `'~'` mean home; `'~/x'` expands; anything else must be absolute.
 *
 * A relative path is refused rather than resolved against `process.cwd()`,
 * which in a packaged app is wherever the OS launched the bundle from and has
 * nothing to do with the user.
 *
 * `..` is nobody's special case here. On the absolute branch `resolve`
 * normalises it away before the containment check sees it, so `/etc/../etc`
 * is just `/etc`; on the `~/` branch `join` does the same, so `~/../etc`
 * becomes `dirname(home)/etc`. Either way what reaches {@link contained} is a
 * real path that either is under home or is not, which is the only question
 * this module asks. There is deliberately no rule about dots.
 */
function requested(home: string, path: string): string {
  if (path === '' || path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  if (!isAbsolute(path)) {
    throw new FsGuardError('EOUTSIDE', 'cannot browse that path');
  }
  return resolve(path);
}

/**
 * `realpath` first, then contain.
 *
 * The order is the whole point: a symlink inside home pointing at `/etc`
 * passes a containment check on the path as written and fails one on the path
 * it actually names. `fs/paths.ts` resolves in this order for the same reason.
 */
async function contained(home: string, candidate: string): Promise<string> {
  const real = await realpath(candidate);
  if (!contains(home, real)) {
    throw new FsGuardError('EOUTSIDE', 'cannot browse that path');
  }
  return real;
}

/**
 * How many visible children a directory has, or `null` if it cannot be read.
 *
 * Counted with the same `HIDDEN_ENTRIES` filter the listing itself uses, so
 * the number beside a folder is the number of rows opening it would show.
 */
async function childCount(absolute: string): Promise<number | null> {
  try {
    const names = await readdir(absolute);
    return names.filter((name) => !HIDDEN_ENTRIES.includes(name)).length;
  } catch {
    return null;
  }
}

/**
 * Describe one candidate child, or `null` to drop it.
 *
 * Dropped: files, anything that is neither file nor directory, anything that
 * cannot be `stat`ed, and any symlink whose target leaves home.
 */
async function describe(
  home: string,
  parent: string,
  name: string,
): Promise<BrowseEntry | null> {
  const candidate = join(parent, name);
  try {
    const real = await realpath(candidate);
    if (!contains(home, real)) return null;
    const stats = await stat(real);
    if (!stats.isDirectory()) return null;
    return {
      name,
      path: real,
      kind: DIRECTORY,
      childCount: await childCount(real),
    };
  } catch {
    return null;
  }
}

/**
 * List one directory under home.
 *
 * Answers an {@link FsResult} rather than throwing, the rule every verb in
 * this directory follows: the picker has to render something either way, and a
 * modal that throws tells the user the app is broken when the truth is that
 * one directory is unreadable.
 */
export async function browseHomeDirectory(
  request: BrowseDirRequest,
): Promise<FsResult<BrowseListing>> {
  try {
    const home = await homeRoot();
    const absolute = await contained(home, requested(home, request.path));

    const stats = await stat(absolute);
    if (!stats.isDirectory()) {
      throw new FsGuardError('EOUTSIDE', 'cannot browse that path');
    }

    const names = await readdir(absolute);
    const described = await Promise.all(
      names
        /**
         * Filtered before `realpath` and `stat`, not after — the same order
         * `readDirectory` uses, and for the same reason: the point of hiding
         * `node_modules` is not to render it tidily, it is to never pay the
         * syscalls for something nobody asked to see.
         */
        .filter((name) => !HIDDEN_ENTRIES.includes(name))
        .map((name) => describe(home, absolute, name)),
    );

    return {
      ok: true,
      value: {
        path: absolute,
        home,
        /**
         * Sorted here, unlike `readDirectory`, which leaves order to
         * `src/lib/explorer/sort.ts`. That module interleaves files and
         * directories by a rule the tree and its tests share; this listing is
         * directories only, so locale-aware name order is the whole rule and a
         * second module to hold it would be ceremony.
         */
        entries: described
          .filter((entry): entry is BrowseEntry => entry !== null)
          .sort((a, b) => a.name.localeCompare(b.name)),
      },
    };
  } catch (cause) {
    return { ok: false, error: asFailure(cause) };
  }
}

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  DirEntry,
  FileContent,
  FsRefusal,
  FsResult,
  ReadDirRequest,
  ReadFileRequest,
} from '@shared/fs-contract';
import {
  BINARY_SNIFF_BYTES,
  HIDDEN_ENTRIES,
  MAX_FILE_BYTES,
} from '@shared/fs-contract';

import { asFailure, resolveExisting } from './paths';

/**
 * The two read verbs.
 *
 * Both answer with an `FsResult` rather than throwing across IPC, on the rule
 * `gh.ts` established: the panel must render either way. A tree that throws
 * because one directory is unreadable tells the user the app is broken, when
 * the truth is that one directory is unreadable.
 */

/**
 * `withFileTypes` and then a `stat` per entry, rather than `withFileTypes`
 * alone.
 *
 * The extra syscall buys two things the `Dirent` cannot give. A symlink reports
 * as `isSymbolicLink()` and nothing else, so a tree built from `Dirent` alone
 * shows every linked directory as an un-expandable file — which in a monorepo
 * with linked packages is most of them. And `size` comes from `stat` or from
 * nowhere, and the editor needs it to refuse a file with a number in the
 * message.
 *
 * `stat` follows links deliberately: a symlink is shown as what it points at,
 * which is what a file explorer means by showing a symlink. A broken link
 * throws, and is dropped from the listing rather than failing it — one dangling
 * link should not blank a directory.
 */
async function describeEntry(
  directory: string,
  name: string,
): Promise<DirEntry | null> {
  try {
    const stats = await stat(join(directory, name));
    if (stats.isDirectory()) return { name, kind: 'dir', size: 0 };
    if (stats.isFile()) return { name, kind: 'file', size: stats.size };
    /**
     * Sockets, FIFOs, devices. Dropped rather than listed: none of them can be
     * opened in an editor, and a `/dev` entry that hangs a read when clicked is
     * a worse outcome than not offering it.
     */
    return null;
  } catch {
    return null;
  }
}

export async function readDirectory(
  request: ReadDirRequest,
): Promise<FsResult<DirEntry[]>> {
  try {
    const { absolute } = await resolveExisting(
      request.projectId,
      request.relPath,
    );

    const names = await readdir(absolute);
    const described = await Promise.all(
      names
        /**
         * Filtered before `stat`, not after. The point of hiding
         * `node_modules` is not to render it tidily — it is to never pay 800
         * `stat` calls for something nobody asked to see.
         */
        .filter((name) => !HIDDEN_ENTRIES.includes(name))
        .map((name) => describeEntry(absolute, name)),
    );

    /**
     * **Not sorted here.** `src/lib/explorer/sort.ts` owns the order, so the
     * tree and its tests read from one definition. Sorting in both places is
     * how a directory comes to render differently from the array a test
     * asserted against.
     */
    return { ok: true, value: described.filter((entry) => entry !== null) };
  } catch (cause) {
    return { ok: false, error: asFailure(cause) };
  }
}

/**
 * Whether the first bytes of a file contain a NUL.
 *
 * The same heuristic `git` uses, and wrong in the same places — UTF-16 source,
 * which nobody writes. The cost of a false positive is "Preview not available"
 * on a file that would have rendered, which the user can see and recover from;
 * the cost of not doing it is painting a megabyte of replacement characters.
 *
 * Read through an open handle rather than `readFile`, because the whole point
 * is to decide *before* pulling the file into memory.
 */
async function looksBinary(absolute: string, size: number): Promise<boolean> {
  const handle = await open(absolute, 'r');
  try {
    const length = Math.min(size, BINARY_SNIFF_BYTES);
    if (length === 0) return false;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export async function readFileContent(
  request: ReadFileRequest,
): Promise<FsResult<FileContent | FsRefusal>> {
  try {
    const { absolute } = await resolveExisting(
      request.projectId,
      request.relPath,
    );

    const stats = await stat(absolute);
    if (!stats.isFile()) {
      return {
        ok: false,
        error: { code: 'EISDIR', message: 'that is not a file' },
      };
    }

    /**
     * Size first, then the sniff.
     *
     * Both are refusals rather than errors, and the order matters for the one
     * case where both apply: a 40 MB binary reads better as "too large" than as
     * "binary", because the size is the fact the user can act on.
     */
    if (stats.size > MAX_FILE_BYTES) {
      return { ok: true, value: { refused: 'too-large', size: stats.size } };
    }
    if (await looksBinary(absolute, stats.size)) {
      return { ok: true, value: { refused: 'binary', size: stats.size } };
    }

    const handle = await open(absolute, 'r');
    try {
      const text = await handle.readFile('utf8');
      /**
       * The mtime is read from the **open handle**, not from the `stat` above.
       *
       * Between that `stat` and this read the file may have been rewritten —
       * by the very agent this feature exists to watch. Stamping the buffer
       * with the earlier mtime would hand the editor a base that predates the
       * content it is holding, and the next save would report a conflict that
       * had already been resolved by reading.
       */
      const fresh = await handle.stat();
      return {
        ok: true,
        value: { text, mtimeMs: fresh.mtimeMs, size: fresh.size },
      };
    } finally {
      await handle.close();
    }
  } catch (cause) {
    return { ok: false, error: asFailure(cause) };
  }
}

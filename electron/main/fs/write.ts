import { stat, writeFile } from 'node:fs/promises';

import type { WriteFileRequest, WriteFileResult } from '@shared/fs-contract';

import { asFailure, resolveForWrite } from './paths';

/**
 * The one verb that changes a file the user did not name through a dialog.
 *
 * ## Why optimistic concurrency and not a lock
 *
 * The other writer is an agent in a subprocess that will never take a lock, and
 * could not be made to. So the editor does not try to prevent the race — it
 * detects it, and refuses to resolve it silently. `baseMtimeMs` is the mtime
 * the buffer was read at; if the file has moved on, nothing is written and the
 * renderer offers the user the choice.
 *
 * ## What this check does not cover, stated plainly
 *
 * mtime resolution is coarse — on some filesystems a whole second. Two writes
 * inside one tick are indistinguishable, so a write can be lost in a
 * sub-millisecond race against an agent editing the same file the user is
 * editing. That is accepted: a situation in which those two are interleaving
 * writes to one file at that rate has worse problems than this check.
 *
 * The alternative — hashing the previous content and comparing — is strictly
 * better and costs a full re-read on every save of every file. It is the right
 * upgrade if the coarse case is ever actually hit, and the wrong default.
 */
export async function writeFileContent(
  request: WriteFileRequest,
): Promise<WriteFileResult> {
  try {
    const { absolute } = await resolveForWrite(
      request.projectId,
      request.relPath,
      request.sessionId,
    );

    const current = await stat(absolute);
    if (!current.isFile()) {
      return {
        ok: false,
        error: { code: 'EISDIR', message: 'that is not a file' },
      };
    }

    /**
     * `!==`, not `>`.
     *
     * A file restored from a backup, or checked out by `git`, can land with an
     * mtime *older* than the buffer's base. That is still a change the user
     * has not seen, and treating "older" as "unchanged" would overwrite it.
     */
    if (current.mtimeMs !== request.baseMtimeMs) {
      return { ok: false, conflict: true, mtimeMs: current.mtimeMs };
    }

    await writeFile(absolute, request.text, 'utf8');

    /**
     * The mtime is re-read rather than assumed to be "now". The buffer's next
     * base has to be what the filesystem recorded, and `Date.now()` is not
     * that — clock skew and coarse timestamps both make it a value the next
     * save would see as a conflict with itself.
     */
    const written = await stat(absolute);
    return { ok: true, mtimeMs: written.mtimeMs };
  } catch (cause) {
    return { ok: false, error: asFailure(cause) };
  }
}

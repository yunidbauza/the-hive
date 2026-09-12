import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';

/** Past this a plan file is not read (HIVE-180). A real plan is a few KiB. */
export const PLAN_FILE_MAX_BYTES = 1024 * 1024;

/**
 * The plan file's text and its realpath, or undefined when refused or
 * unreadable (HIVE-180).
 *
 * The path came from a hook payload, so the read is confined: both the file
 * and the session's cwd — from the same payload — are realpath'd, and the
 * file must sit strictly under the cwd. A symlink out of the repo is refused
 * by that, not by a separate check. A relative path is refused outright: it
 * would resolve against this process's directory, not the session's.
 */
export async function readPlanFile(
  filePath: string,
  cwd: string | undefined,
): Promise<{ file: string; text: string } | undefined> {
  if (cwd === undefined || !isAbsolute(filePath) || !isAbsolute(cwd)) return undefined;
  try {
    const [file, root] = await Promise.all([realpath(filePath), realpath(cwd)]);
    if (!file.startsWith(root + sep)) return undefined;
    const info = await stat(file);
    if (!info.isFile() || info.size > PLAN_FILE_MAX_BYTES) return undefined;
    return { file, text: await readFile(file, 'utf8') };
  } catch {
    return undefined;
  }
}

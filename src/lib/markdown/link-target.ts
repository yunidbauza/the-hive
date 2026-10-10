import { parentPath } from '@lib/explorer/fs-client';
import type { RelativeHref } from '@lib/markdown/href';

/**
 * The question a followed link asks main, through `fs:resolve`.
 *
 * Composed here; never answered here. `.` and inner `..` segments are folded,
 * but a leading `..` that climbs out of the root is kept and sent as written:
 * main realpaths the candidate and refuses anything outside the root, and
 * dropping the climb here would be a second containment check that could
 * disagree with the real one.
 *
 * Two shapes main would misread are avoided. An empty candidate fails main's
 * request validation for the whole call, so `.` (a directory, answered `null`)
 * is sent instead; and main expands a leading `~/` to the home directory, so a
 * link to a folder named `~` is sent as `./~/…`.
 *
 * v1 limitation: a root-relative link (`/docs/x.md`) in a file under an
 * in-project worktree is read from the project root, because the file's
 * project-relative path does not say where its own repository starts.
 */
function normalise(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export function linkCandidate(
  file: { relPath: string; rootKey: string },
  link: RelativeHref,
): string {
  const dir = parentPath(file.relPath);
  const joined = link.fromRoot || dir === '' ? link.path : `${dir}/${link.path}`;
  const folded = normalise(joined);
  const relative = folded === '' ? '.' : folded.startsWith('~') ? `./${folded}` : folded;
  // A widened root is named by its absolute path; main checks the candidate against it.
  return file.rootKey === '' ? relative : `${file.rootKey}/${relative}`;
}

/** The session to resolve under: none at the project root, the file's under a widened one. */
export const linkSessionId = (file: { rootKey: string; sessionId?: string }): string | undefined =>
  file.rootKey === '' ? undefined : file.sessionId;

import { sep } from 'node:path';

/**
 * Whether `candidate` is `root` or lives underneath it.
 *
 * The `sep` suffix is load-bearing: without it, a project at `/w/app` would
 * consider `/w/app-secrets` contained, because the string starts with the root.
 * That is the classic prefix bug, and it is exactly the sort of thing that
 * looks fine until someone has two sibling repositories.
 *
 * ## Why it has a file of its own
 *
 * It lived in `paths.ts` until `session-roots.ts` needed it too — and
 * `paths.ts` needs `session-roots.ts` to decide which root to test against.
 * Two modules that import each other are a cycle, which this codebase bans, so
 * the shared rule moved down to a module with no dependencies of its own.
 * `paths.ts` re-exports it, because it is that module's contract as far as
 * every existing caller is concerned.
 */
export function contains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

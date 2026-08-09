import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import type { FsFailure } from '@shared/fs-contract';

import { getConfig } from '../config';

/**
 * Turning `{ projectId, relPath }` into an absolute path — or refusing to.
 *
 * **This module is the security boundary for the whole explorer.** Everything
 * else in `electron/main/fs/` assumes it was handed a path that is inside a
 * project the user mapped; this is what makes that true.
 *
 * Three checks, and each catches something the other two do not:
 *
 * 1. **The project must be known and usable.** The id is looked up in the
 *    config main loaded and validated itself, and a project whose `status` is
 *    not `'ok'` is not readable. There is no second opinion here and no
 *    fallback to "well, the path looks fine" — the config's verdict is the gate.
 * 2. **The relative path must not escape as a string.** That check already ran
 *    in `assertRelPath` before this was called, and is not repeated: repeating
 *    it here would create two definitions of what a legal path is, which is how
 *    they come to disagree. What is repeated is the consequence — `resolve`
 *    normalises, and the containment test below runs on the result.
 * 3. **The path must not escape as a *link*.** This is the one a string check
 *    can never make. A symlink inside the project pointing at `/etc` is a
 *    perfectly well-formed relative path; only asking the filesystem where it
 *    actually goes settles it.
 *
 * The root is re-`realpath`'d on every call rather than trusted from the
 * config snapshot. The config resolved it when it loaded, which may have been
 * an hour and a `mv` ago.
 */

/** A refusal that carries this contract's own code rather than a platform one. */
export class FsGuardError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FsGuardError';
    this.code = code;
  }
}

export interface ResolvedTarget {
  /** The project's real root, symlinks resolved. */
  root: string;
  /** The real absolute path of the target. */
  absolute: string;
}

/**
 * Whether `candidate` is `root` or lives underneath it.
 *
 * The `sep` suffix is load-bearing: without it, a project at `/w/app` would
 * consider `/w/app-secrets` contained, because the string starts with the root.
 * That is the classic prefix bug, and it is exactly the sort of thing that
 * looks fine until someone has two sibling repositories.
 */
export function contains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

/** The project's real root, or a refusal naming why there is not one. */
export async function projectRoot(projectId: string): Promise<string> {
  const project = getConfig().projects.find((entry) => entry.id === projectId);

  if (!project) {
    throw new FsGuardError('EPROJECT', 'no such project');
  }
  /**
   * Deliberately one message for both "unknown id" and "unusable project".
   *
   * The renderer has no business learning which — that difference is the only
   * thing an id-probing loop could extract from this verb, and it is worth
   * nothing to the panel, which renders the config's own `status` reason
   * anyway.
   */
  if (project.status !== 'ok' || project.path === null) {
    throw new FsGuardError('EPROJECT', 'no such project');
  }

  try {
    return await realpath(project.path);
  } catch {
    throw new FsGuardError('EPROJECT', 'no such project');
  }
}

/**
 * Resolve a path that must already exist — every read.
 *
 * `realpath` on the target itself, so a symlink is followed *before* the
 * containment test rather than after it.
 */
export async function resolveExisting(
  projectId: string,
  relPath: string,
): Promise<ResolvedTarget> {
  const root = await projectRoot(projectId);
  const joined = resolve(root, relPath);

  let absolute: string;
  try {
    absolute = await realpath(joined);
  } catch (cause) {
    const code =
      cause instanceof Error && 'code' in cause
        ? String((cause as NodeJS.ErrnoException).code)
        : 'ENOENT';
    throw new FsGuardError(code, 'cannot read that path');
  }

  if (!contains(root, absolute)) {
    throw new FsGuardError('EOUTSIDE', 'cannot read that path');
  }

  return { root, absolute };
}

/**
 * Resolve a path that may not exist yet — the write.
 *
 * **Two links to defeat, not one**, and an earlier revision of this function
 * only handled the first:
 *
 * 1. **A symlinked parent.** The target cannot be `realpath`'d because it might
 *    be about to be created, but its parent can — and must be, because a file
 *    created inside a symlinked directory lands wherever that link goes. The
 *    basename is re-appended to the *real* parent, which is why the result is
 *    not simply `resolve(root, relPath)`.
 * 2. **A symlinked target.** Resolving the parent says nothing about the leaf.
 *    `root/sub/link.txt -> /outside/target.txt` has a parent inside the root
 *    and a `join`ed path inside the root, so it passed both checks — and
 *    `writeFile` follows symlinks, so the bytes landed outside. `lstat` is the
 *    only call that can see this: `stat` would follow the link and `realpath`
 *    would throw for a target that does not exist yet.
 *
 * A link that resolves back *inside* the root is allowed rather than refused —
 * in-repo symlinks are ordinary, and containment is the property being
 * defended, not the absence of links.
 *
 * A `relPath` naming the root itself has no parent to check and is refused —
 * writing a file over a directory is not something this verb does.
 */
export async function resolveForWrite(
  projectId: string,
  relPath: string,
): Promise<ResolvedTarget> {
  const root = await projectRoot(projectId);
  const joined = resolve(root, relPath);

  if (joined === root) {
    throw new FsGuardError('EISDIR', 'cannot write to the project root');
  }

  let realParent: string;
  try {
    realParent = await realpath(dirname(joined));
  } catch (cause) {
    const code =
      cause instanceof Error && 'code' in cause
        ? String((cause as NodeJS.ErrnoException).code)
        : 'ENOENT';
    throw new FsGuardError(code, 'cannot write to that path');
  }

  let absolute = join(realParent, basename(joined));

  if (!contains(root, realParent) || !contains(root, absolute)) {
    throw new FsGuardError('EOUTSIDE', 'cannot write to that path');
  }

  /**
   * The leaf itself. `lstat` does not follow the link, so this is the one call
   * that can tell a symlink from the file it points at; ENOENT means the target
   * does not exist yet, which is fine and needs no further check.
   */
  let leaf: Stats | null = null;
  try {
    leaf = await lstat(absolute);
  } catch {
    leaf = null;
  }

  if (leaf?.isSymbolicLink()) {
    try {
      absolute = await realpath(absolute);
    } catch (cause) {
      // A dangling link. Refused rather than followed: there is no target to
      // contain, and creating one would write through the link to wherever it
      // points — which is exactly the case this check exists for.
      const code =
        cause instanceof Error && 'code' in cause
          ? String((cause as NodeJS.ErrnoException).code)
          : 'ENOENT';
      throw new FsGuardError(code, 'cannot write to that path');
    }

    if (!contains(root, absolute)) {
      throw new FsGuardError('EOUTSIDE', 'cannot write to that path');
    }
  }

  return { root, absolute };
}

/**
 * Any thrown thing, as the failure the contract carries.
 *
 * Platform errno codes pass through, because `ENOENT` and `EACCES` are
 * genuinely useful to render. Anything unrecognised becomes `EUNKNOWN` with a
 * fixed message rather than the thrown string: a raw error from `fs` can carry
 * an absolute path, and this reply crosses into a renderer that was told
 * absolute paths do not exist.
 */
export function asFailure(cause: unknown): FsFailure {
  if (cause instanceof FsGuardError) {
    return { code: cause.code, message: cause.message };
  }
  if (cause instanceof Error && 'code' in cause) {
    const code = String((cause as NodeJS.ErrnoException).code ?? 'EUNKNOWN');
    return { code, message: 'the filesystem refused that operation' };
  }
  return { code: 'EUNKNOWN', message: 'the filesystem refused that operation' };
}

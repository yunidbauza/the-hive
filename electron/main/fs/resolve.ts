import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

import type {
  FsResult,
  ResolveRequest,
  ResolveResult,
  ResolvedLink,
} from '@shared/fs-contract';

import { contains } from './contains';
import { asFailure, projectRoot } from './paths';
import { observedSessionCwd, sessionRoot } from './session-roots';

/**
 * `fs:resolve` — which of these printed strings name a file this pairing may
 * read.
 *
 * ## Why the renderer cannot do this itself
 *
 * A terminal prints paths the way the program that ran chose to: absolute from
 * tsc, working-directory-relative from a test runner, `~/`-prefixed from a
 * shell, and project-relative from git. None of those is a `relPath`, and the
 * renderer must not be the thing that turns one into the other — that is
 * precisely "the renderer names a directory", which the first property in
 * `fs-contract.ts` exists to prevent. So main does the turning, on the same
 * evidence it uses for every read, and a candidate that lands anywhere but
 * inside the root is simply not a link.
 *
 * ## The same root, and the same two checks
 *
 * Root: `projectRoot`, widened by `sessionRoot` only where main has already
 * proved the session's working directory is a linked worktree of this project.
 * Checks: `realpath` **before** containment, so a symlink is followed before it
 * is judged — a link inside the tree pointing out of it has an innocent joined
 * path and a guilty real one, and only this order can tell.
 *
 * One check the reads do not need: `isFile`. A directory is a perfectly good
 * thing to `readDir` and a useless thing to open in an editor, and `git diff
 * --stat` prints enough directory names to make that the common case rather
 * than the odd one.
 */
export async function resolvePaths(
  request: ResolveRequest,
): Promise<FsResult<ResolveResult>> {
  try {
    const project = await projectRoot(request.projectId);
    const session = await sessionRoot(project, request.sessionId);
    const root = session ?? project;
    /** `''` for the project root, matching every buffer key already in flight. */
    const rootKey = session ?? '';

    const cwd = await cwdWithin(root, request.sessionId);
    /*
      One base when the session is sitting at the root, which is the ordinary
      case rather than the odd one: `[root, root]` would `realpath` every
      candidate twice to reach the same verdict.
    */
    const bases = cwd === null || cwd === root ? [root] : [cwd, root];

    const resolved = await Promise.all(
      request.candidates.map((candidate) =>
        resolveOne(candidate, root, rootKey, bases),
      ),
    );
    return { ok: true, value: { resolved } };
  } catch (cause) {
    return { ok: false, error: asFailure(cause) };
  }
}

/**
 * The session's working directory, if it is somewhere under the root.
 *
 * A cwd elsewhere is not a base. A relative path printed by a program running
 * in `/tmp` names a file this verb may not serve, and resolving it against the
 * root *instead* would not be a fallback — it would be inventing a different
 * file with the same name and handing it to the user as the one they clicked.
 */
async function cwdWithin(
  root: string,
  sessionId: string | undefined,
): Promise<string | null> {
  const observed = observedSessionCwd(sessionId);
  if (observed === undefined) return null;
  try {
    const real = await realpath(observed);
    return contains(root, real) ? real : null;
  } catch {
    // A container session's cwd is a path inside the container, and a finished
    // session's may be gone. Neither is an error; there is simply no second base.
    return null;
  }
}

/** The first base under which this candidate is a real, contained file. */
async function resolveOne(
  candidate: string,
  root: string,
  rootKey: string,
  bases: readonly string[],
): Promise<ResolvedLink | null> {
  const expanded = candidate.startsWith('~/')
    ? resolvePath(homedir(), candidate.slice(2))
    : candidate;
  const attempts = isAbsolute(expanded)
    ? [expanded]
    : bases.map((base) => resolvePath(base, expanded));

  for (const attempt of attempts) {
    let absolute: string;
    try {
      absolute = await realpath(attempt);
    } catch {
      continue;
    }
    if (!contains(root, absolute)) continue;

    try {
      if (!(await stat(absolute)).isFile()) continue;
    } catch {
      continue;
    }

    return {
      // `relative` answers in the platform's separator; the renderer's paths
      // are `/`-joined everywhere else in this contract.
      relPath: relative(root, absolute).split(sep).join('/'),
      rootKey,
    };
  }
  return null;
}

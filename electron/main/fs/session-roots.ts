import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { contains } from './contains';

/**
 * The one place the explorer's root may be something other than the mapped
 * project — and the rules that keep that narrow.
 *
 * ## The problem
 *
 * `paths.ts` admits exactly one root per project, which is what makes every
 * read safe. HIVE-78 taught the *renderer* to re-root at a session's working
 * directory, but only as a project-relative prefix, because a prefix is all
 * that fits inside one root. That covers a worktree at
 * `<project>/.claude/worktrees/<name>` and nothing else.
 *
 * A worktree kept **outside** the project — `~/worktrees/x`, a temp directory,
 * anywhere `git worktree add` was pointed — resolved to no prefix at all, so
 * the tree quietly showed the project root: files nobody was editing, while the
 * agent worked somewhere the panel would not name. A file explorer that shows
 * the wrong files without saying so is worse than one that shows none.
 *
 * ## The rule
 *
 * A second root is admitted for a session **only** when all of these hold:
 *
 * 1. main itself observed the cwd, from that session's own hook payloads. The
 *    renderer never supplies a path — see `fs-contract.ts`, property 1.
 * 2. `git -C <cwd> rev-parse --git-common-dir --show-toplevel` succeeds.
 * 3. The common dir — the *shared* `.git` that every linked worktree of a
 *    repository points back to — resolves to `<projectRoot>/.git`.
 * 4. The toplevel is the directory that becomes the root, `realpath`'d.
 *
 * Check 3 is the load-bearing one. It is what makes "a worktree **of this
 * project**" a decidable question rather than a guess from the path, and it is
 * why a session that wandered into `/tmp`, into an unrelated repository, or
 * into the user's home directory is refused: their common dir is not this
 * project's. A bare `git rev-parse --show-toplevel` would have accepted every
 * repository on the machine.
 *
 * Everything downstream is unchanged. `resolveExisting` and `resolveForWrite`
 * still `realpath` the target and still test containment; all that moves is
 * *which* root they test against, and only for a directory that proved it
 * belongs to the project the request already named.
 *
 * ## What is not defended here
 *
 * A user who maps a project and then runs an agent in a worktree of it has
 * granted the explorer that worktree. That is the feature. What stays refused
 * is everything the user did not do: an arbitrary path, an unrelated
 * repository, and any traversal out of whichever root is chosen.
 */

/** How main learns a session's working directory. Injected at registration. */
export type SessionCwdLookup = (sessionId: string) => string | undefined;

let lookup: SessionCwdLookup | null = null;

/**
 * Wire the session layer's observation in.
 *
 * An injection rather than an import because `fs/` must not depend on
 * `sessions/` — the session layer already reaches the filesystem, and a cycle
 * between the two would be a real one. This is the same shape
 * `setUpdateNotificationSink` uses for the same reason.
 */
export function setSessionCwdLookup(next: SessionCwdLookup | null): void {
  lookup = next;
}

/**
 * What `git rev-parse` said about one directory, keyed by the directory.
 *
 * Cached because the alternative is a subprocess on **every** directory
 * expansion and every keystroke-triggered save. A given absolute path does not
 * change which repository it belongs to over the life of a session; if the
 * agent moves, the cwd string moves with it and misses this cache.
 *
 * `null` is a cached refusal — a directory that is not a worktree of anything
 * must not be re-probed on every read either.
 */
const probed = new Map<string, WorktreeFacts | null>();

interface WorktreeFacts {
  /** The shared `.git` every linked worktree of one repository points at. */
  commonDir: string;
  /** The working tree's own root. */
  toplevel: string;
}

/** Drop the probe cache. For tests, and for a config reload. */
export function forgetProbedRoots(): void {
  probed.clear();
}

/**
 * `git rev-parse`, once per directory.
 *
 * `--path-format=absolute` so both answers are absolute whatever the cwd, and
 * `-C` rather than the `cwd` option so a directory that has since been deleted
 * fails as a git error rather than as a spawn error.
 */
async function probe(cwd: string): Promise<WorktreeFacts | null> {
  const cached = probed.get(cwd);
  if (cached !== undefined) return cached;

  const facts = await new Promise<WorktreeFacts | null>((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
      { timeout: 2_000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const [commonDir, toplevel] = stdout.trim().split('\n');
        if (!commonDir || !toplevel) {
          resolve(null);
          return;
        }
        resolve({ commonDir, toplevel });
      },
    );
  });

  probed.set(cwd, facts);
  return facts;
}

/**
 * The root to read under for `sessionId`, or `null` to use the project's.
 *
 * Every uncertain case answers `null`, which is the pre-existing behaviour:
 * no lookup wired, no session, no observed cwd, a cwd that will not `realpath`,
 * a cwd already inside the project (the renderer's prefix handles that one),
 * a directory git does not recognise, and a worktree belonging to some other
 * repository.
 */
export async function sessionRoot(
  projectRealRoot: string,
  sessionId: string | undefined,
): Promise<string | null> {
  if (!sessionId || !lookup) return null;

  const observed = lookup(sessionId);
  if (!observed) return null;

  let cwd: string;
  try {
    cwd = await realpath(observed);
  } catch {
    return null;
  }

  // Already inside the project: one root still covers it, and the renderer
  // roots the tree with a project-relative prefix (`lib/explorer/session-root`).
  if (contains(projectRealRoot, cwd)) return null;

  const facts = await probe(cwd);
  if (!facts) return null;

  let commonDir: string;
  let toplevel: string;
  try {
    commonDir = await realpath(facts.commonDir);
    toplevel = await realpath(facts.toplevel);
  } catch {
    return null;
  }

  // The check the whole module exists for: this must be a worktree of *this*
  // project, not merely of some repository. A project with no `.git` at all
  // answers `null` here, which can never equal a resolved common dir — correct,
  // since a directory that is not a repository can have no worktrees.
  const projectGit = await projectGitDir(projectRealRoot);
  if (projectGit === null || commonDir !== projectGit) return null;

  return toplevel;
}

/**
 * The project's own `.git`, resolved.
 *
 * `realpath`'d for the same reason the roots are: a project reached through a
 * symlinked parent would otherwise never match the absolute path git reports.
 * A project that is not a git repository has no `.git` to resolve and throws,
 * which lands as "no second root" — correct, since it can have no worktrees.
 */
async function projectGitDir(projectRealRoot: string): Promise<string | null> {
  try {
    return await realpath(join(projectRealRoot, '.git'));
  } catch {
    return null;
  }
}

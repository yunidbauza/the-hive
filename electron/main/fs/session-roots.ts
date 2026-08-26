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
 * 4. `git -C <cwd> worktree list --porcelain` actually lists that toplevel.
 * 5. The toplevel is the directory that becomes the root, `realpath`'d.
 *
 * Checks 3 and 4 are the load-bearing pair, and neither is sufficient alone.
 *
 * Check 3 is what makes "a worktree **of this project**" a question about
 * identity rather than a guess from the path: a session that wandered into
 * `/tmp`, into an unrelated repository, or into the user's home directory is
 * refused because its common dir is not this project's. A bare
 * `git rev-parse --show-toplevel` would have accepted every repository on the
 * machine.
 *
 * Check 4 exists because check 3 is **forgeable**. A directory containing a
 * hand-written `.git` *file* reading `gitdir: <project>/.git` makes
 * `--git-common-dir` report the project's `.git` while never having been
 * registered as a worktree of it — so on its own, check 3 says "plausible"
 * where this module claims "decidable". Requiring the toplevel to appear in the
 * repository's own worktree list makes the claim git's rather than ours.
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
 * What git said about one directory, keyed by the directory.
 *
 * **The promise is cached, not the value**, and that is the load-bearing part.
 * `useDirectory` fires one `readDir` per expanded node in parallel on every
 * refresh, so caching only the settled answer would let a dozen concurrent
 * reads each miss and each spawn their own `git` — the exact cost the cache
 * exists to prevent, at precisely the moment it is most expensive. Storing the
 * in-flight promise makes the second caller await the first.
 *
 * A given absolute path does not change which repository it belongs to over the
 * life of a session; if the agent moves, the cwd string moves with it and
 * misses this cache. `null` is a cached refusal — a directory that is not a
 * worktree of anything must not be re-probed on every read either.
 */
const probed = new Map<string, Promise<WorktreeFacts | null>>();

interface WorktreeFacts {
  /** The shared `.git` every linked worktree of one repository points at. */
  commonDir: string;
  /** The working tree's own root. */
  toplevel: string;
}

/**
 * Drop the probe cache.
 *
 * Called on a config reload, because a project being repointed or re-added
 * changes which repository a directory should be measured against — and a
 * cached refusal would otherwise outlive the setup that caused it for the life
 * of the app.
 */
export function forgetProbedRoots(): void {
  probed.clear();
}

/** Run a git command in `cwd`, or answer `null` — and say whether it timed out. */
function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string } | { timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        // `killed` is how `execFile` reports its own timeout, as opposed to git
        // answering "no". The difference decides whether the answer is cacheable.
        resolve({ timedOut: (error as { killed?: boolean }).killed === true });
        return;
      }
      resolve({ stdout });
    });
  });
}

/** How long either git call may take before it is abandoned. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Two git calls, once per directory.
 *
 * The first asks what repository this is. The second — `worktree list` — is
 * what makes the answer trustworthy rather than merely plausible: a directory
 * containing a hand-written `.git` file reading `gitdir: <project>/.git` makes
 * `--git-common-dir` report the project's `.git` without ever having been
 * registered as a worktree of it. Requiring the toplevel to appear in the
 * repository's own list of worktrees closes that, and turns "a worktree of this
 * project" from a plausible inference into something git itself asserts.
 *
 * `--path-format=absolute` so both answers are absolute whatever the cwd, and
 * `-C` rather than the `cwd` option so a directory that has since been deleted
 * fails as a git error rather than as a spawn error.
 */
function probe(cwd: string): Promise<WorktreeFacts | null> {
  const cached = probed.get(cwd);
  if (cached !== undefined) return cached;

  const pending = (async (): Promise<WorktreeFacts | null> => {
    const parsed = await runGit(cwd, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
      '--show-toplevel',
    ]);

    if (!('stdout' in parsed)) {
      /*
        A timeout is not an answer. Caching one would let a single slow `git` —
        a cold filesystem, a network mount — disable the worktree root for that
        directory for the rest of the app's life, with nothing on screen to
        explain why. Dropping the entry means the next read tries again.
      */
      if (parsed.timedOut) probed.delete(cwd);
      return null;
    }

    const [commonDir, toplevel] = parsed.stdout.trim().split('\n');
    if (!commonDir || !toplevel) return null;

    const listed = await runGit(cwd, ['worktree', 'list', '--porcelain']);
    if (!('stdout' in listed)) {
      if (listed.timedOut) probed.delete(cwd);
      return null;
    }

    /*
      `worktree list --porcelain` emits one `worktree <absolute path>` line per
      registered tree, the main one first. An exact line match, not a substring:
      `/w/app-secrets` contains `/w/app`, which is the same prefix bug
      `contains()` exists to avoid.
    */
    const registered = listed.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim());

    if (!registered.includes(toplevel)) return null;

    return { commonDir, toplevel };
  })();

  probed.set(cwd, pending);
  return pending;
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

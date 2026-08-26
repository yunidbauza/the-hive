/**
 * Where the explorer should be rooted for a session that moved (HIVE-78).
 *
 * ## The problem
 *
 * The explorer roots at the *mapped project*. A session whose agent has moved
 * into a worktree — `.claude/worktrees/incorp-332/` — is editing files the tree
 * is not showing, while the tree shows files nobody is touching. That is the
 * same class of untruth as the invented branch name, one surface over.
 *
 * ## Why this is a prefix and not a new root
 *
 * `electron/main/fs/paths.ts` is the explorer's security boundary: every read
 * resolves under `projectRoot(projectId)` and refuses anything outside it. That
 * boundary is **not** widened here and does not need to be, because the
 * interesting case already lives inside it — a worktree at
 * `<project>/.claude/worktrees/<name>` is a subdirectory of the project. So
 * retargeting is a project-relative *prefix* the panel prepends, and every read
 * still goes through the same guard, unchanged.
 *
 * A cwd **outside** the mapped project — a worktree the user keeps in
 * `~/worktrees`, a session that wandered into `/tmp` — resolves to `''`, so the
 * tree stays at the project root. The guard would refuse those paths anyway;
 * answering `''` here means the panel shows something true rather than an error
 * about a path it should not have asked for.
 */

/** The separator. Only ever POSIX here — see {@link relativeRoot}. */
const SEP = '/';

/**
 * Whether `candidate` is `root` or lives underneath it.
 *
 * Deliberately the same rule as `contains()` in `electron/main/fs/paths.ts`,
 * including the trailing-separator detail that file calls load-bearing: without
 * it a project at `/w/app` would consider `/w/app-secrets` contained, because
 * the string starts with the root. Two copies of one rule is a real cost, and
 * it is unavoidable — `src/**` may not import `electron/main/**`, which is the
 * fence that keeps main-process code out of the renderer bundle.
 */
export function containsPath(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(SEP) ? root : `${root}${SEP}`;
  return candidate.startsWith(prefix);
}

/**
 * The project-relative directory the explorer should show, or `''` for the
 * project root.
 *
 * POSIX separators only, and that is a statement about the inputs rather than a
 * limitation: both operands are absolute paths this app produced on the machine
 * it is running on, and the desktop target is macOS and Linux. A Windows build
 * would need `path.relative` semantics here, which the renderer cannot import —
 * that is a real porting task, recorded rather than half-done.
 *
 * Answers `''` — meaning "do not retarget" — for every uncertain case:
 *
 * - no project path (the config has not loaded, or the project is unusable),
 * - no observed cwd (nothing has reported one yet),
 * - a cwd equal to the project root (the ordinary session),
 * - a cwd outside the project root (see the note above).
 */
export function relativeRoot(
  projectPath: string | null | undefined,
  cwd: string | undefined,
): string {
  if (!projectPath || !cwd) return '';

  const root = projectPath.endsWith(SEP) ? projectPath.slice(0, -1) : projectPath;
  const target = cwd.endsWith(SEP) ? cwd.slice(0, -1) : cwd;

  if (target === root) return '';
  if (!containsPath(root, target)) return '';

  return target.slice(root.length + 1);
}

/**
 * What the explorer's header should say the tree is rooted at.
 *
 * `relativeRoot` above answers a *mechanical* question — which prefix to
 * prepend to every path — and answers `''` for two very different situations:
 * a session sitting in the project root, and a session working somewhere the
 * prefix cannot reach. The header cannot use it, because those two must not
 * read the same. The first is "the project"; the second is a worktree the
 * panel is now genuinely rooted at, through the session root main resolves.
 *
 * So this answers the *display* question instead, from the same two inputs:
 *
 * - `suffix` — the directory's own name, or `''` when the tree is at the
 *   project root. A 268px rail cannot carry `.claude/worktrees/hive-pr-column`,
 *   and the last segment is the part that identifies which worktree it is.
 * - `full` — the whole path, for the `title`, where there is room to be exact.
 *
 * Unlike `relativeRoot`, a cwd **outside** the project is described rather than
 * discarded. That is the whole point: the tree really is showing that directory
 * now, and a header that omitted it would be the untruth this pair of functions
 * exists to prevent.
 */
export function rootDisplay(
  projectPath: string | null | undefined,
  cwd: string | undefined,
): { suffix: string; full: string | null } {
  if (!projectPath || !cwd) return { suffix: '', full: null };

  const root = projectPath.endsWith(SEP) ? projectPath.slice(0, -1) : projectPath;
  const target = cwd.endsWith(SEP) ? cwd.slice(0, -1) : cwd;

  if (target === root) return { suffix: '', full: null };

  const segments = target.split(SEP);
  return { suffix: segments[segments.length - 1] ?? '', full: target };
}

import { relativeRoot, rootDisplay } from '@/lib/explorer/session-root';
import { isSession, type ProjectRow } from '@/types/entity';

import { useProjectPath } from '@hooks/use-project-config';
import { useActiveEntity, useProjects } from '@stores/hive-store';

/**
 * Which repository the explorer is showing — and, since HIVE-78, **where in
 * it**.
 *
 * **One rule: the active session's project, or nothing** (HIVE-93).
 *
 * The app is organised around "which session am I watching", the session already
 * names its project, and a second selector would be one more thing to keep in
 * sync with the first. When no session is being watched — the overmind tab, an
 * agent tab — the answer is `null` and the panel says so.
 *
 * ## Why the two fallbacks were removed
 *
 * This hook used to add: *the last project it was rooted at*, so a trip to the
 * overmind kept the tree it had, and *the first mapped project* on a cold start.
 * The argument was that otherwise "every trip to the orchestrator would yank the
 * tree back to the first mapped project — once per navigation, on a panel the
 * user was reading". That cost is real and it is the price of this change.
 *
 * What it bought was worse. A file tree is an invitation to click, and every
 * entry in it opens an editor tab **rooted in a project no session on screen is
 * working in** — so the panel invited the user to browse one repository while the
 * stage showed the fleet, or an agent, or a session in a different project
 * entirely. The cold-start branch was the same lie with no user action behind it
 * at all: a fresh launch on the overmind tab displayed the first mapped
 * project's files as though something were happening in it.
 *
 * Showing nothing is not a worse answer than showing the wrong thing; it is the
 * only honest one, and the empty state names the way out.
 *
 * ## The subdirectory
 *
 * A session whose agent moved into a worktree is editing files under
 * `<project>/.claude/worktrees/<name>`, and a tree rooted at the project shows
 * the wrong ones. `root` is the project-relative prefix that fixes it — `''`
 * for the ordinary case, and `''` again whenever the answer is uncertain. See
 * `lib/explorer/session-root.ts` for why this is a prefix rather than a new
 * root, and why the fs guard is untouched by it.
 *
 * Only the active session's own project is ever retargeted, which is now the
 * only case there is — the branches that could have inherited one session's
 * worktree prefix for a project reached for another reason are gone with the
 * fallbacks above.
 */
export interface ExplorerTarget {
  project: ProjectRow | null;
  /** Project-relative directory to root the tree at. `''` is the project root. */
  root: string;
  /**
   * The session every filesystem call is made *on behalf of*, or `undefined`.
   *
   * Sent with each read, write and watch so main can root at a worktree the
   * session moved into — including one kept **outside** the mapped project,
   * which the `root` prefix above cannot express and which used to leave the
   * tree quietly showing the wrong files.
   *
   * It is an id, never a path. Main answers from the cwd it observed itself,
   * and admits the wider root only after proving the directory is a linked git
   * worktree of this very project (`electron/main/fs/session-roots.ts`). The
   * renderer is asking a question here, not granting itself an answer.
   */
  sessionId?: string;
  /**
   * What the header should call the directory the tree is rooted at.
   *
   * Derived rather than inferred from `root`, because `root === ''` covers both
   * "the project root" and "somewhere a prefix cannot reach" — see
   * {@link rootDisplay}. The second of those is exactly the case the header was
   * getting wrong.
   */
  display: { suffix: string; full: string | null };
  /** The branch that session is on, if one has been observed. */
  branch?: string;
}

export function useExplorerProject(): ExplorerTarget {
  const entity = useActiveEntity();
  const projects = useProjects();

  const session = entity && isSession(entity) ? entity : null;

  /**
   * The session's project must still be one the config *maps*. A session naming
   * a project that has since been removed resolves to `null` and gets the empty
   * state, rather than a tree rooted at a path nothing can read.
   */
  const fromSession =
    session !== null
      ? (projects.find((project) => project.id === session.project) ?? null)
      : null;

  // Hooks cannot be called conditionally, so this runs on every render. It is
  // keyed on the session's own project, which is now the only project this hook
  // can answer with.
  const path = useProjectPath(fromSession?.id ?? '');

  if (fromSession) {
    return {
      project: fromSession,
      root: relativeRoot(path, session?.cwd),
      display: rootDisplay(path, session?.cwd),
      ...(session ? { sessionId: session.id } : {}),
      ...(session?.branch ? { branch: session.branch } : {}),
    };
  }

  return { project: null, root: '', display: { suffix: '', full: null } };
}

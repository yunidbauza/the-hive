import { useEffect, useState } from 'react';

import { hasFsBridge, readRoot } from '@lib/explorer/fs-client';

/**
 * Main's verdict on which root this project-and-session pairing reads under.
 *
 * ## Why this is asked rather than derived
 *
 * The renderer holds both inputs — the project's path and the session's cwd —
 * and for a while it drew its own conclusion from them: *cwd differs from the
 * project, therefore the tree is the session's worktree*. That inference is
 * wrong in the case that matters. Main widens the root only after proving the
 * cwd is a **registered linked worktree of that project**, and when the proof
 * fails — `/tmp`, an unrelated repository, a forged `.git`, no `git` on the
 * `PATH` — it serves the project root anyway. The renderer could not see the
 * refusal, so it labelled the project's own files with a worktree's name: the
 * right label over the wrong files, which is the exact untruth the explorer
 * header exists to prevent.
 *
 * So the verdict comes back from the side that makes it.
 *
 * ## What `key` is for
 *
 * A stable, short identifier for *which tree these paths are relative to*.
 * `''` means the project root — the value every pre-existing buffer, watcher
 * event and tree path already carried implicitly — and a widened root is
 * identified by its own absolute path.
 *
 * It exists because a relative path stopped being an identifier. `src/app.ts`
 * in a worktree and `src/app.ts` in the project are two different files with
 * the same `projectId` and the same `relPath`, so the editor's `projectId +
 * relPath` key collided and `openFile` would focus the wrong buffer — the user
 * editing and saving into a tree they were not looking at. The key restores the
 * dimension the roots took away, and it is `''` in the ordinary case so nothing
 * that existed before this change is re-keyed.
 *
 * ## The pending state
 *
 * `null` while the answer is in flight, and callers must not substitute `''`
 * for it: `''` is a *claim* that the tree is the project's, and acting on it
 * before main has answered is precisely the guess this hook removes. The
 * explorer holds its tree back for the one round trip instead.
 */
export interface ExplorerRoot {
  /** `''` for the project root; the worktree's absolute path when widened. */
  key: string;
  /** Whether main accepted the session's working directory as a second root. */
  widened: boolean;
  /** The directory itself, for the header's tooltip. */
  path: string;
}

export function useExplorerRoot(
  projectId: string | null,
  sessionId: string | undefined,
): ExplorerRoot | null {
  const [root, setRoot] = useState<ExplorerRoot | null>(null);

  useEffect(() => {
    if (projectId === null || !hasFsBridge()) {
      setRoot(null);
      return;
    }

    /*
      Cleared before the read, not after it. A stale answer under a new session
      is the whole failure mode this hook exists to prevent, and leaving the
      previous verdict on screen while a different session's is in flight would
      reintroduce it for the length of one round trip.
    */
    setRoot(null);

    let live = true;
    void readRoot(projectId, sessionId).then((result) => {
      if (!live) return;
      if (!result.ok) {
        /*
          A failure is not a widened root, and it is not a *refusal* either —
          the project may simply be unreadable, which the panel already reports
          from `useProjectAccess`. Answering with the project root keeps the
          tree's paths meaning what they have always meant.
        */
        setRoot({ key: '', widened: false, path: '' });
        return;
      }
      setRoot({
        key: result.value.widened ? result.value.root : '',
        widened: result.value.widened,
        path: result.value.root,
      });
    });

    return () => {
      live = false;
    };
  }, [projectId, sessionId]);

  return root;
}

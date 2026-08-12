import { useEffect, useState } from 'react';

import { readDir } from '@lib/explorer/fs-client';
import { sortEntries } from '@lib/explorer/sort';
import type { DirEntry } from '@shared/fs-contract';

export interface DirectoryState {
  entries: DirEntry[] | null;
  loading: boolean;
  error: string | null;
}

const IDLE: DirectoryState = { entries: null, loading: false, error: null };

/**
 * One directory's contents, read when it is expanded and not before.
 *
 * ## Why per node rather than one tree in a store
 *
 * A collapsed directory is never read, which is what makes opening a
 * repository cheap: the root is one `readdir`, and every level after it is
 * paid for by the click that asked for it. A store holding the whole tree
 * would have to decide *when* to walk it, and the only answers are "eagerly"
 * (expensive, and wrong for `node_modules`-sized trees even after filtering) or
 * "lazily, keyed by path" — which is this, with a reducer in front of it.
 *
 * The node also unmounts when collapsed, taking its state with it. That is the
 * intended lifetime: what persists across a collapse is the *expansion*, which
 * lives in `ui-store`, and re-reading on re-expand is how a tree stays honest
 * about a directory an agent has been editing.
 *
 * `refreshToken` is how the watcher and the ↻ button reach in. Changing it
 * re-runs the read for every mounted node at once — "re-read what is open",
 * which is deliberately simpler than diffing the changed paths against the
 * tree. The expanded set is small at this width, and a diff is a second model
 * of the filesystem that can disagree with the first.
 */
export function useDirectory(
  projectId: string,
  relPath: string,
  enabled: boolean,
  refreshToken: number,
): DirectoryState {
  const [state, setState] = useState<DirectoryState>(IDLE);

  useEffect(() => {
    if (!enabled) {
      setState(IDLE);
      return;
    }

    let cancelled = false;
    /**
     * `loading` is set without clearing `entries`.
     *
     * A refresh keeps the previous listing on screen while the new one is in
     * flight, so a watcher event during a `git checkout` does not blink the
     * whole tree to empty and back several times a second.
     */
    setState((previous) => ({ ...previous, loading: true }));

    void readDir(projectId, relPath).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setState({ entries: null, loading: false, error: result.error.message });
        return;
      }
      setState({ entries: sortEntries(result.value), loading: false, error: null });
    });

    return () => {
      cancelled = true;
    };
  }, [projectId, relPath, enabled, refreshToken]);

  return state;
}

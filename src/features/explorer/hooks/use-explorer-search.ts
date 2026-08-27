import { useEffect, useRef, useState } from 'react';

import { searchProject } from '@lib/explorer/fs-client';
import {
  MIN_QUERY_CHARS,
  type FsSearchMode,
  type SearchResults,
} from '@shared/fs-contract';

/**
 * Run the Explorer's search, debounced.
 *
 * ## Why 300ms, and why debounced at all
 *
 * The same number `pr-search-row.tsx` uses, for a sharper reason: a keystroke
 * here starts a **recursive walk of the project**. Firing one per character
 * would have four walks racing before the word is finished, and the first three
 * are answers nobody will read.
 *
 * ## The ticket, and why a boolean would not do
 *
 * Two searches can be in flight when a slow one is followed by a fast one, and
 * the slow one landing second would paint results for a query the box no longer
 * holds. A ticket compared on arrival makes an overlapping pair a wasted call
 * rather than a wrong list — the same guard `hive-store`'s `prSearchTicket`
 * documents for the identical race.
 *
 * ## What it deliberately does not do
 *
 * No caching, and no re-running on `fsRevision`. A search is a question asked
 * once about a tree that is not expected to move underneath it, and a walk
 * restarted by every watcher event on a `pnpm install` would be the most
 * expensive thing in the app.
 */

const DEBOUNCE_MS = 300;

export interface ExplorerSearchState {
  results: SearchResults | null;
  searching: boolean;
  error: string | null;
}

const IDLE: ExplorerSearchState = {
  results: null,
  searching: false,
  error: null,
};

export function useExplorerSearch(
  projectId: string | null,
  term: string,
  mode: FsSearchMode,
  enabled: boolean,
  sessionId?: string,
): ExplorerSearchState {
  const [state, setState] = useState<ExplorerSearchState>(IDLE);
  const ticket = useRef(0);

  const query = term.trim();

  useEffect(() => {
    if (!enabled || projectId === null || query.length < MIN_QUERY_CHARS) {
      // Cancels whatever is in flight: a stale ticket is ignored on arrival.
      ticket.current += 1;
      setState(IDLE);
      return;
    }

    const mine = (ticket.current += 1);
    setState((previous) => ({ ...previous, searching: true, error: null }));

    const timer = setTimeout(() => {
      void searchProject(projectId, query, mode, sessionId).then((result) => {
        if (ticket.current !== mine) return;
        setState(
          result.ok
            ? { results: result.value, searching: false, error: null }
            : { results: null, searching: false, error: result.error.message },
        );
      });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [enabled, projectId, query, mode, sessionId]);

  return state;
}

import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';

import { GH_MERGED_PAGE, GH_OPEN_PAGE } from '@shared/github-contract';
import {
  usePrSearch,
  useSearchPrs,
  useClearPrSearchResults,
} from '@stores/hive-store';
import {
  useClearPrSearch,
  usePrSearchAllRepos,
  usePrSearchTerm,
  useSetPrSearchAllRepos,
  useSetPrSearchTerm,
} from '@stores/ui-store';

/**
 * How long the box waits after a keystroke before asking GitHub.
 *
 * Every search is a `gh api graphql` subprocess, so a search-as-you-type box
 * with no debounce spawns one per character. 300ms is the usual floor for
 * "stopped typing" without the box feeling laggy — and the store drops a stale
 * answer anyway, so the cost of an overlapping pair is a wasted call rather
 * than a wrong list.
 */
const DEBOUNCE_MS = 300;

interface PrSearchRowProps {
  /**
   * The active session's project, or `null` when no session is being watched.
   *
   * `null` is what makes the checkbox checked-and-disabled: there is no
   * narrower scope to offer, so the honest default is every mapped project and
   * the control says so rather than pretending the choice exists.
   */
  projectId: string | null;
}

/**
 * The PRs panel's search box, and the one control that widens it.
 *
 * ## What a search is, and is not
 *
 * The list below this row is a sweep for `author:@me` — the user's own work,
 * kept current by a poller. A search drops the author entirely: *anything*
 * matching, whoever wrote it. That is the request, and it is why searching
 * cannot be a filter over what is already on screen. It is a second query.
 *
 * What a search never does is leave the user's own projects. Empty box or full,
 * checkbox on or off, the expression main builds is scoped with `repo:`
 * qualifiers composed from the config. "All repos" means all of *yours*.
 *
 * ## The checkbox rather than a scope menu
 *
 * Unchecked — the default — searches the active session's project. Checked,
 * every mapped project. The scope resets when the box is cleared or the session
 * changes, so a wide search asked once does not silently govern the next
 * question; `ui-store` owns that rule, because it owns the term.
 */
export function PrSearchRow({ projectId }: PrSearchRowProps) {
  const term = usePrSearchTerm();
  const allRepos = usePrSearchAllRepos();
  const setTerm = useSetPrSearchTerm();
  const setAllRepos = useSetPrSearchAllRepos();
  const clearTerm = useClearPrSearch();

  const search = usePrSearch();
  const runSearch = useSearchPrs();
  const clearResults = useClearPrSearchResults();

  /**
   * No session means no narrower scope, so the search is over everything
   * whatever the checkbox says. Held as one boolean rather than read twice,
   * because the control's `checked` and the query's scope must never disagree.
   */
  const noSession = projectId === null;
  const wide = allRepos || noSession;

  /*
    The session changing resets the scope, for the same reason clearing the box
    does: the scope belonged to a question about the session the user was
    watching, and they are now watching another.

    Guarded on the *previous* project rather than run on every mount. The term
    lives in `ui-store` and survives this component, but the component itself
    unmounts on a rail-tab switch — so an unguarded effect would silently
    uncheck "All repos" and re-query narrowed every time the user left the PRs
    tab and came back, which is a scope change they did not make.
  */
  const lastProject = useRef<string | null>(projectId);

  useEffect(() => {
    if (lastProject.current === projectId) return;
    lastProject.current = projectId;
    setAllRepos(false);
  }, [projectId, setAllRepos]);

  /**
   * The debounce, and the effect that owns it.
   *
   * Keyed on the term *and* the scope, so ticking the checkbox re-runs the
   * search that is already on screen rather than leaving a result set that no
   * longer matches its own control. Clearing the box clears the results
   * immediately — there is nothing to wait for, and a stale list under an empty
   * box would be the panel contradicting itself.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (term === '') {
      clearResults();
      return;
    }

    timer.current = setTimeout(() => {
      void runSearch(term, wide ? undefined : (projectId ?? undefined));
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [term, wide, projectId, runSearch, clearResults]);

  const count = search.results?.length ?? 0;

  /**
   * Whether GitHub had more to say than it was asked for.
   *
   * The two search connections take a page each, so a result set that fills
   * both is the one case where the count is not the answer — it is the *cap*.
   * Printing a confident "200 results" over a truncated set is the same class
   * of untruth as a tree that shows the wrong files without saying so, which is
   * what most of this change is about.
   */
  const capped = count >= GH_OPEN_PAGE + GH_MERGED_PAGE;

  return (
    <div className="flex shrink-0 flex-col gap-1.5 pb-1">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-panel-2 px-2 py-1.5 focus-within:border-brand">
        <MagnifyingGlass size={12} className="shrink-0 text-subtle" />
        <input
          type="search"
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
          }}
          placeholder="Search pull requests"
          aria-label="Search pull requests"
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink outline-none placeholder:text-subtle"
        />
        {term === '' ? null : (
          <button
            type="button"
            onClick={clearTerm}
            className="shrink-0 rounded-[4px] text-subtle hover:text-ink"
          >
            <X size={11} />
            <span className="sr-only">Clear the search</span>
          </button>
        )}
      </div>

      {/*
        The second line is only drawn while a search is on, because with an
        empty box it would be a control for something that is not happening —
        and the scope it names would be a claim about a list nobody asked for.
      */}
      {term === '' ? null : (
        <div className="flex items-center justify-between gap-2 px-0.5">
          <label
            className={`flex items-center gap-1.5 text-[10.5px] ${
              noSession ? 'text-subtle' : 'cursor-pointer text-muted'
            }`}
            title={
              noSession
                ? 'No session is being watched, so there is no single project to search.'
                : 'Search every mapped project instead of this session’s.'
            }
          >
            <input
              type="checkbox"
              checked={wide}
              disabled={noSession}
              onChange={(event) => {
                setAllRepos(event.target.checked);
              }}
              className="size-3 accent-[var(--cc-brand-fill)]"
            />
            All repos
          </label>

          {/*
            The count says "all authors" in words. The whole point of the row is
            that it returns work the panel above it never shows, and a bare
            number would leave the user to infer that from the results.
          */}
          <span className="tabular-nums text-[10.5px] text-subtle">
            {search.searching
              ? 'Searching…'
              : search.error !== null
                ? ''
                : `${String(count)}${capped ? '+' : ''} ${count === 1 ? 'result' : 'results'} · all authors`}
          </span>
        </div>
      )}
    </div>
  );
}

import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';

import {
  useClearTicketSearchResults,
  useSearchTickets,
  useTicketSearch,
} from '@stores/hive-store';
import {
  useClearWorkSearch,
  useSetWorkSearchMineOnly,
  useSetWorkSearchTerm,
  useWorkSearchMineOnly,
  useWorkSearchTerm,
} from '@stores/ui-store';

/**
 * How long the box waits after a keystroke before asking Jira.
 *
 * The PRs row's reasoning, with a different cost behind it: every search is an
 * HTTPS round trip to Atlassian rather than a `gh` subprocess, and Jira rate
 * limits. 300ms is the usual floor for "stopped typing" without the box feeling
 * laggy, and the store drops a stale answer anyway — so an overlapping pair
 * costs a wasted call rather than a wrong list.
 */
const DEBOUNCE_MS = 300;

/**
 * The WORK panel's search box, and the one control that narrows it.
 *
 * ## What a search is, and is not
 *
 * The list below this row is the configured JQL — by default the user's own
 * unfinished work, kept current by a poller. A search drops the assignee and
 * the status filter entirely: *anything* matching, whoever it belongs to,
 * finished or not. That is the request, and it is why searching cannot be a
 * filter over what is already on screen. It is a second query.
 *
 * The PRs panel says the same thing about its own box, and the symmetry is
 * deliberate: the two panels answer "what am I shipping" and "what am I working
 * on", and a search in either means "and what about that other thing".
 *
 * ## What it matches, and why that is not obvious
 *
 * A ticket number, a word in a summary, a word in a description — assembled
 * into JQL by `lib/jira-search.ts`, which is where the surprises live. The two
 * worth knowing here: Jira's `~` matches whole words, so the query carries a
 * wildcard or the box finds nothing until a word is finished; and an issue key
 * is not in the text index at all, so a ticket number needs its own clause.
 *
 * ## The checkbox rather than a scope menu
 *
 * Unchecked — the default — searches every issue the user can see. Checked,
 * only their own. Unchecked is the default because the standing list *already*
 * answers "what is assigned to me": a search that could not leave it would
 * never answer the question people actually open a search box for, which is
 * "which ticket was that again". The scope resets when the box is cleared, so a
 * narrow search asked once does not silently govern the next; `ui-store` owns
 * that rule, because it owns the term.
 */
export function WorkSearchRow() {
  const term = useWorkSearchTerm();
  const mineOnly = useWorkSearchMineOnly();
  const setTerm = useSetWorkSearchTerm();
  const setMineOnly = useSetWorkSearchMineOnly();
  const clearTerm = useClearWorkSearch();

  const search = useTicketSearch();
  const runSearch = useSearchTickets();
  const clearResults = useClearTicketSearchResults();

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
      void runSearch(term, mineOnly);
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [term, mineOnly, runSearch, clearResults]);

  const count = search.results?.length ?? 0;

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
          onKeyDown={(event) => {
            // Escape empties the box rather than closing anything: the panel is
            // a rail tab, not an overlay, and there is nothing to dismiss.
            if (event.key !== 'Escape' || term === '') return;
            event.preventDefault();
            clearTerm();
          }}
          placeholder="Search tickets"
          aria-label="Search tickets"
          spellCheck={false}
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
            className="flex cursor-pointer items-center gap-1.5 text-[10.5px] text-muted"
            title="Search only the tickets assigned to you."
          >
            <input
              type="checkbox"
              checked={mineOnly}
              onChange={(event) => {
                setMineOnly(event.target.checked);
              }}
              className="size-3 accent-[var(--cc-brand-fill)]"
            />
            Mine only
          </label>

          {/*
            The count says "all assignees" in words. The whole point of the row
            is that it returns work the panel above it never shows — anyone's,
            at any status — and a bare number would leave the user to infer that
            from the results.

            `capped` earns its `+` for the reason the standing list gives: main
            stops paging at `JIRA_MAX_ISSUES`, so a full page is a *floor* and
            not a total. A prefix search across summary and description is
            exactly the query that reaches it.

            `tooShort` is the state that has no count at all. It is not zero
            results — nothing was asked — and saying "0 issues" would be the row
            answering a question it never put.
          */}
          <span className="tabular-nums text-[10.5px] text-subtle">
            {search.tooShort
              ? 'Keep typing…'
              : search.searching
                ? 'Searching…'
                : search.error !== null
                  ? ''
                  : `${String(count)}${search.capped ? '+' : ''} ${
                      count === 1 && !search.capped ? 'issue' : 'issues'
                    }${mineOnly ? '' : ' · all assignees'}`}
          </span>
        </div>
      )}
    </div>
  );
}

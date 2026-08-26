import { ArrowClockwise } from '@phosphor-icons/react';

import { usePrRefresh } from '@/hooks/use-pr-refresh';
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh';
import { isSession } from '@/types/entity';

import { EmptyState } from '@components/ui/empty-state';
import { PullIndicator } from '@components/ui/pull-indicator';
import { PrCard } from '@features/pull-requests/components/pr-card';
import { PrListSkeleton } from '@features/pull-requests/components/pr-card-skeleton';
import { PrSearchRow } from '@features/pull-requests/components/pr-search-row';
import {
  useActiveEntity,
  usePrs,
  usePrSearch,
  usePrSearchResults,
  usePrSource,
  useRefreshPrs,
  type PrSource,
} from '@stores/hive-store';
import { usePrSearchTerm } from '@stores/ui-store';

/**
 * Every PR the fleet has open — what is shippable, and what is blocked.
 *
 * ## Where they come from
 *
 * A `gh api graphql` sweep of the configured project repositories, in the main
 * process, polled once a minute by a shared timer (`hooks/use-pr-refresh.ts`).
 * This panel used to read four seeded rows naming repositories the user did not
 * have; those are gone, and with them the last reason the PR list and the WORK
 * tab could disagree about the same number.
 *
 * The list is still the single source of truth both surfaces resolve against —
 * `usePrs()` here, `useTicketPrs()` on a ticket card — so a PR approved while
 * only one of them is open updates both.
 */

/** The line above the list. `null` when there is nothing worth saying. */
function SourceNotice({
  source,
  onRetry,
}: {
  source: PrSource;
  onRetry: () => void;
}) {
  // The skeleton below is the whole message while the first sweep is out.
  if (source.kind === 'loading') return null;

  /*
    Not an error, and it must not read as one. Three different setups land
    here — no `gh`, a `gh` that is not logged in, and no project that is a
    GitHub repository — and main writes the sentence for each, because it is
    the side that knows which one happened.
  */
  /*
    Through `EmptyState`, so it looks like the other empty PR state (HIVE-93).

    This branch was a bare `<p>` while the *no open PRs* state a few dozen lines
    down already had `phrase` + `creature="spire"`. Both are "this panel has
    nothing to show you", so the panel contradicted itself depending on *why* —
    an unconfigured setup got a plain sentence on a blank column, and a
    configured one with no PRs got the full treatment.

    `source.message` is passed through untouched: main writes it because main is
    the side that knows which of the three setups happened — no `gh`, a `gh` that
    is not logged in, or no project that is a GitHub repository. This adds the
    frame around that sentence and does not second-guess it.
  */
  if (source.kind === 'unconfigured') {
    return (
      <EmptyState phrase="empty.pullRequests" creature="spire">
        {source.message}
      </EmptyState>
    );
  }

  if (source.kind === 'failed') {
    return (
      <div className="flex flex-col items-start gap-1 px-1 pb-1">
        <p className="text-[11.5px] leading-[1.45] text-amber">
          {source.message}
        </p>
        <RetryButton onRetry={onRetry} />
      </div>
    );
  }

  if (source.stale) {
    return (
      <div className="flex flex-col items-start gap-1 px-1 pb-1">
        <p className="text-[11.5px] leading-[1.45] text-amber">
          Could not reach GitHub. These may be out of date.
        </p>
        <RetryButton onRetry={onRetry} />
      </div>
    );
  }

  return null;
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="flex items-center gap-1 rounded-[5px] border border-border px-1.5 py-0.5 text-[11px] text-muted hover:bg-hover hover:text-ink"
    >
      <ArrowClockwise size={11} />
      Try again
    </button>
  );
}

export function PrsPanel() {
  const prs = usePrs();
  const source = usePrSource();
  const refresh = useRefreshPrs();
  const search = usePrSearch();
  const results = usePrSearchResults();
  const term = usePrSearchTerm();

  /**
   * Which project a narrow search means.
   *
   * The active session's, which is the same rule the explorer follows — the
   * app is organised around "which session am I watching", and a second
   * selector for the search would be one more thing to keep in step with the
   * first. `null` when nothing is being watched, which the row renders as a
   * checked, disabled "All repos".
   */
  const entity = useActiveEntity();
  const projectId = entity && isSession(entity) ? entity.project : null;

  /** A search replaces the list rather than filtering it — see `PrSearchRow`. */
  const searching = term !== '';

  /*
    Subscribes this panel to the shared poller: reads now if nothing else was
    already polling, and keeps the timer alive while the tab is open. The WORK
    panel holds the same subscription, so closing this one does not stop the
    ticket cards from staying current.
  */
  usePrRefresh();

  const retry = () => {
    void refresh();
  };

  /*
    Overscrolling the top of the list forces a sweep.

    Off during a search and during the first load. A search replaces the list
    rather than filtering it, so pulling there would refresh a list the user
    cannot currently see — and the results it *can* see would not move, which
    reads as the gesture being broken rather than as it having done something
    elsewhere.
  */
  const pull = usePullToRefresh({
    onRefresh: refresh,
    disabled: searching || source.kind === 'loading',
  });

  /*
    The skeleton *replaces* the list rather than sitting above it, and only on
    the first sweep — `loading` is only ever set when the source is not already
    live, so a refresh with rows on screen keeps them.
  */
  if (source.kind === 'loading' && !searching) {
    return (
      <div data-panel="prs" className="flex flex-col gap-[var(--cc-list-gap-sm)]">
        <PrSearchRow projectId={projectId} />
        <PrListSkeleton />
      </div>
    );
  }

  /*
    A search takes the panel over completely: its own results, its own empty
    state, and none of the sweep's notices. Those notices are about the standing
    list — "these may be out of date", "no project is a GitHub repository" — and
    none of them describes what a search just did.
  */
  if (searching) {
    return (
      <div data-panel="prs" className="flex flex-col gap-[var(--cc-list-gap-sm)]">
        <PrSearchRow projectId={projectId} />

        {search.error !== null ? (
          <p className="px-1 pb-1 text-[11.5px] leading-[1.45] text-amber">
            {search.error}
          </p>
        ) : null}

        {/*
          The skeleton stands in only for the **first** answer, while `results`
          is still `null`. A re-search — narrowing, widening, another keystroke —
          keeps the rows it has, which is the same rule the sweep's skeleton
          follows: replacing a live list with grey boxes makes the panel blink
          for something the user can already see.

          Without this the first keystroke left the panel blank for the whole
          debounce plus the round trip, because the search branch is entered on
          the term rather than on a request being out.
        */}
        {results === null && search.error === null ? <PrListSkeleton /> : null}

        {results?.map((pr) => <PrCard key={pr.url} pr={pr} />)}

        {search.error === null && !search.searching && results?.length === 0 ? (
          <EmptyState phrase="empty.pullRequests" creature="spire">
            Nothing matches “{term}”.
          </EmptyState>
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={pull.ref}
      data-panel="prs"
      className="flex flex-col gap-[var(--cc-list-gap-sm)]"
    >
      <PullIndicator distance={pull.distance} phase={pull.phase} />

      <PrSearchRow projectId={projectId} />
      <SourceNotice source={source} onRetry={retry} />

      {/*
        Keyed on the URL, which is unique by construction. `repo#number` is not:
        the contract keeps `owner` precisely because two configured repositories
        can share a short name, and two `docs` repos under different owners with
        the same PR number would collide — React would reconcile one card's DOM
        onto the other's data.
      */}
      {prs.map((pr) => (
        <PrCard key={pr.url} pr={pr} />
      ))}

      {/*
        An empty sweep is an answer — "nothing of yours is open" — and it is one
        a user can act on only if the panel says it. `repos` is included because
        the two ways to have no PRs read very differently: none open across four
        repositories is good news, and none open across zero repositories means
        the app is looking in the wrong place.
      */}
      {prs.length === 0 && source.kind === 'live' ? (
        <EmptyState phrase="empty.pullRequests" creature="spire">
          No open pull requests of yours across{' '}
          {source.repos === 1
            ? '1 repository'
            : `${String(source.repos)} repositories`}
          .
        </EmptyState>
      ) : null}
    </div>
  );
}

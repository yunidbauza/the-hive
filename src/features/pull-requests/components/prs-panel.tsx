import { ArrowClockwise } from '@phosphor-icons/react';

import { usePrRefresh } from '@/hooks/use-pr-refresh';

import { PrCard } from '@features/pull-requests/components/pr-card';
import { PrListSkeleton } from '@features/pull-requests/components/pr-card-skeleton';
import { usePrs, usePrSource, useRefreshPrs, type PrSource } from '@stores/hive-store';

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
  if (source.kind === 'unconfigured') {
    return (
      <p className="px-1 pb-1 text-[11.5px] leading-[1.45] text-subtle">
        {source.message}
      </p>
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
    The skeleton *replaces* the list rather than sitting above it, and only on
    the first sweep — `loading` is only ever set when the source is not already
    live, so a refresh with rows on screen keeps them.
  */
  if (source.kind === 'loading') {
    return (
      <div data-panel="prs" className="flex flex-col gap-[var(--cc-list-gap-sm)]">
        <PrListSkeleton />
      </div>
    );
  }

  return (
    <div data-panel="prs" className="flex flex-col gap-[var(--cc-list-gap-sm)]">
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
        <p className="px-1 text-[11.5px] leading-[1.45] text-subtle">
          No open pull requests of yours across{' '}
          {source.repos === 1 ? '1 repository' : `${String(source.repos)} repositories`}.
        </p>
      ) : null}
    </div>
  );
}

import { ArrowClockwise } from '@phosphor-icons/react';
import { type ReactNode } from 'react';

import { usePrRefresh } from '@/hooks/use-pr-refresh';
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh';
import { useTicketRefresh } from '@/hooks/use-ticket-refresh';

import { EmptyState } from '@components/ui/empty-state';
import { PullIndicator } from '@components/ui/pull-indicator';
import { SwarmLine } from '@components/ui/swarm-line';
import { TicketCard } from '@features/work/components/ticket-card';
import { TicketListSkeleton } from '@features/work/components/ticket-card-skeleton';
import { WorkSearchRow } from '@features/work/components/work-search-row';
import {
  useRefreshTickets,
  useTicketSearch,
  useTicketSource,
  useTickets,
  type TicketSource,
} from '@stores/hive-store';
import { useWorkSearchTerm } from '@stores/ui-store';

/**
 * Work panel — one card per ticket, with its linked sessions and PRs.
 *
 * Navigation by "what I'm shipping" rather than by repo: the same fleet the
 * projects panel groups by project, grouped by work item instead.
 *
 * ## Where the tickets come from (HIVE-69)
 *
 * This file still does one thing — map over `useTickets()`. Every ticket in that
 * array is a real Jira issue; there is no seeded alternative any more, which is
 * what lets the panel treat "nothing yet" as *loading* rather than as data.
 *
 * What this file did gain is the notice above the list, because four of the five
 * source states have something to say and an empty panel says none of it.
 *
 * ## The flash this fixed
 *
 * The store used to boot with eight seeded tickets and a `fixtures` source, so
 * opening the tab painted sample rows for a frame and then swapped them for the
 * real answer. The seed is gone and `loading` took its place: the panel now
 * shows a skeleton until the read resolves, and never shows an issue it did not
 * get from Jira.
 *
 * ## Refreshed on open, and every minute after (HIVE-81)
 *
 * `left-rail.tsx` swaps panels by unmounting them, so mounting *is* the pane
 * opening — the first read is exactly as prompt as the user looking at it. It
 * used to stop there, on the argument that a Jira issue moves when a human
 * moves it, which is roughly never while the panel is open. The premise is
 * false in the way that matters: other people assign you work, and this app's
 * own sessions file tickets. `useTicketRefresh` keeps it current for as long as
 * the panel stays open, on the same shared-timer poller the PR rows already
 * used.
 */

/** The line above the list. `null` when there is nothing worth saying. */
function SourceNotice({
  source,
  onRetry,
}: {
  source: TicketSource;
  onRetry: () => void;
}) {
  // The skeleton below is the whole message while a read is in flight.
  if (source.kind === 'loading') return null;

  if (source.kind === 'unconfigured') {
    return (
      <div className="flex flex-col gap-[3px] pb-1">
        <SwarmLine phraseKey="empty.workUnconfigured" />
        <p className="px-1 text-[11.5px] leading-[1.45] text-subtle">
          No Jira connection yet. Add your site and an API token in{' '}
          <span className="text-muted">Settings → Integrations</span>.
        </p>
      </div>
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
          Could not reach Jira. These may be out of date.
        </p>
        <RetryButton onRetry={onRetry} />
      </div>
    );
  }

  if (source.capped) {
    return (
      <p className="px-1 pb-1 text-[11.5px] leading-[1.45] text-subtle">
        Showing the first 200 — your query matched more.
      </p>
    );
  }

  return null;
}

/**
 * The panel's frame: a header that stays put, over a list that scrolls.
 *
 * This panel used to have no header at all, which is why it was deliberately
 * left out of the equivalent change to the PRs panel — its cards scrolling in
 * the rail's own container was already right. A search box changes that: the
 * rail's `role="tabpanel"` wrapper scrolls whatever it holds, so the box would
 * travel upward with the results, out of reach of the list it controls.
 *
 * Filling the rail's height exactly is what fixes it — the outer scroller then
 * has nothing to scroll and never engages. Duplicated from `prs-panel.tsx`
 * rather than shared: the two slices are fenced from each other by design, and
 * a twenty-line frame in `features/shared` would be a dependency between them
 * for less code than the import costs.
 */
function WorkLayout({
  header,
  listRef,
  children,
}: {
  header: ReactNode;
  /** Goes *inside* the scroller, so `usePullToRefresh` finds it walking up. */
  listRef?: (node: HTMLElement | null) => void;
  children: ReactNode;
}) {
  return (
    <div
      data-panel="work"
      className="flex h-full min-h-0 flex-col gap-[var(--cc-list-gap)]"
    >
      <div className="shrink-0">{header}</div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div ref={listRef} className="flex flex-col gap-[var(--cc-list-gap)]">
          {children}
        </div>
      </div>
    </div>
  );
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

export function WorkPanel() {
  const tickets = useTickets();
  const source = useTicketSource();
  const refresh = useRefreshTickets();
  const search = useTicketSearch();
  const term = useWorkSearchTerm();

  /** A search replaces the list rather than filtering it — see `WorkSearchRow`. */
  const searching = term !== '';

  /*
    Both halves of a ticket card are polled now (HIVE-81).

    They used to be asymmetric: PR rows shared the minute poller while the
    ticket they sat on was read once, on mount. The argument was that a Jira
    issue only moves when a human moves it — true, and irrelevant, because the
    human is often not you. A ticket assigned to you while this panel sits open
    never appeared at all, and the only affordance to force a read is the retry
    button, which shows up solely on a failed or stale source. Restarting the
    app was the remedy, which is not one.

    Two subscriptions rather than one call: each poller owns its own timer, so
    closing the PRS tab does not stop ticket rows updating and vice versa.
  */
  useTicketRefresh();
  usePrRefresh();

  const retry = () => {
    void refresh();
  };

  /*
    Overscrolling the top of the list forces a read, rather than waiting out
    the minute. Disabled while the first sweep is still running: there is no
    list to pull yet, and the skeleton below replaces the panel wholesale.
  */
  const pull = usePullToRefresh({
    onRefresh: refresh,
    // Off during a search, for the reason the PRs panel gives: pulling would
    // refresh a list the user cannot currently see, and the rows they *can* see
    // would not move — which reads as the gesture being broken rather than as
    // it having done something elsewhere.
    disabled: source.kind === 'loading' || searching,
  });

  /*
    The skeleton *replaces* the list rather than sitting above it.

    On the first read there is nothing to sit above, and on a retry the list is
    whatever the last read returned — showing both would mean stale rows and a
    loading state claiming different things at once. This panel shows one
    answer at a time.

    Not while searching, though: the search owns the panel, and its own results
    are what the user is waiting for.
  */
  if (source.kind === 'loading' && !searching) {
    return (
      <WorkLayout header={<WorkSearchRow />}>
        <TicketListSkeleton />
      </WorkLayout>
    );
  }

  /*
    A search takes the panel over completely: its own results, its own empty
    state, and none of the sweep's notices. Those notices are about the standing
    list — "no Jira connection yet", "these may be out of date" — and none of
    them describes what a search just did.
  */
  if (searching) {
    const results = search.results;

    return (
      <WorkLayout header={<WorkSearchRow />}>
        {search.error !== null ? (
          <p className="px-1 pb-1 text-[11.5px] leading-[1.45] text-amber">
            {search.error}
          </p>
        ) : null}

        {/*
          The skeleton stands in only for the **first** answer, while `results`
          is still `null`. A re-search — narrowing with "Mine only", another
          keystroke — keeps the rows it has, which is the same rule the sweep's
          skeleton follows: replacing a live list with grey boxes makes the
          panel blink for something the user can already see.

          Never while `tooShort`, which is also `results === null` but for the
          opposite reason: nothing is on its way, so the skeleton would pulse
          forever over a request that was deliberately not made. The row says
          "Keep typing…" instead, which is the honest version of the same news.
        */}
        {results === null && search.error === null && !search.tooShort ? (
          <TicketListSkeleton />
        ) : null}

        {results?.map((ticket) => (
          <TicketCard key={ticket.key} ticket={ticket} />
        ))}

        {search.error === null && !search.searching && results?.length === 0 ? (
          <EmptyState phrase="empty.work" creature="spire">
            Nothing matches “{term}”.
          </EmptyState>
        ) : null}
      </WorkLayout>
    );
  }

  return (
    <WorkLayout header={<WorkSearchRow />} listRef={pull.ref}>
      <PullIndicator distance={pull.distance} phase={pull.phase} />

      <SourceNotice source={source} onRetry={retry} />

      {tickets.map((ticket) => (
        <TicketCard key={ticket.key} ticket={ticket} />
      ))}

      {/*
        An empty live result is not a failure and not a misconfiguration — it is
        a query that matched nothing, which is a thing a user can act on only if
        the panel says so rather than showing a blank column.
      */}
      {tickets.length === 0 && source.kind === 'live' ? (
        <EmptyState phrase="empty.work" creature="spire">
          No issues matched your query.
        </EmptyState>
      ) : null}
    </WorkLayout>
  );
}

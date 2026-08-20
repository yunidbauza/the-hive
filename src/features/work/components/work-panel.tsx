import { ArrowClockwise } from '@phosphor-icons/react';

import { usePrRefresh } from '@/hooks/use-pr-refresh';
import { useTicketRefresh } from '@/hooks/use-ticket-refresh';

import { EmptyState } from '@components/ui/empty-state';
import { SwarmLine } from '@components/ui/swarm-line';
import { TicketCard } from '@features/work/components/ticket-card';
import { TicketListSkeleton } from '@features/work/components/ticket-card-skeleton';
import {
  useRefreshTickets,
  useTicketSource,
  useTickets,
  type TicketSource,
} from '@stores/hive-store';

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
    The skeleton *replaces* the list rather than sitting above it.

    On the first read there is nothing to sit above, and on a retry the list is
    whatever the last read returned — showing both would mean stale rows and a
    loading state claiming different things at once. This panel shows one
    answer at a time.
  */
  if (source.kind === 'loading') {
    return (
      <div data-panel="work" className="flex flex-col gap-[var(--cc-list-gap)]">
        <TicketListSkeleton />
      </div>
    );
  }

  return (
    <div data-panel="work" className="flex flex-col gap-[var(--cc-list-gap)]">
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
    </div>
  );
}

import { ArrowClockwise } from '@phosphor-icons/react';
import { useEffect } from 'react';

import { TicketCard } from '@features/work/components/ticket-card';
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
 * This file still does one thing — map over `useTickets()`. What changed is the
 * *source*, which is the payoff of the store's rule that fixtures are store-only
 * consumers: on desktop the array is real Jira issues, in the browser demo it is
 * still the eight fixtures, and nothing here has to know which.
 *
 * What this file did gain is the notice above the list, because four of the five
 * source states have something to say and an empty panel says none of it.
 *
 * ## Refreshed on open, and not otherwise
 *
 * `left-rail.tsx` swaps panels by unmounting them, so mounting *is* the pane
 * opening — the refresh is exactly as frequent as the user looking at it, with
 * no extra plumbing. Not polled, for the reason `integrations-section.tsx`
 * writes down at length for its `gh` status: a request per interval is a request
 * per interval forever, and nothing outside the app changes these on that
 * timescale.
 */

/** The line above the list. `null` when there is nothing worth saying. */
function SourceNotice({
  source,
  onRetry,
}: {
  source: TicketSource;
  onRetry: () => void;
}) {
  // The demo. Fixtures are its data, not a degraded mode, so it says nothing.
  if (source.kind === 'fixtures') return null;

  if (source.kind === 'unconfigured') {
    return (
      <p className="px-1 pb-1 text-[11.5px] leading-[1.45] text-subtle">
        No Jira connection yet. Add your site and an API token in{' '}
        <span className="text-muted">Settings → Integrations</span>.
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

  /**
   * One read on open. `refreshTickets` returns immediately in the browser
   * target, so the demo pays nothing for this.
   */
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const retry = () => {
    void refresh();
  };

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
        <p className="px-1 text-[11.5px] leading-[1.45] text-subtle">
          No issues matched your query.
        </p>
      ) : null}
    </div>
  );
}

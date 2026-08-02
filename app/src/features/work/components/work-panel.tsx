import { TicketCard } from '@features/work/components/ticket-card';
import { useTickets } from '@stores/hive-store';

/**
 * Work panel — one card per ticket, with its linked sessions and PRs.
 *
 * Navigation by "what I'm shipping" rather than by repo: the same fleet the
 * projects panel groups by project, grouped by work item instead.
 */
export function WorkPanel() {
  const tickets = useTickets();

  return (
    <div data-panel="work" className="flex flex-col gap-2.5">
      {tickets.map((ticket) => (
        <TicketCard key={ticket.key} ticket={ticket} />
      ))}
    </div>
  );
}

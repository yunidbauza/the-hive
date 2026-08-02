import { cn } from '@/lib/utils';
import type { Ticket } from '@/types/ticket';

import { TicketPrRow } from '@features/work/components/ticket-pr-row';
import { TicketSessionRow } from '@features/work/components/ticket-session-row';
import { useTicketPrs } from '@stores/hive-store';

const STATUS_TEXT: Record<Ticket['status'], string> = {
  'To Do': 'text-subtle',
  'In Progress': 'text-brand',
  'In Review': 'text-amber',
  Done: 'text-green',
};

interface TicketCardProps {
  ticket: Ticket;
}

/**
 * One work item: its key and status, its title, the sessions working it, and
 * the PRs those sessions opened.
 *
 * The PR section — divider included — is omitted entirely when no linked
 * session has a PR. A divider with nothing under it reads as a rendering bug,
 * which is why the story calls it out explicitly.
 */
export function TicketCard({ ticket }: TicketCardProps) {
  const prs = useTicketPrs(ticket.key);

  return (
    <article className="flex flex-col gap-[7px] rounded-xl border border-border-soft px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] font-bold text-brand">
          {ticket.key}
        </span>

        <span className="flex-1" />

        <span
          className={cn(
            'shrink-0 rounded-full bg-chip px-[9px] py-0.5 text-[10px] font-bold uppercase tracking-[0.05em]',
            STATUS_TEXT[ticket.status],
          )}
        >
          {ticket.status}
        </span>
      </div>

      <h3 className="text-[12.5px] leading-[1.4] text-ink">{ticket.title}</h3>

      <div className="flex flex-col">
        {ticket.sessions.map((id) => (
          <TicketSessionRow key={id} id={id} />
        ))}
      </div>

      {prs.length > 0 ? (
        <div className="flex flex-col border-t border-border-soft pt-1">
          {prs.map((pr) => (
            <TicketPrRow key={pr.n} pr={pr} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

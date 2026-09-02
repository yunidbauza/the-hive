import { cn } from '@/lib/utils';
import type { Ticket } from '@/types/ticket';

import { TicketConversation } from '@features/work/components/ticket-conversation';
import { TicketNewSessionLink } from '@features/work/components/ticket-new-session-link';
import { TicketPrRow } from '@features/work/components/ticket-pr-row';
import { TicketSessionRow } from '@features/work/components/ticket-session-row';
import { TicketTransitionMenu } from '@features/work/components/ticket-transition-menu';
import { CATEGORY_TEXT, STATUS_PILL } from '@features/work/ticket-presentation';
import { useTicketPrs, useTicketSessions } from '@stores/hive-store';

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
  const sessions = useTicketSessions(ticket.key);
  const prs = useTicketPrs(ticket.key);

  return (
    <article className="flex flex-col gap-[7px] rounded-xl border border-border-soft px-3 py-[var(--cc-card-py)]">
      <div className="flex items-center gap-2">
        {ticket.url === undefined ? (
          <span className="font-mono text-[12px] font-bold text-brand">
            {ticket.key}
          </span>
        ) : (
          /*
            A real issue links out; a fixture has nowhere to go. The URL was
            built in main, so the renderer never had to learn the site.
          */
          <a
            href={ticket.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[12px] font-bold text-brand hover:underline"
          >
            {ticket.key}
          </a>
        )}

        <span className="flex-1" />

        {/*
          One lozenge, two renderings (HIVE-79).

          On a **real** issue the lozenge is the transition menu's trigger, so
          the row holds the key and the status and nothing else — that is what
          stopped the key wrapping on a 320px rail.

          On a **fixture** it is inert text. A fixture has no Jira behind it, so
          an interactive lozenge would be a control that cannot work — the same
          "absent rather than disabled" rule the notification switches follow
          when the OS cannot show one (HIVE-70). Both spellings share
          `STATUS_PILL`, so the two are the same size and the card does not
          resize depending on where its ticket came from.
        */}
        {ticket.url === undefined ? (
          <span className={cn(STATUS_PILL, CATEGORY_TEXT[ticket.statusCategory])}>
            {ticket.status}
          </span>
        ) : (
          <TicketTransitionMenu
            issueKey={ticket.key}
            status={ticket.status}
            statusCategory={ticket.statusCategory}
          />
        )}
      </div>

      <h3 className="text-[12.5px] leading-[1.4] text-ink">{ticket.title}</h3>

      {/*
        The sessions working this ticket, then the way to start another —
        `new session` is the last child either way, so it sits directly under
        the title when nothing is running and under the final session when
        something is — the same shape `features/projects`' `ProjectRow` uses
        for its own start link.

        Only the *live* ones are listed. `useTicketSessions` filters ended
        sessions; the PR block below deliberately does not, because a merged PR
        outlives the session that opened it.
      */}
      <div className="flex flex-col">
        {sessions.map((id) => (
          <TicketSessionRow key={id} id={id} />
        ))}
        <TicketNewSessionLink ticketKey={ticket.key} />
      </div>

      {prs.length > 0 ? (
        <div className="flex flex-col border-t border-border-soft pt-1">
          {prs.map((pr) => (
            <TicketPrRow key={pr.n} pr={pr} />
          ))}
        </div>
      ) : null}

      {/* Real issues only — a fixture has no conversation to read (HIVE-71). */}
      {ticket.url === undefined ? null : (
        <TicketConversation issueKey={ticket.key} />
      )}
    </article>
  );
}

import { ArrowSquareOut, CaretDown, Check, Kanban, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { createPoller } from '@/hooks/create-poller';
import type { ArcCounts, LinkedTicket } from '@/lib/ticket-links';
import { parseTitleTags } from '@/lib/ticket-tags';
import { cn } from '@/lib/utils';

import { AdfBlocks } from '@features/work/components/adf-blocks';
import { TicketConstellation } from '@features/work/components/ticket-constellation';
import { TicketNextAction } from '@features/work/components/ticket-next-action';
import { LinesSkeleton, TicketProblem } from '@features/work/components/ticket-page-parts';
import { CATEGORY_TEXT, commentTime, STATUS_PILL } from '@features/work/ticket-presentation';
import {
  useEpicLabel,
  useLatestComment,
  useLoadTicketDetail,
  useOpenTicket,
  useRefreshTicketDetail,
  useSessionPr,
  useTicketCriteria,
  useTicketDetail,
  useTicketLinks,
  useTicketSource,
} from '@stores/hive-store';
import { useOpenWorkTicket } from '@stores/ui-store';

/** The tab re-reads once a minute while it is the visible tab (HIVE-202, D4). */
const useTabPoller = createPoller({ intervalMs: 60_000 });

/** One action per line, as the Work page's Actions list draws them, so a long status never squeezes a neighbour. */
const ACTION = 'flex items-center gap-2 py-1 text-left text-control text-brand hover:underline disabled:opacity-60';

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="flex items-baseline gap-1.5 text-micro font-semibold tracking-[0.06em] text-subtle uppercase">
        {title}
        {count === undefined ? null : <span className="tabular-nums text-muted">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function Criteria({ ticketKey }: { ticketKey: string }) {
  const criteria = useTicketCriteria(ticketKey);
  if (criteria === null) return null;
  if (criteria.kind === 'description') {
    return (
      <Section title="Description">
        <div className="flex flex-col gap-2 text-control">
          <AdfBlocks blocks={criteria.blocks} />
        </div>
      </Section>
    );
  }
  return (
    <Section title="Acceptance criteria" count={criteria.items.length}>
      <ul className="flex list-disc flex-col gap-1 pl-4 text-control text-ink">
        {criteria.items.map((runs, i) => (
          <li key={i}>{runs.map((one) => one.text).join('')}</li>
        ))}
      </ul>
    </Section>
  );
}

function LatestComment({ ticketKey }: { ticketKey: string }) {
  const comment = useLatestComment(ticketKey);
  if (comment === undefined) return null;
  return (
    <Section title="Latest comment">
      <p className="text-ui-sm font-semibold text-ink">{`${comment.author} · ${commentTime(comment.created)}`}</p>
      <div className="flex flex-col gap-1.5 text-control text-muted">
        <AdfBlocks blocks={comment.body} />
      </div>
    </Section>
  );
}

type Arc = 'waitsOn' | 'blocks' | 'relates';
const ARC_LABEL: Record<Arc, string> = { waitsOn: 'Waits on', blocks: 'Blocks', relates: 'Relates to' };
const GLYPH: [keyof ArcCounts, string][] = [
  ['done', '✓'],
  ['in-progress', '●'],
  ['todo', '◌'],
];

/** The links: the verdict, the constellation and a row per non-empty arc that opens its list. */
function TicketLinks({ ticketKey, sessionId }: { ticketKey: string; sessionId: string }) {
  const model = useTicketLinks(ticketKey);
  const epic = useEpicLabel(ticketKey);
  const pr = useSessionPr(sessionId);
  const linksProblem = useTicketDetail(ticketKey)?.problems.links;
  const load = useLoadTicketDetail();
  const openOnWork = useOpenWorkTicket();
  const [openArc, setOpenArc] = useState<Arc | null>(null);
  const toggle = (arc: Arc) => setOpenArc((now) => (now === arc ? null : arc));

  if (model === undefined) {
    return linksProblem === undefined ? null : (
      <Section title="Links">
        <TicketProblem message={linksProblem} onRetry={() => void load(ticketKey, 'tab')} />
      </Section>
    );
  }

  return (
    <Section title="Links" count={model.total}>
      {model.total === 0 ? (
        <p className="text-control text-muted">No linked tickets</p>
      ) : (
        <>
          <p
            className={cn(
              'flex items-start gap-2 rounded-md px-2 py-1.5 text-control',
              model.verdict.tone === 'amber' ? 'bg-amber-soft text-amber-text' : 'bg-green-soft text-green',
            )}
          >
            {/* Decoration: the lead beside it says the same thing in words (HIVE-229). */}
            {model.verdict.tone === 'amber' ? (
              <X size={14} weight="bold" aria-hidden="true" data-icon="x" className="mt-[3px] shrink-0" />
            ) : (
              <Check size={14} weight="bold" aria-hidden="true" data-icon="check" className="mt-[3px] shrink-0" />
            )}
            <span>
              <b>{model.verdict.lead}</b>
              <span className="text-muted">{model.verdict.rest}</span>
            </span>
          </p>
          <TicketConstellation
            me={ticketKey}
            arcs={model}
            epicLabel={epic}
            pr={pr?.n ?? null}
            onOpenTicket={openOnWork}
            onOpenArc={(arc) => setOpenArc(arc)}
          />
          {(['waitsOn', 'blocks', 'relates'] as const).map((arc) => {
            const tickets: LinkedTicket[] = model[arc];
            if (tickets.length === 0) return null;
            return (
              <div key={arc} className="flex flex-col">
                <button
                  type="button"
                  aria-expanded={openArc === arc}
                  onClick={() => toggle(arc)}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 text-control text-muted hover:bg-hover"
                >
                  <span>{ARC_LABEL[arc]}</span>
                  <b className="tabular-nums text-ink">{tickets.length}</b>
                  <span className="flex-1" />
                  {GLYPH.filter(([category]) => model.counts[arc][category] > 0).map(([category, glyph]) => (
                    <span key={category} className="tabular-nums text-micro">
                      {`${glyph}${String(model.counts[arc][category])}`}
                    </span>
                  ))}
                  <CaretDown size={12} aria-hidden className={cn(openArc === arc && 'rotate-180')} />
                </button>
                {openArc === arc ? (
                  <ul className="flex flex-col">
                    {tickets.map((ticket) => (
                      <li key={ticket.key}>
                        <button
                          type="button"
                          onClick={() => openOnWork(ticket.key)}
                          className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-control hover:bg-hover"
                        >
                          <span className="tabular-nums text-brand">{ticket.key}</span>
                          <span className="min-w-0 flex-1 text-ink">{ticket.summary}</span>
                          <span className={cn('shrink-0', CATEGORY_TEXT[ticket.statusCategory])}>{ticket.status}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </>
      )}
    </Section>
  );
}

/**
 * The session panel's Ticket tab (HIVE-202): what was asked for, beside what
 * the session says it did. Reads the ticket with its links on mount and once a
 * minute while mounted; the panel mounts only the visible tab.
 */
export function TicketTab({ ticketKey, sessionId }: { ticketKey: string; sessionId: string }) {
  const ticket = useOpenTicket(ticketKey);
  const entry = useTicketDetail(ticketKey);
  const source = useTicketSource();
  const load = useLoadTicketDetail();
  const refresh = useRefreshTicketDetail();
  const openOnWork = useOpenWorkTicket();

  /*
    As on the ticket page: the load does the first read of a key, the poller
    only the later ones. Its sweep on mount runs before the load's effect and is
    skipped, so a key the map already holds is read once on open, not twice.
  */
  const loaded = useRef<string | null>(null);
  useTabPoller(
    useCallback(
      () => (loaded.current === ticketKey ? refresh(ticketKey, 'tab') : Promise.resolve()),
      [ticketKey, refresh],
    ),
  );
  useEffect(() => {
    loaded.current = ticketKey;
    void load(ticketKey, 'tab');
  }, [ticketKey, load]);

  const retry = () => void load(ticketKey, 'tab');
  const problem = entry?.problems.detail ?? entry?.problems.comments;
  const nothing = ticket === undefined && entry?.detail === undefined;

  if (nothing && source.kind === 'unconfigured') {
    return <p className="px-1 py-3 text-control text-muted">Jira is not connected.</p>;
  }
  if (nothing && problem === undefined) return <LinesSkeleton label="Loading ticket" />;

  return (
    <div className="flex flex-col gap-4 px-1 pt-1 pb-3">
      <header className="flex flex-col gap-1">
        <p className="flex flex-wrap items-center gap-1.5 text-ui-sm text-muted">
          <span className="tabular-nums font-bold text-brand">{ticketKey}</span>
          {ticket?.issueType ? <span>{`· ${ticket.issueType} ·`}</span> : <span>·</span>}
          {ticket ? (
            <span className={cn(STATUS_PILL, CATEGORY_TEXT[ticket.statusCategory])}>{ticket.status}</span>
          ) : null}
        </p>
        {ticket ? (
          <h2 className="text-ui-lg leading-snug font-semibold text-ink">{parseTitleTags(ticket.title).title}</h2>
        ) : null}
      </header>
      {problem === undefined ? null : <TicketProblem message={problem} onRetry={retry} readAt={entry?.readAt} />}
      <Criteria ticketKey={ticketKey} />
      <LatestComment ticketKey={ticketKey} />
      <TicketLinks ticketKey={ticketKey} sessionId={sessionId} />
      <Section title="Actions">
        <div className="flex flex-col items-start">
          <TicketNextAction ticketKey={ticketKey} className={ACTION} />
          <button type="button" className={ACTION} onClick={() => openOnWork(ticketKey)}>
            <Kanban size={13} aria-hidden />
            Open the ticket
          </button>
          {ticket?.url ? (
            <a className={ACTION} href={ticket.url} target="_blank" rel="noreferrer">
              <ArrowSquareOut size={13} aria-hidden />
              Open in Jira
            </a>
          ) : null}
        </div>
      </Section>
    </div>
  );
}

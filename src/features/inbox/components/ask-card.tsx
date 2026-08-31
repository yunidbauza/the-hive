import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import type { HiveNotification } from '@/types/notification';

import { Button } from '@components/ui/button';
import { useRelativeTime } from '@hooks/use-relative-time';
import { useAnswerAsk, useDisplayName, useThread } from '@stores/hive-store';

interface AskCardProps {
  notif: HiveNotification;
  /** Narrowed by the dispatcher, so this component never re-checks the union. */
  thread: string;
}

/** An option that closes the ask badly, and should not look like the safe one. */
const NEGATIVE = /^(reject|deny|no)$/i;
/** An option that opens the draft rather than answering with its own id. */
const EDIT = /^edit/i;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * An ask, answerable in place (HIVE-118).
 *
 * ## It reads the ledger, it does not read itself
 *
 * The notification carries a thread and nothing else, and every state this
 * card can be in is derived from that thread: no answer means open, an answer
 * means collapsed, and a `done` means main has already dismissed the row. So
 * an answer posted from the agent view, typed into a session, or written by
 * another party collapses this card exactly like a click on its own button —
 * there is no second copy of "answered" to go stale.
 *
 * ## An article, not a button
 *
 * Every other row in the inbox is a `<button>` that dismisses itself on click
 * (`notification-card.tsx`). This one cannot be: its controls would be
 * interactive content nested inside a button, and its whole purpose is to
 * survive the click that answers it.
 *
 * ## When the entry is gone
 *
 * The renderer's ledger is capped, so a card can outlive its entry. It then
 * falls back to the text main wrote at raise time and draws no buttons —
 * showing options that post into a thread this process cannot see would be a
 * control that lies.
 */
export function AskCard({ notif, thread }: AskCardProps) {
  const entries = useThread(thread);
  const answerAsk = useAnswerAsk();

  const ask = entries.find((entry) => entry.id === thread);
  const answer = entries.find((entry) => entry.kind === 'answer');

  const asker = useDisplayName(ask?.from ?? '');
  const age = useRelativeTime(ask?.ts ?? notif.createdAt);

  const [draft, setDraft] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  const options = strings(ask?.meta?.options);
  const quote = text(ask?.meta?.quote);

  const send = async (body: string, meta?: Record<string, unknown>) => {
    setSending(true);
    try {
      /*
        `meta` is left out of the call entirely rather than passed as an
        explicit `undefined` third argument — the two are different calls as
        far as a spy can tell, and every plain-option answer would otherwise
        record a trailing `undefined` no caller asked for.
      */
      if (meta === undefined) {
        await answerAsk(thread, body);
      } else {
        await answerAsk(thread, body, meta);
      }
    } finally {
      setSending(false);
    }
  };

  const shell = (tone: string, children: ReactNode) => (
    <article
      data-notification={notif.id}
      aria-label={`Ask from ${asker}: ${notif.title}`}
      className={cn(
        'mb-[var(--cc-list-gap-sm)] flex flex-col gap-1 rounded-r-xl rounded-l border border-l-2 px-3 py-[var(--cc-card-py)] text-left last:mb-0',
        'border-border',
        tone,
      )}
    >
      {children}
    </article>
  );

  const meta = (trailing?: ReactNode) => (
    <div className="flex items-center gap-1.5 text-[10px] text-subtle">
      <span className="font-medium text-muted">{asker}</span>
      <span className="opacity-50">·</span>
      <span>{age}</span>
      {trailing}
    </div>
  );

  // The entry has aged out of the capped ledger. Say what main said, and stop.
  if (ask === undefined) {
    return shell(
      'border-l-border',
      <>
        {meta()}
        <span className="text-[12.5px] font-semibold text-ink">{notif.title}</span>
        {notif.body === '' ? null : (
          <span className="text-[11.5px] leading-[1.4] text-muted">{notif.body}</span>
        )}
      </>,
    );
  }

  if (answer !== undefined) {
    return shell(
      'border-l-border',
      <div data-answered={answer.body} className="text-[11px] text-subtle">
        <span className="font-medium text-muted">{asker}</span>
        {' · answered '}
        <span className="text-green">{answer.body}</span>
        {' · '}
        {age}
      </div>,
    );
  }

  const [title, ...rest] = ask.body.split('\n');
  const detail = rest.join('\n').trim();

  return shell(
    'border-l-amber',
    <>
      {meta(
        <>
          <span className="opacity-50">·</span>
          <span>ask {ask.id.slice(-4)}</span>
        </>,
      )}
      <span className="text-[12.5px] font-semibold text-ink">
        {quote === undefined ? title : 'Send this reply?'}
      </span>
      {detail === '' || quote !== undefined ? null : (
        <span className="text-[11.5px] leading-[1.4] text-muted">{detail}</span>
      )}

      {draft === null ? (
        quote === undefined ? null : (
          <p className="mt-1 rounded-r-md border-l-2 border-border bg-panel-2 px-2 py-1.5 text-[11px] leading-[1.45] text-muted">
            {quote}
          </p>
        )
      ) : (
        <textarea
          aria-label="Edit the draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          className="mt-1 w-full resize-y rounded-md border border-brand-fill bg-term-input px-2 py-1.5 text-[11px] leading-[1.45] text-ink"
        />
      )}

      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {draft !== null ? (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={sending}
              onClick={() => void send('approve', { edited: draft })}
            >
              Send
            </Button>
            <Button size="sm" disabled={sending} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </>
        ) : options.length > 0 ? (
          options.map((option, index) => (
            <Button
              key={option}
              size="sm"
              variant={
                NEGATIVE.test(option)
                  ? 'danger'
                  : index === 0
                    ? 'primary'
                    : 'secondary'
              }
              disabled={sending}
              onClick={() =>
                EDIT.test(option) && quote !== undefined
                  ? setDraft(quote)
                  : void send(option)
              }
            >
              {option}
            </Button>
          ))
        ) : (
          <>
            <input
              aria-label="Your answer"
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-term-input px-2 py-1 text-[11px] text-ink placeholder:text-subtle"
              placeholder="Answer…"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={sending || reply.trim() === ''}
              onClick={() => void send(reply.trim())}
            >
              Send
            </Button>
          </>
        )}
      </div>
    </>,
  );
}

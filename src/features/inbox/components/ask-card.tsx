import { useState, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import type { HiveNotification } from '@/types/notification';

import { Button } from '@components/ui/button';
import { useRelativeTime } from '@hooks/use-relative-time';
import type { Rung, RungId } from '@shared/permission-rules';
import {
  useAnswerAsk,
  useDisplayName,
  useIsAgentId,
  useThread,
} from '@stores/hive-store';

import { PermissionControls } from './permission-controls';

interface AskCardProps {
  notif: HiveNotification;
  /** Narrowed by the dispatcher, so this component never re-checks the union. */
  thread: string;
}

/** An option that closes the ask badly, and should not look like the safe one. */
const NEGATIVE = /^(reject|deny|no)$/i;
/**
 * The one option that opens the draft rather than answering with its own id.
 *
 * Anchored at both ends (whole-branch review, finding 5). `AGENT_PREAMBLE`
 * mandates the literal option `'edit'` — see `electron/main/agents/preamble.ts`
 * — and the button renders that string verbatim, with no "Edit…" copy layer
 * anywhere in this codebase to reuse. A prefix match therefore hijacks any
 * option that merely *starts* with those four letters — `editorial pass` — into
 * opening the draft textarea instead of sending the answer the model actually
 * offered.
 */
const EDIT = /^edit$/i;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const RUNG_IDS: readonly RungId[] = ['allow-once', 'allow-family', 'allow-tool'];

const isRungId = (value: unknown): value is RungId =>
  typeof value === 'string' && (RUNG_IDS as readonly string[]).includes(value);

/**
 * A single entry of `meta.rungs`, validated the way `strings()` validates
 * `meta.options` above — the shape is untrusted (it crossed a process
 * boundary as JSON), and a malformed entry must be dropped rather than
 * crash the rail.
 */
const isRung = (value: unknown): value is Rung => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const shape = value as Record<string, unknown>;
  return (
    isRungId(shape['id']) &&
    typeof shape['label'] === 'string' &&
    typeof shape['caption'] === 'string' &&
    (shape['rule'] === undefined || typeof shape['rule'] === 'string')
  );
};

const rungsOf = (value: unknown): Rung[] =>
  Array.isArray(value) ? value.filter(isRung) : [];

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

  /**
   * The asker's name, without resolving an agent through session lookup
   * (whole-branch review, finding 6).
   *
   * `ask.from` is a **party** id — a session or an agent — but `useDisplayName`
   * is documented as taking a **terminal** id and runs `currentSessionIn`
   * internally. Handing it an agent's name is benign only by accident: an
   * agent's entity id *is* its name, fixed for its life, but
   * `hydrateAgents` documents that name as a legal session id too, so on a
   * live machine an agent can come to share one with some session's
   * `terminalId`. `currentSessionIn` would then walk past the direct
   * `entities[id]` miss into the search loop that exists to follow a
   * `/clear`, and resolve straight past the agent to that session — the same
   * collision `isAgentId` and `useNotificationActivate` already close on the
   * toast path.
   *
   * `useDisplayName` is still called on every render — hooks cannot be
   * conditional — but only ever with the session id, never the agent's; when
   * `from` names an agent, its own name is the display name outright, and
   * `useDisplayName` is called with `''` so it stays a no-op read.
   *
   * `useIsAgentId`, not the bare `isAgentId` this started as: that one reads
   * `getState()`, which the project rule forbids in a render path and which is
   * non-reactive besides — a card rendered before `hydrateAgents` lands would
   * answer `false` for ever, and `false` is precisely "resolve it through
   * session lookup". See the hook's own doc in `hive-store.ts`.
   *
   * `answer?.to` is the fallback asker, and it is not a nicety: the ask entry
   * ages out of the capped ledger *before* its own answer does, so a collapsed
   * card can outlive the entry that named the asker. `Ledger.answer` addresses
   * every answer to `ask.from` — "the recipient of an answer is not a choice,
   * it is whoever is owed the reply" — so the answer still carries it.
   */
  const from = ask?.from ?? answer?.to ?? '';
  const fromIsAgent = useIsAgentId(from);
  const sessionName = useDisplayName(fromIsAgent ? '' : from);
  const asker = fromIsAgent ? from : sessionName;
  const age = useRelativeTime(ask?.ts ?? notif.createdAt);

  const [draft, setDraft] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  /**
   * The refusal's reason, shown inline (whole-branch review, finding 3).
   *
   * `Ledger.answer` refuses as a **value**, not a throw, once a thread is no
   * longer an open ask — `LEDGER_ASK_TTL_MS` is 24 hours, so on an app meant
   * to stay open for days this is routine, not exotic. Cleared at the start
   * of every attempt: a retry that succeeds must not leave the previous
   * failure's words sitting under buttons that just worked.
   */
  const [refusal, setRefusal] = useState<string | null>(null);

  const options = strings(ask?.meta?.options);
  const quote = text(ask?.meta?.quote);
  /**
   * `meta.kind === 'permission'` is the **only** discriminator, everywhere.
   *
   * Three consumers used to key on three different predicates: `notify.ts`
   * on `meta.kind`, `permissions.ts` on `meta.kind` plus a loose rung
   * validator, and this card on "at least one entry parses as a `Rung`" with
   * a stricter one. Both disagreements were reachable, and the worst of them
   * landed here: an ask carrying a well-formed `rungs` array and no
   * `meta.kind` drew the Allow/Deny ladder and suppressed `meta.options`,
   * while main's `isPermissionAnswer` answered `false` — so the click
   * recorded an answer, granted nothing, and appended no event. A button
   * that silently does nothing is exactly what the refusal line below exists
   * to prevent.
   *
   * The import fence stops the three from sharing one validator — `@shared`
   * crosses into the renderer as types only — so they cannot share code, but
   * they can and now do share the predicate.
   */
  const isPermission = ask?.meta?.kind === 'permission';
  const rungs = isPermission ? rungsOf(ask?.meta?.rungs) : [];
  /**
   * The scope preselected on open. `meta.default` names one of `rungs` by
   * id, computed once alongside them (`rungsFor`/`defaultRungFor` in
   * `@shared/permission-rules`) — this reads it back rather than
   * recomputing it, and falls back to the first rung actually offered if
   * `default` is missing, foreign, or names a rung that got filtered out
   * above.
   */
  const initialRung: RungId =
    isRungId(ask?.meta?.default) && rungs.some((rung) => rung.id === ask?.meta?.default)
      ? (ask?.meta?.default as RungId)
      : (rungs[0]?.id ?? 'allow-once');

  /**
   * What an **edited** draft is sent as (whole-branch review, finding 4).
   *
   * The literal `'approve'` this used to send was a word the asker may never
   * have offered. `AGENT_PREAMBLE` mandates `'edit'` and nothing else, so a
   * model is free to name its other options whatever it likes — `options:
   * ['send it', 'edit', 'discard']` is a perfectly legal ask — and `Ledger.answer`
   * validates the *thread*, never the body. The edit would have been recorded
   * as `'approve'`, a string the asker cannot match against its own closed set
   * and would have to guess at.
   *
   * So the answer is the asker's own affirmative: the first option that is
   * neither the edit affordance nor a refusal. `'approve'` survives only as
   * the last resort for an ask that offered a quote and no usable option at
   * all — a shape that can only reach the draft through hand-written `meta`,
   * since the affordance is an option.
   */
  const affirmative =
    options.find((option) => !EDIT.test(option) && !NEGATIVE.test(option)) ??
    'approve';

  const send = async (body: string, meta?: Record<string, unknown>) => {
    setSending(true);
    setRefusal(null);
    try {
      /*
        `meta` is left out of the call entirely rather than passed as an
        explicit `undefined` third argument — the two are different calls as
        far as a spy can tell, and every plain-option answer would otherwise
        record a trailing `undefined` no caller asked for.
      */
      const result =
        meta === undefined ? await answerAsk(thread, body) : await answerAsk(thread, body, meta);
      /*
        `undefined` is the browser target, where there is no bridge and
        therefore nothing that could have been refused — a different fact
        from `{ ok: false }` and must not be rendered as one.
      */
      if (result !== undefined && !result.ok) setRefusal(result.reason);
    } catch (cause) {
      /*
        A rejected bridge call, not a refusal — the IPC channel itself threw
        rather than answering. Caught here rather than left to `void send(...)`
        at the call sites: that discards the promise, which turns a genuine
        rejection into an unhandled one, uncaught anywhere and invisible to
        the user this message exists to inform.
      */
      setRefusal(cause instanceof Error ? cause.message : 'Could not send that.');
    } finally {
      setSending(false);
    }
  };

  const sendDraft = () => {
    if (draft === null || sending) return;
    void send(affirmative, { edited: draft });
  };

  const sendReply = () => {
    const body = reply.trim();
    if (body === '' || sending) return;
    void send(body);
  };

  /**
   * Enter sends, the way it does everywhere else that answers an ask.
   *
   * `agent-view.tsx` binds Enter on the equivalent single-line control, and a
   * one-line "Answer…" box where Enter does nothing does not read as a
   * deliberate choice — it reads as a broken input, so the user types their
   * sentence, presses Enter, and watches it sit there.
   *
   * `allowNewline` is the textarea's exception: a draft is prose and may want
   * more than one line, so Shift+Enter inserts one and plain Enter sends.
   * `preventDefault` only on the branch that sends, or the newline the user
   * asked for would be swallowed along with it.
   */
  const onEnter =
    (submit: () => void, allowNewline = false) =>
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Enter') return;
      if (allowNewline && event.shiftKey) return;
      event.preventDefault();
      submit();
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

  /**
   * Answered, and checked **before** the missing-entry fallback below.
   *
   * The order is the whole fix (whole-branch review, finding 3). An ask is
   * always older than its own answer, and the renderer keeps only the newest
   * 500 entries, so the ask is always the one evicted first — there is a
   * window, on any busy machine, where the thread holds an answer and no ask.
   * Testing `ask === undefined` first sent a correctly-collapsed card back to
   * the open-looking fallback: the original question, no buttons, no answer,
   * reading exactly like an unanswered ask that had lost its controls. That is
   * the "control that lies" the fallback exists to prevent, produced by the
   * fallback itself.
   *
   * Nothing is lost by going first, because the answer alone carries
   * everything this state renders — the body, the time, and (through
   * `answer.to`) the asker.
   */
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
      {detail === '' || quote !== undefined ? null : isPermission ? (
        /*
          The command, as a mono block (spec §3.6). It is the actual risk
          surface — the one thing the user is being asked to decide on — and
          in a plain prose `<span>` a multi-line command collapsed onto one
          line, so `rm -rf /` sitting on line 3 of a heredoc read as part of
          the sentence above it. `whitespace-pre-wrap` keeps the newlines,
          `break-all` keeps a long unbroken path from widening the 316px
          rail, and `overflow-x-auto` is the last resort for a token that
          cannot break at all.
        */
        <pre className="mt-1 max-w-full overflow-x-auto rounded-md border border-border bg-panel-2 px-2 py-1.5 font-mono text-[11px] leading-[1.45] break-all whitespace-pre-wrap text-muted">
          {detail}
        </pre>
      ) : (
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
          onKeyDown={onEnter(sendDraft, true)}
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
              onClick={sendDraft}
            >
              Send
            </Button>
            <Button size="sm" disabled={sending} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </>
        ) : rungs.length > 0 ? (
          <PermissionControls
            rungs={rungs}
            initial={initialRung}
            sending={sending}
            onAnswer={(body) => void send(body)}
          />
        ) : options.length > 0 ? (
          options.map((option, index) => (
            <Button
              // Index-qualified (whole-branch review, finding 4): a model can
              // supply duplicate options, and `option` alone would then give
              // React two elements with the same key.
              key={`${index}-${option}`}
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
              onKeyDown={onEnter(sendReply)}
              className="min-w-0 flex-1 rounded-md border border-border bg-term-input px-2 py-1 text-[11px] text-ink placeholder:text-subtle"
              placeholder="Answer…"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={sending || reply.trim() === ''}
              onClick={sendReply}
            >
              Send
            </Button>
          </>
        )}
      </div>

      {refusal === null ? null : (
        /*
          The buttons above stay enabled — `sending` has already returned to
          `false` by the time this renders, so the failed attempt is not
          mistaken for one still in flight. This is what a refusal actually
          looks like: not a frozen card, not a silent no-op, but the reason
          and another chance.
        */
        <p role="alert" className="text-[11px] text-red">
          {refusal}
        </p>
      )}
    </>,
  );
}

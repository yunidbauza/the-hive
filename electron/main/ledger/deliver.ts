import { OVERMIND, type LedgerEntry, type LedgerKind } from '../../shared/ledger-contract';

import type { Ledger } from './index';

/**
 * Delivery: what happens to a ledger entry after it is written (HIVE-113).
 *
 * The ledger itself has no opinion about who should be told what — it records.
 * This module is the first rule on top of it: an `ask` or an `answer` addressed
 * to a live session is written into that session's terminal as one line, at a
 * moment when the terminal is actually at an empty prompt.
 *
 * Collaborators arrive as narrow functions rather than whole modules, the way
 * `createLedger` takes `knowsParty`: the tests fake them as three closures and
 * load no Electron, no pty and no session layer.
 */

/** How much of a body a nudge carries. One line, and not a long one. */
const NUDGE_BODY_MAX = 120;

/**
 * Strip every control character from a body before it reaches a pty.
 *
 * **This is the security boundary of this module, not a formatting nicety.** A
 * body arrives from any party over `POST /ledger` or an MCP tool, validated
 * only as a string under a size cap — and this is the one path that writes such
 * a string into *another* session's prompt, terminated by `\r`. Left raw, a
 * body containing its own `\r` submits a second prompt with no `📒` on it,
 * indistinguishable from something the user typed; an `ESC` reaches the TUI's
 * stdin and can address the cursor or switch screens.
 *
 * The rule is the one `assertText` enforces at the IPC boundary
 * (`electron/shared/guards.ts`) and `stripControls` at the renderer's
 * (`src/lib/terminal/text.ts`): C0, DEL and C1 have no business in text that is
 * about to be typed. Restated here rather than imported because neither module
 * exports it, and `electron/main/**` may not import `src/**` regardless.
 *
 * Line breaks go with them — a nudge is one line by construction, so there is
 * nothing to preserve.
 */
function stripControls(text: string): string {
  return [...text]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return !(code < 0x20 || (code >= 0x7f && code <= 0x9f));
    })
    .join('');
}

/**
 * The only kinds that reach a terminal.
 *
 * **This is a loop guard, not a filter.** This module subscribes to
 * `ledger.onChange` *and* appends a receipt to the same log for every nudge it
 * writes. Without a hard gate on the kind, each receipt would re-enter
 * {@link Deliver.onEntry} and the module would feed itself.
 */
const DELIVERABLE: readonly LedgerKind[] = ['ask', 'answer'];

export interface DeliverOptions {
  ledger: Pick<Ledger, 'read' | 'append'>;
  isLive: (entityId: string) => boolean;
  isIdle: (entityId: string) => boolean;
  /**
   * Write into a session's pty.
   *
   * Returns whether the line actually reached one. The caller in
   * `ipc/index.ts` reaches the session layer through a nullable binding — it is
   * constructed after the ledger — and a receipt written for a nudge that never
   * landed would suppress the retry forever.
   */
  write: (entityId: string, data: string) => boolean;
}

export interface Deliver {
  /** One entry landed, from any party. */
  onEntry(entry: LedgerEntry): void;
  /** A session reached an empty prompt with nothing running behind it. */
  onIdle(entityId: string): void;
  /** A session's agent came up, including after a resume. */
  onReady(entityId: string): void;
}

export function createDeliver({ ledger, isLive, isIdle, write }: DeliverOptions): Deliver {
  /**
   * The short handle a person would use for this entry's conversation.
   *
   * An ask carries its own `ref`. An answer names a `thread`, which is always a
   * canonical id — so the ask it closes is looked up to recover the ref the
   * console printed. Falling back to the id is correct rather than merely safe:
   * an id always identifies the thread, it is just longer than a person wants.
   */
  function handleFor(entry: LedgerEntry): string {
    if (entry.kind === 'ask') return entry.ref ?? entry.id;

    const threadId = entry.thread;
    if (threadId === undefined) return entry.id;

    const ask = ledger.read({ thread: threadId }).entries.find((e) => e.kind === 'ask');
    return ask?.ref ?? threadId;
  }

  function nudgeLine(entry: LedgerEntry, handle: string): string {
    /*
      Cut at the first line break, *then* strip — in that order.

      Stripping first would delete the break and splice the next line onto the
      end of this one, turning two sentences into one run-on. Every break form
      counts, `\r` included: it is not a newline to `split('\n')` but it is very
      much a line break to a terminal, and it is the byte that would otherwise
      submit a prompt of its own.

      `from` is sanitised too. It is a party id rather than prose, but it
      reaches here from a header this module does not own.
    */
    const firstLine = entry.body.split(/\r\n|\r|\n/u)[0] ?? '';
    const body = stripControls(firstLine).slice(0, NUDGE_BODY_MAX);
    const from = stripControls(entry.from);

    return entry.kind === 'ask'
      ? `📒 ${from} asks (${handle}): ${body} — reply with ledger_answer ${handle}`
      : `📒 ${from} answered ${handle}: ${body}`;
  }

  /**
   * What this session has been asked but not told.
   *
   * A query rather than a queue, which is the whole reason delivery is recorded
   * in the log: an in-memory list dies with the process, and a nudge pending at
   * quit would never be written. Three things follow — a restart cannot lose
   * one, a duplicate `session:ready` (which `/clear` produces on purpose) costs
   * a read rather than a second line in the terminal, and "who was told what,
   * and when" is answerable from the log itself.
   */
  function undelivered(entityId: string): LedgerEntry[] {
    const { entries } = ledger.read({ to: entityId });

    const delivered = new Set<string>();
    for (const entry of entries) {
      const id = entry.meta?.delivered;
      if (typeof id === 'string') delivered.add(id);
    }

    return entries.filter(
      (entry) =>
        DELIVERABLE.includes(entry.kind) &&
        /*
          `read({ to })` matches entries addressed to this party *or* broadcast.
          Only the addressed half is deliverable, so the recipient is re-checked
          exactly rather than trusted from the query.
        */
        entry.to === entityId &&
        !delivered.has(entry.id),
    );
  }

  /** Write one nudge, and record it only if it landed. Reports whether it did. */
  function deliverOne(entityId: string, entry: LedgerEntry): boolean {
    const handle = handleFor(entry);
    if (!write(entityId, `${nudgeLine(entry, handle)}\r`)) return false;

    /*
      `from: OVERMIND` is asserted rather than derived. The party set is
      `overmind | session | agent` and there is no identity for "the app
      itself" — main is the coordinator's body, so the coordinator is who this
      is from. Addressed `to` the session so `visibleTo` lets that session read
      its own receipts, and so a broadcast is never created by accident.
    */
    const recorded = ledger.append({
      from: OVERMIND,
      to: entityId,
      kind: 'event',
      body: `nudge written (${handle})`,
      meta: { delivered: entry.id },
    });

    /*
      A refused receipt is reported, not swallowed. `Ledger.append` returns a
      refusal as a value (ENOSPC, a `~/.hive` moved out from under the app), and
      without a receipt this exact nudge is rewritten on every subsequent idle —
      forever, into a real terminal. Saying so once is what makes that
      diagnosable; the alternative is a session that mysteriously repeats a
      question it already asked.
    */
    if (!recorded.ok) {
      console.warn(
        `[ledger] nudge ${handle} was written to ${entityId} but its receipt was refused ` +
          `(${recorded.status}: ${recorded.reason}) — it may be delivered again`,
      );
    }

    return true;
  }

  /**
   * Write everything this session is owed, one nudge per idle window.
   *
   * **`isIdle` is re-checked on every iteration, and the loop stops at the
   * first delivery.** Each nudge ends in `\r`, which submits it — so the
   * instant one lands the session is mid-turn, and writing the rest of the
   * backlog behind it would break the single invariant this module exists to
   * hold. The remainder is not lost: it has no receipt, so the next idle
   * transition picks up exactly where this one stopped.
   */
  function flush(entityId: string): void {
    if (!isLive(entityId) || !isIdle(entityId)) return;

    for (const entry of undelivered(entityId)) {
      if (deliverOne(entityId, entry)) return;
    }
  }

  return {
    onEntry(entry) {
      if (!DELIVERABLE.includes(entry.kind)) return;

      const to = entry.to;
      // A broadcast wakes nobody — parties read those on their own schedule.
      if (to === undefined) return;
      // The overmind's copy is an inbox card (HIVE-118), not a terminal line.
      if (to === OVERMIND) return;
      // An agent is woken by the scheduler (HIVE-120), not written to — it has
      // no terminal to nudge. An unknown party has nowhere to write to either.
      // A live session mid-turn is caught here too, and flushed by `onIdle`.
      if (!isLive(to) || !isIdle(to)) return;

      deliverOne(to, entry);
    },

    onIdle(entityId) {
      flush(entityId);
    },

    onReady(entityId) {
      flush(entityId);
    },
  };
}

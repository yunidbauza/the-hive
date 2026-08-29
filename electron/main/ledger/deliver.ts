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
    const body = (entry.body.split('\n')[0] ?? '').slice(0, NUDGE_BODY_MAX);

    return entry.kind === 'ask'
      ? `📒 ${entry.from} asks (${handle}): ${body} — reply with ledger_answer ${handle}`
      : `📒 ${entry.from} answered ${handle}: ${body}`;
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

  /** Write one nudge, and record it only if it landed. */
  function deliverOne(entityId: string, entry: LedgerEntry): void {
    const handle = handleFor(entry);
    if (!write(entityId, `${nudgeLine(entry, handle)}\r`)) return;

    /*
      `from: OVERMIND` is asserted rather than derived. The party set is
      `overmind | session | agent` and there is no identity for "the app
      itself" — main is the coordinator's body, so the coordinator is who this
      is from. Addressed `to` the session so `visibleTo` lets that session read
      its own receipts, and so a broadcast is never created by accident.
    */
    ledger.append({
      from: OVERMIND,
      to: entityId,
      kind: 'event',
      body: `nudge written (${handle})`,
      meta: { delivered: entry.id },
    });
  }

  function flush(entityId: string): void {
    if (!isLive(entityId) || !isIdle(entityId)) return;
    for (const entry of undelivered(entityId)) deliverOne(entityId, entry);
  }

  return {
    onEntry(entry) {
      if (!DELIVERABLE.includes(entry.kind)) return;

      const to = entry.to;
      // A broadcast wakes nobody — parties read those on their own schedule.
      if (to === undefined) return;
      // The overmind's copy is an inbox card (HIVE-118), not a terminal line.
      if (to === OVERMIND) return;
      // An agent is HIVE-120; an unknown party has nowhere to write to. A live
      // session mid-turn is caught here too, and flushed by `onIdle`.
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

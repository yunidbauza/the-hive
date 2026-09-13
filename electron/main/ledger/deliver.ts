import type { PromptInput } from '../../shared/ipc-contract';
import {
  ledgerMarker,
  OVERMIND,
  type LedgerEntry,
  type LedgerKind,
} from '../../shared/ledger-contract';
import type { SurfaceId } from '../ipc/surfaces';

import type { Ledger } from './index';

/**
 * Delivery: what happens to a ledger entry after it is written (HIVE-113).
 *
 * The ledger itself has no opinion about who should be told what — it records.
 * This module is the first rule on top of it: an `ask`, an `answer` or a `post`
 * addressed to a live session is announced in that session's terminal as one marker
 * line, at a moment when the terminal is actually at an empty prompt.
 *
 * The line is a marker, not the entry (HIVE-138). `ledgerMarker` names the
 * entry and carries nothing else; the receiver recognises the marker on the
 * `UserPromptSubmit` it produces and answers with the entry whole as hook
 * context (`electron/main/hooks/receiver.ts`, `context.ts`), untruncated and
 * labelled as context rather than passing as the user's own words. What this
 * module decides is only *when* the marker is written and *that* it landed.
 *
 * No party-authored byte reaches the pty from here any more. Before HIVE-138
 * this was the one path that typed another party's body into a prompt
 * terminated by `\r`, and stripping control characters from it was this
 * module's security boundary. The marker is built from a ref or an id main
 * minted, and the body travels as JSON the model reads, not bytes a terminal
 * interprets, so the boundary moved out of the pty path with the body.
 *
 * Collaborators arrive as narrow functions rather than whole modules, the way
 * `createLedger` takes `knowsParty`: the tests fake them as three closures and
 * load no Electron, no pty and no session layer.
 */

/**
 * The only kinds that reach a terminal.
 *
 * **This is a loop guard, not a filter.** This module subscribes to
 * `ledger.onChange` *and* appends a receipt to the same log for every nudge it
 * writes. Without a hard gate on the kind, each receipt would re-enter
 * {@link Deliver.onEntry} and the module would feed itself.
 *
 * A `post` addressed to a session is a one-way notice (the shipper's "PR
 * merged"): it reaches the terminal as an answer does, and owes nothing back.
 * Broadcast posts stay silent, because `onEntry` returns on a missing `to` and
 * `undelivered` re-checks `entry.to === entityId`. Receipts are `event`, so
 * adding `post` leaves the guard whole.
 */
const DELIVERABLE: readonly LedgerKind[] = ['ask', 'answer', 'post'];

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
  /**
   * A terminal surface reported what its input box holds (HIVE-135). `empty`
   * and `draft` make that session the focused one **for that surface**;
   * `unfocused` releases it, if that surface still holds it.
   */
  onPrompt(surfaceId: SurfaceId, entityId: string, input: PromptInput): void;
  /**
   * One surface went away — a renderer reloaded or died, or a socket dropped.
   * Its record goes with it, and every other surface's stays (HIVE-145).
   */
  onSurfaceGone(surfaceId: SurfaceId): void;
}

export function createDeliver({ ledger, isLive, isIdle, write }: DeliverOptions): Deliver {
  /**
   * What each surface's input box holds, and for which session (HIVE-135).
   *
   * A map keyed by surface, not one record (HIVE-145). It *was* one record,
   * justified by "the stage shows one terminal at a time and a user can only
   * type into the terminal they can see" — a fact about a single renderer.
   * Server mode makes every attached socket a surface and all of them report
   * down the same `pty:prompt` notify, so the single record held whatever the
   * last surface to speak said, about whichever session that one was watching.
   *
   * Two silent failures came out of that, and both are what this map closes:
   * device B reporting on its own session released a hold device A had asked
   * for, and a socket dropping wiped a hold a still-live surface was relying
   * on — landing the nudge in a half-typed box, which is exactly the
   * regression HIVE-135 exists to prevent.
   *
   * Everything not focused *anywhere* delivers on idleness alone, as it did
   * before this existed. Empty means no surface has reported, which is the
   * conservative default in disguise: a surface reports in the same effect
   * that reveals it.
   */
  const focus = new Map<SurfaceId, { entityId: string; input: 'empty' | 'draft' }>();

  /**
   * May a line be written into this session's box right now?
   *
   * Refusing is always safe — a held nudge writes no receipt and the next
   * transition retries it. Writing into a draft never is.
   */
  function clear(entityId: string): boolean {
    /*
      **Any** surface holding a draft refuses the write, not "the" surface
      (HIVE-145). Refusing is always safe — a held nudge writes no receipt and
      the next transition retries it — so with two devices on one session the
      right question is whether anyone is mid-sentence, not whether the last
      one to report was.
    */
    for (const held of focus.values()) {
      if (held.entityId === entityId && held.input === 'draft') return false;
    }
    return true;
  }

  /**
   * The short handle a person would use for this entry's conversation.
   *
   * An ask carries its own `ref`. An answer names a `thread`, which is always a
   * canonical id — so the ask it closes is looked up to recover the ref the
   * console printed. Falling back to the id is correct rather than merely safe:
   * an id always identifies the thread, it is just longer than a person wants.
   */
  /** The ask an answer closes, if the log still has it. */
  function askFor(entry: LedgerEntry): LedgerEntry | undefined {
    if (entry.kind === 'ask') return entry;
    const threadId = entry.thread;
    if (threadId === undefined) return undefined;
    return ledger.read({ thread: threadId }).entries.find((e) => e.kind === 'ask');
  }

  function handleFor(entry: LedgerEntry): string {
    if (entry.kind === 'ask') return entry.ref ?? entry.id;
    return askFor(entry)?.ref ?? entry.thread ?? entry.id;
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
    const { entries, openAsks } = ledger.read({ to: entityId });
    // An ask answered while this session was away (HIVE-167 redirects one
    // to the inbox) is settled; a marker for it would invite an answer the
    // ledger refuses as "thread is not open".
    const open = new Set(openAsks.map((ask) => ask.id));

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
        (entry.kind !== 'ask' || open.has(entry.id)) &&
        !delivered.has(entry.id),
    );
  }

  /** Write one nudge, and record it only if it landed. Reports whether it did. */
  function deliverOne(entityId: string, entry: LedgerEntry): boolean {
    const handle = handleFor(entry);
    if (!write(entityId, `${ledgerMarker(entry)}\r`)) return false;

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
   * **The preconditions are checked once, before the loop, and the loop stops
   * at the first delivery.** Each nudge ends in `\r`, which submits it — so
   * the instant one lands the session is mid-turn, and writing the rest of
   * the backlog behind it would break the single invariant this module
   * exists to hold. The remainder is not lost: it has no receipt, so the
   * next idle transition picks up exactly where this one stopped.
   */
  function flush(entityId: string): void {
    if (!isLive(entityId) || !isIdle(entityId) || !clear(entityId)) return;

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
      // A focused session whose box holds a draft is held here too, and
      // flushed by onPrompt when the box clears (HIVE-135).
      if (!isLive(to) || !isIdle(to) || !clear(to)) return;

      deliverOne(to, entry);
    },

    onIdle(entityId) {
      flush(entityId);
    },

    onReady(entityId) {
      flush(entityId);
    },

    onPrompt(surfaceId, entityId, input) {
      const before = focus.get(surfaceId);

      if (input === 'unfocused') {
        // Only the holder releases its own record: a late report naming a
        // session this surface has already left must not clear the entry it
        // has since made, nor any other surface's.
        if (before?.entityId === entityId) focus.delete(surfaceId);
        return;
      }

      focus.set(surfaceId, { entityId, input });

      /*
        The third flush trigger, beside idle and ready. Not on a report that
        changes nothing: after a nudge is submitted the next screen read says
        `empty` again while main's idle answer can lag the busy-state hook,
        and re-running the flush then would find the backlog behind the turn
        the last nudge started. Every other arrival at `empty` — first report,
        after a reset, after a draft, after a focus round-trip — is a
        transition, and the held nudge is what the user is waiting on.
      */
      const unchanged = before?.entityId === entityId && before.input === 'empty';
      if (input === 'empty' && !unchanged) flush(entityId);
    },

    onSurfaceGone(surfaceId) {
      /*
        One entry, not the whole map. No flush follows, for the same reason an
        `unfocused` report does not flush: a surface going away is not a
        transition to an empty box, and the next idle, ready or empty report
        from a surface that *is* live takes the backlog.
      */
      focus.delete(surfaceId);
    },
  };
}

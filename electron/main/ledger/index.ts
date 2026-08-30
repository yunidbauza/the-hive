import {
  LEDGER_BODY_MAX,
  LEDGER_KINDS,
  OVERMIND,
  type LedgerAnswerRequest,
  type LedgerEntry,
  type LedgerPostRequest,
  type LedgerReadQuery,
  type LedgerResult,
  type LedgerSnapshot,
} from '@shared/ledger-contract';
import { claims, keepNewest, matches, openAsks, resolveRef, taskOf } from '@shared/ledger-derive';

import { createLedgerStore } from './store';

/**
 * What may be written, and by whom (HIVE-111).
 *
 * The store will append anything; this is the layer that decides. Both callers
 * — the renderer over IPC and the MCP host over the receiver — land here, so
 * there is exactly one place a rule can be stated and exactly one place it can
 * be broken.
 */

export interface LedgerOptions {
  dir: string;
  /** {@link OVERMIND} plus every session this app has, live or resumable. */
  knowsParty: (id: string) => boolean;
  now?: () => number;
}

export interface Ledger {
  read(query: LedgerReadQuery): LedgerSnapshot;
  append(request: LedgerPostRequest): LedgerResult;
  answer(request: LedgerAnswerRequest, from: string): LedgerResult;
  onChange(listener: (entry: LedgerEntry) => void): () => void;
}

const refuse = (status: number, reason: string): LedgerResult => ({
  ok: false,
  status,
  reason,
});

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function createLedger(options: LedgerOptions): Ledger {
  const now = options.now ?? Date.now;
  const store = createLedgerStore({ dir: options.dir, now });

  const ledger: Ledger = {
    read(query) {
      const all = store.all();
      const filtered = all.filter((entry) => matches(entry, query));

      /*
        Derived from the *whole* log, not from the filtered slice. A query for
        one session's posts must not be able to report that nobody has any open
        asks — the filter is about what to show, not about what is true.
      */
      return {
        entries: keepNewest(filtered, query.limit),
        openAsks: openAsks(all, now()),
        claims: claims(all),
      };
    },

    append(request) {
      if (!options.knowsParty(request.from)) {
        return refuse(404, `unknown party: ${request.from}`);
      }
      if (!(LEDGER_KINDS as readonly string[]).includes(request.kind)) {
        return refuse(400, `unknown kind: ${String(request.kind)}`);
      }
      if (request.body.length > LEDGER_BODY_MAX) {
        return refuse(
          413,
          `body is ${request.body.length} characters; the limit is ${LEDGER_BODY_MAX}`,
        );
      }

      /*
        A `thread` on any kind must name an ask that exists; an `answer` is
        stricter still and its thread must also be *open*.

        Both rules live here rather than only in `answer()`, because `answer()`
        is reachable from the IPC channel alone. Every out-of-process party —
        a session's hooks, and from HIVE-112 the MCP host — arrives through
        `POST /ledger` and therefore through this function, and `openAsks`
        closes an ask on *any* answer naming it: without the check a bogus or
        duplicate answer would silently retire a question the asker is still
        owed a reply to. `answer()` keeps its own copy and delegates here; the
        check is idempotent, so paying for it twice costs nothing.
      */
      let thread = request.thread;
      let to = request.to;
      if (thread !== undefined) {
        const all = store.all();
        const canonical = resolveRef(all, thread);
        if (canonical === undefined) {
          return refuse(400, `no such thread: ${thread}`);
        }
        if (request.kind === 'answer') {
          const ask = openAsks(all, now()).find((open) => open.id === canonical);
          if (ask === undefined) {
            // Also the answer-to-a-non-ask case: `resolveRef` matches any
            // entry id, and only an ask is ever in `openAsks`.
            return refuse(400, `thread is not open: ${thread}`);
          }
          /*
            Only a party to the thread may close it.

            `openAsks` retires an ask on *any* answer naming it, so without
            this a session that merely saw the question could answer it, the
            ask would drop out of the inbox, and the party it was actually
            addressed to would never see it. A broadcast ask (`to` absent) is
            addressed to everyone, so everyone is a recipient of it; the
            overmind is a party to everything by definition, and the asker
            itself can always close its own question.
          */
          if (
            ask.to !== undefined &&
            request.from !== ask.to &&
            request.from !== ask.from &&
            request.from !== OVERMIND
          ) {
            return refuse(
              403,
              `${thread} was asked of ${ask.to}; ${request.from} is not a party to it`,
            );
          }
          /*
            An `answer` with no `to` defaults to the ask's `from`.

            `Ledger.answer()` (the IPC entry point) has always set this
            itself, but the MCP host reaches `append` directly and its tool
            schema exposes no `to` — so a POST-ed answer left `to` undefined,
            and `visibleTo` in the receiver treats an absent `to` as
            "everyone". A private question answered over the MCP path was
            readable by every other session on its next read. Defaulting here
            closes that for every caller, `answer()` included; its own
            `to: ask.from` becomes redundant rather than wrong, so it stays.
          */
          to = to ?? ask.from;
        }
        thread = canonical;
      }

      /*
        A `release` may only be written by the holder (or the overmind, which
        arbitrates). `claims()` deletes on any release naming the task
        regardless of who wrote it, so a release from a third party changes
        derived state exactly as if that party had misbehaved as the holder —
        the one thing the party rule promises can never happen.

        There is deliberately no mirror-image rule for `claim`: the tool
        layer's `ledger_claim` reports the current holder rather than refusing,
        so a second claim is a fact worth recording, not a violation.
      */
      if (request.kind === 'release' && request.from !== OVERMIND) {
        const task = taskOf(request);
        const holder = task === undefined ? undefined : claims(store.all())[task];
        if (holder !== undefined && holder !== request.from) {
          return refuse(403, `${task} is held by ${holder}, not by ${request.from}`);
        }
      }

      let stored: LedgerEntry;
      try {
        stored = store.append({
          ...request,
          ...(thread === undefined ? {} : { thread }),
          ...(to === undefined ? {} : { to }),
        });
      } catch (cause) {
        /*
          The one failure here that is nobody's fault: ENOSPC, EACCES, a
          `~/.hive` the user moved out from under the app. Reported as a value
          like every other refusal, because that is the whole reason
          `LedgerResult` is a value — a throw would reach the HTTP caller as a
          bare 500 with no body and the IPC caller as a rejected promise,
          while both boundaries were built to hand a model a readable reason.
          Nothing was written and nothing was kept in memory, so calling it a
          refusal is also simply true.
        */
        return refuse(500, `could not write the ledger: ${describeCause(cause)}`);
      }
      return { ok: true, id: stored.id, ...(stored.ref === undefined ? {} : { ref: stored.ref }) };
    },

    answer(request, from) {
      /*
        Kept even though `append` now re-checks both rules: this is the IPC
        path's entry point, and refusing here names the *ref* the renderer
        actually typed rather than the canonical id `append` would have
        resolved it to.
      */
      const all = store.all();
      const canonical = resolveRef(all, request.thread);
      if (canonical === undefined) {
        return refuse(400, `no such thread: ${request.thread}`);
      }
      const ask = openAsks(all, now()).find((open) => open.id === canonical);
      if (ask === undefined) {
        return refuse(400, `thread is not open: ${request.thread}`);
      }

      /*
        Addressed to whoever asked, never broadcast.

        `LedgerAnswerRequest` carries no `to` and should not: the recipient of
        an answer is not a choice, it is whoever is owed the reply. Leaving it
        absent made every answer a broadcast, and since `visibleTo` in the
        receiver treats an absent `to` as "everyone", the overmind's reply to
        one session's private question was readable by every other session
        over `POST /ledger/read` — the read boundary this log exists to draw,
        undone by an omission.
      */
      return ledger.append({
        from,
        to: ask.from,
        kind: 'answer',
        thread: canonical,
        body: request.body,
        ...(request.meta === undefined ? {} : { meta: request.meta }),
      });
    },

    onChange: (listener) => store.onChange(listener),
  };

  return ledger;
}

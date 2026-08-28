import {
  LEDGER_BODY_MAX,
  LEDGER_KINDS,
  type LedgerAnswerRequest,
  type LedgerEntry,
  type LedgerPostRequest,
  type LedgerReadQuery,
  type LedgerResult,
  type LedgerSnapshot,
} from '@shared/ledger-contract';
import { claims, matches, openAsks, resolveRef } from '@shared/ledger-derive';

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

export function createLedger(options: LedgerOptions): Ledger {
  const now = options.now ?? Date.now;
  const store = createLedgerStore({ dir: options.dir, now });

  const ledger: Ledger = {
    read(query) {
      const all = store.all();
      const filtered = all.filter((entry) => matches(entry, query));
      const limited =
        query.limit === undefined ? filtered : filtered.slice(-Math.max(0, query.limit));

      /*
        Derived from the *whole* log, not from the filtered slice. A query for
        one session's posts must not be able to report that nobody has any open
        asks — the filter is about what to show, not about what is true.
      */
      return {
        entries: limited,
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
      if (thread !== undefined) {
        const all = store.all();
        const canonical = resolveRef(all, thread);
        if (canonical === undefined) {
          return refuse(400, `no such thread: ${thread}`);
        }
        if (
          request.kind === 'answer' &&
          !openAsks(all, now()).some((ask) => ask.id === canonical)
        ) {
          // Also the answer-to-a-non-ask case: `resolveRef` matches any entry
          // id, and only an ask is ever in `openAsks`.
          return refuse(400, `thread is not open: ${thread}`);
        }
        thread = canonical;
      }

      const stored = store.append(thread === undefined ? request : { ...request, thread });
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
      const open = openAsks(all, now()).some((ask) => ask.id === canonical);
      if (!open) {
        return refuse(400, `thread is not open: ${request.thread}`);
      }

      return ledger.append({
        from,
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

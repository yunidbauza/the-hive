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
        A `thread` on any kind must name an ask that exists. An `answer` is
        stricter still and goes through `answer()` below, which also checks the
        thread is *open* — writing a second answer would leave two closings for
        one question and no way to tell which the asker acted on.
      */
      if (request.thread !== undefined) {
        const canonical = resolveRef(store.all(), request.thread);
        if (canonical === undefined) {
          return refuse(400, `no such thread: ${request.thread}`);
        }
        const stored = store.append({ ...request, thread: canonical });
        return { ok: true, id: stored.id, ...(stored.ref === undefined ? {} : { ref: stored.ref }) };
      }

      const stored = store.append(request);
      return { ok: true, id: stored.id, ...(stored.ref === undefined ? {} : { ref: stored.ref }) };
    },

    answer(request, from) {
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

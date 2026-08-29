import { HOOK_HEADER_SESSION, HOOK_HEADER_TOKEN } from '@shared/hook-contract';
import {
  LEDGER_POST_PATH,
  LEDGER_READ_PATH,
  type LedgerPostRequest,
  type LedgerReadQuery,
  type LedgerSnapshot,
} from '@shared/ledger-contract';
import { RECEIVER_TIMEOUT_MS } from '@shared/mcp-contract';

/**
 * The MCP host's one way to reach the ledger (HIVE-112).
 *
 * Both routes are **POST**, including the read: the receiver has never parsed a
 * query string and every route on it is POST-only, so a `GET /ledger` would be
 * answered with a bare 404.
 *
 * `fetch` is injected rather than reached for. There is no fetch-mocking
 * precedent anywhere in this repo, and a global stub would leak between the
 * suites that run in the same worker — an argument costs one line and is
 * assertable.
 */

/** A refusal from the receiver, carrying the reason it gave. */
export class ReceiverError extends Error {
  readonly status: number;

  constructor(status: number, reason: string) {
    super(reason);
    this.name = 'ReceiverError';
    this.status = status;
  }
}

export interface ReceiverClient {
  read(query: LedgerReadQuery): Promise<LedgerSnapshot>;
  post(request: Omit<LedgerPostRequest, 'from'>): Promise<{ id: string; ref?: string }>;
}

export interface ReceiverClientOptions {
  /** The receiver's base URL, from `HIVE_RECEIVER_URL`. */
  url: string;
  /** This process's party id, from `HIVE_SESSION_ID`. */
  session: string;
  /** This session's own token, from `HIVE_HOOK_TOKEN` (HIVE-112). */
  token: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}

export function createReceiverClient({
  url,
  session,
  token,
  fetch,
  timeoutMs = RECEIVER_TIMEOUT_MS,
}: ReceiverClientOptions): ReceiverClient {
  const base = url.replace(/\/$/, '');

  const call = async <T>(path: string, body: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [HOOK_HEADER_SESSION]: session,
          [HOOK_HEADER_TOKEN]: token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      /*
        A transport failure, not a refusal: the app is not running, the socket
        moved, or the call outran its timeout. Worded for the model, which is
        the only reader — it needs to know this is not its fault and not worth
        retrying in a tight loop.
      */
      throw new ReceiverError(
        0,
        `could not reach the Hive (${String(cause)}). The app may have quit; stop and report this rather than retrying.`,
      );
    }

    if (!response.ok) {
      // The receiver answers every refusal with `{ reason }`. Anything else is
      // a bug on that side, so fall back to something still legible.
      let reason = `the Hive refused the request (${response.status})`;
      try {
        const parsed = (await response.json()) as { reason?: unknown };
        if (typeof parsed.reason === 'string' && parsed.reason !== '') reason = parsed.reason;
      } catch {
        /* keep the status-based fallback */
      }
      throw new ReceiverError(response.status, reason);
    }

    return (await response.json()) as T;
  };

  return {
    read: (query) => call<LedgerSnapshot>(LEDGER_READ_PATH, query),

    post: ({ to, kind, thread, body, meta }) =>
      /*
        Destructured rather than forwarded, so a `from` a caller invented cannot
        ride along. The receiver discards it regardless — identity is the
        `x-hive-session` header — but a body that never carries one cannot be
        misread as an attempt.
      */
      call<{ id: string; ref?: string }>(LEDGER_POST_PATH, {
        ...(to === undefined ? {} : { to }),
        kind,
        ...(thread === undefined ? {} : { thread }),
        body,
        ...(meta === undefined ? {} : { meta }),
      }),
  };
}

import type {
  JiraErrorKind,
  JiraResult,
} from '../../../shared/jira-contract';

/**
 * The Jira HTTP client (HIVE-67) — the first outbound request anywhere in
 * `electron/main`.
 *
 * ## What replaces `gh.ts`'s "argv is a constant"
 *
 * `gh.ts`'s strongest rule is that its IPC verb takes no payload at all, so
 * nothing from the renderer can reach an argument. That cannot hold for an
 * integration whose job is to run the user's query, so it is replaced by four
 * rules that can:
 *
 * 1. **The host comes from the configured site**, passed once at construction
 *    and never taken from a call. So no *call* can redirect a request that is
 *    already going out, and no path or query fragment can smuggle a new
 *    authority past `assertJiraSite`.
 *
 *    Be precise about what that does and does not buy, because the obvious
 *    stronger reading is false: the site is an ordinary setting, the settings
 *    pane writes it through `config:set-jira`, and the renderer therefore *can*
 *    change which host the next call reaches. That is the feature — a user has
 *    to be able to type their own site — and it is not a new capability: the
 *    same bridge already exposes `config.setRuntime` and `pty.write`, so a
 *    renderer able to abuse this one already has a login shell. What rule 1
 *    actually guarantees is that the host is always a value that went through
 *    the guard and through the config write path, never a string that arrived
 *    on the same call as the request.
 * 2. **The path is a literal from this codebase.** Callers pass a constant, and
 *    anything interpolated into one is validated by the guards first.
 * 3. **Bounded**, like every external call in this app: an abort signal and a
 *    response-size cap, because a hung Jira must not hang the settings pane and
 *    an unbounded body must not become unbounded memory.
 * 4. **No raw output escapes.** Every message here is composed from a status
 *    code and a fixed string. The response body is never quoted and the cause of
 *    a rejected `fetch` is never included — an error path is the easiest place
 *    in an integration to leak a credential into a log.
 *
 * HIVE-68 adds `searchJql`, `readIssue`, retries and pagination on top of this
 * same request path. It does not get to relax any of the four.
 */

/** Matching `gh.ts`'s posture of bounding every external call. */
export const JIRA_TIMEOUT_MS = 10_000;

/** 256 KiB. `/myself` is a few hundred bytes; this is already generous. */
export const MAX_RESPONSE_BYTES = 256 * 1024;

/** Injected so no test touches the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JiraCredential {
  email: string;
  token: string;
}

export interface JiraClient {
  get<T>(path: string): Promise<JiraResult<T>>;
}

const error = (
  kind: JiraErrorKind,
  message: string,
  retryAfter?: number,
): JiraResult<never> => ({
  ok: false,
  error: { kind, message, ...(retryAfter === undefined ? {} : { retryAfter }) },
});

/**
 * Status to kind, and the sentence the pane shows.
 *
 * A function rather than a lookup because 4xx and 5xx need different defaults,
 * and because each message says what is *wrong* specifically enough for the
 * reader to know what to do — which a generic "request failed" never does.
 */
function fromStatus(status: number, retryAfter?: number): JiraResult<never> {
  if (status === 401) {
    return error(
      'unauthorized',
      'Jira rejected the credential. The token may be wrong, revoked, or issued for a different account.',
    );
  }
  if (status === 403) {
    return error(
      'forbidden',
      'Jira accepted the credential but refused the request. The account is authenticated but not permitted.',
    );
  }
  if (status === 404) {
    return error(
      'not-found',
      'Jira answered but had nothing at that address. Check the site name.',
    );
  }
  if (status === 429) {
    return error('rate-limited', 'Jira is rate-limiting this app.', retryAfter);
  }
  if (status === 400) {
    return error('bad-query', 'Jira could not understand the request.');
  }
  return error('unknown', `Jira answered with ${status}.`);
}

/**
 * `Retry-After` in seconds.
 *
 * The header also has a date form. It is ignored rather than parsed: an
 * automatic retry timed from a misread date is worse than one the user triggers
 * themselves, and HIVE-68 is what acts on this number.
 */
function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

export function createJiraClient(deps: {
  fetch: FetchLike;
  /** A bare hostname, already validated by `assertJiraSite`. */
  site: string;
  credential: JiraCredential;
}): JiraClient {
  const { fetch, site, credential } = deps;

  // Built once, here and nowhere else — the only place the two halves of the
  // credential are ever joined.
  const authorization = `Basic ${Buffer.from(
    `${credential.email}:${credential.token}`,
    'utf8',
  ).toString('base64')}`;

  return {
    async get<T>(path: string): Promise<JiraResult<T>> {
      let response: Response;
      try {
        response = await fetch(`https://${site}${path}`, {
          method: 'GET',
          headers: { authorization, accept: 'application/json' },
          signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
        });
      } catch (cause) {
        /**
         * The cause is deliberately not included in the message.
         *
         * A rejected `fetch` carries a string this code did not compose, and an
         * integration is the last place that should paste an unknown string into
         * a user-visible surface. The token appears in no URL this client
         * builds, but "probably safe" is not the standard for a credential.
         */
        const aborted =
          cause instanceof Error &&
          (cause.name === 'TimeoutError' || cause.name === 'AbortError');
        return aborted
          ? error('timeout', 'Jira did not answer within ten seconds.')
          : error('offline', 'Could not reach Jira. The network may be down.');
      }

      if (!response.ok) {
        return fromStatus(response.status, retryAfterSeconds(response));
      }

      // Checked before reading, so a server that declares a huge body costs one
      // header rather than 256 KiB of heap.
      const declared = Number.parseInt(
        response.headers.get('content-length') ?? '',
        10,
      );
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        return error('unknown', "Jira's answer was too large to read.");
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        return error('unknown', "Jira's answer was too large to read.");
      }

      try {
        return { ok: true, value: JSON.parse(text) as T };
      } catch {
        // The body is not quoted. A proxy's HTML error page is the common case
        // here, and pasting it into the settings pane helps nobody.
        return error(
          'unknown',
          'Jira answered with something that was not JSON.',
        );
      }
    },
  };
}

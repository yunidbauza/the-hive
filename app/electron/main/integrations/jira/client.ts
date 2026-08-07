import {
  JIRA_MAX_DETAILS,
  JIRA_MAX_DETAIL_LENGTH,
  type JiraErrorKind,
  type JiraResult,
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

/** 256 KiB. A 100-issue page of six narrow fields is well inside this. */
export const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * How long a `Retry-After` this client is willing to actually wait (HIVE-68).
 *
 * Jira can answer 429 with a much larger number. Blocking an IPC call for three
 * minutes is worse than reporting: past this cap the client returns immediately
 * with `retryAfter` set, so the pane can say *when* rather than making the user
 * wait inside a verb with no way to cancel.
 */
export const JIRA_MAX_RETRY_DELAY_MS = 5_000;

/** The backoff before the single 5xx retry. */
export const JIRA_BACKOFF_MS = 500;

/** Injected so no test touches the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Injected so no test waits (HIVE-68).
 *
 * `CLAUDE.md` requires fake timers rather than real waits, and a retry test that
 * genuinely sleeps makes the suite slower every time someone adds a case. Tests
 * pass a no-op that records what it was asked to wait for.
 */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface JiraCredential {
  email: string;
  token: string;
}

/**
 * Jira's own explanation of a 400, read from named fields (HIVE-70).
 *
 * The epic's rule is that no raw response body escapes, and this does not break
 * it: Jira's error body is **structured**, so exactly two keys are read —
 * `errorMessages`, an array of strings, and the *values* of `errors`, a
 * field-keyed map. Nothing else in the body is looked at, each string is capped,
 * control characters are stripped, and the list is bounded.
 *
 * Without this a transition that needs a resolution would report "Jira could not
 * understand the request", which tells the user nothing they can act on. Naming
 * the field is the entire difference between a dead end and a fix.
 */
function readDetails(text: string): string[] | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  const found: string[] = [];

  const take = (value: unknown): void => {
    if (typeof value !== 'string' || value.trim() === '') return;
    if (found.length >= JIRA_MAX_DETAILS) return;
    // Control characters stripped rather than the string rejected: this is a
    // server's prose, and losing a stray byte is better than losing the message
    // that names the field.
    const clean = [...value.slice(0, JIRA_MAX_DETAIL_LENGTH)]
      .filter((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
      })
      .join('');
    if (clean !== '') found.push(clean);
  };

  if (Array.isArray(record.errorMessages)) {
    for (const entry of record.errorMessages) take(entry);
  }
  const errors = record.errors;
  if (typeof errors === 'object' && errors !== null && !Array.isArray(errors)) {
    for (const [field, value] of Object.entries(errors)) {
      // The field name is the useful half, so it is kept beside the message.
      if (typeof value === 'string') take(`${field}: ${value}`);
    }
  }

  return found.length === 0 ? undefined : found;
}

export interface JiraClient {
  /**
   * `path` is a literal from this codebase; `params` are URL-encoded.
   *
   * A `Record<string, string>` fed to `URLSearchParams` rather than a string
   * appended to a path, and the difference is the whole point: there is no
   * syntax for a caller to escape from, so a JQL string full of `&`, `=` and
   * spaces is a value rather than a chance to add a parameter.
   */
  get<T>(path: string, params?: Record<string, string>): Promise<JiraResult<T>>;
  /**
   * A write. **Never retried** (HIVE-70).
   *
   * HIVE-68's `get` retries 429 and 5xx once, and its header wrote down that
   * the first POST does not get to inherit that. This is that POST, and the
   * reason holds: retrying a transition that may already have applied is how an
   * issue moves twice, and a duplicated workflow transition can fire automation
   * — a Slack message, a deploy — that cannot be taken back. A 429 here is
   * reported with its `retryAfter` and the user decides.
   *
   * `T` is `void` for an endpoint that answers 204, which the transition POST
   * does.
   */
  post<T>(path: string, body: unknown): Promise<JiraResult<T>>;
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

/**
 * One attempt's outcome, plus the fact `get` needs to decide about a retry.
 *
 * The HTTP status is carried separately rather than inferred from
 * {@link JiraError.kind}, because `unknown` covers three different things — a
 * 5xx, a body past the cap, and a response that was not JSON. Only the first is
 * worth a second request, and a `kind` alone cannot tell them apart.
 */
interface Attempt<T> {
  result: JiraResult<T>;
  /** The HTTP status, or `0` when the request never produced one. */
  status: number;
}

/**
 * Which failures are worth one automatic retry (HIVE-68).
 *
 * 429 and 5xx only. A 401 will be a 401 again, a 404 will still be missing, and
 * a 400 is a query Jira already told us it cannot parse — retrying any of them
 * is a second request that can only produce the same answer more slowly. A
 * status of `0` is a network failure or a body this client refused; neither
 * becomes true on a second try inside the same verb.
 */
const retryable = (status: number): boolean => status === 429 || status >= 500;

export function createJiraClient(deps: {
  fetch: FetchLike;
  /** A bare hostname, already validated by `assertJiraSite`. */
  site: string;
  credential: JiraCredential;
  /** Injected so no test waits. Defaults to a real `setTimeout`. */
  sleep?: Sleep;
}): JiraClient {
  const { fetch, site, credential } = deps;
  const sleep = deps.sleep ?? realSleep;

  // Built once, here and nowhere else — the only place the two halves of the
  // credential are ever joined.
  const authorization = `Basic ${Buffer.from(
    `${credential.email}:${credential.token}`,
    'utf8',
  ).toString('base64')}`;

  const url = (path: string, params?: Record<string, string>): string => {
    // `URLSearchParams` rather than string concatenation: a JQL query is full of
    // `&`, `=` and spaces, and this is what makes those a *value* rather than a
    // chance to append a parameter the caller did not intend.
    const query =
      params === undefined ? '' : `?${new URLSearchParams(params).toString()}`;
    return `https://${site}${path}${query}`;
  };

  /**
   * One attempt. The retry policy lives in `get`, so this stays readable —
   * and `post` deliberately has none.
   */
  async function attempt<T>(
    target: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<Attempt<T>> {
      let response: Response;
      try {
        response = await fetch(target, {
          method,
          headers: {
            authorization,
            accept: 'application/json',
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
        return {
          status: 0,
          result: aborted
            ? error('timeout', 'Jira did not answer within ten seconds.')
            : error('offline', 'Could not reach Jira. The network may be down.'),
        };
      }

      if (!response.ok) {
        /**
         * A 400's body is read, and only a 400's.
         *
         * Every other status has a message this file already composed from the
         * code alone. A 400 is the one case where Jira knows something the app
         * cannot infer — *which field* it wanted — and {@link readDetails}
         * takes that from named keys rather than quoting the body.
         */
        let details: string[] | undefined;
        if (response.status === 400) {
          const raw = await response.text();
          if (raw.length <= MAX_RESPONSE_BYTES) details = readDetails(raw);
        }

        const failure = fromStatus(response.status, retryAfterSeconds(response));
        return {
          status: response.status,
          result:
            details === undefined || failure.ok
              ? failure
              : { ok: false, error: { ...failure.error, details } },
        };
      }

      // Checked before reading, so a server that declares a huge body costs one
      // header rather than 256 KiB of heap.
      const declared = Number.parseInt(
        response.headers.get('content-length') ?? '',
        10,
      );
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        // Status 0: a body this client refused is not worth asking for twice.
        return {
          status: 0,
          result: error('unknown', "Jira's answer was too large to read."),
        };
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        return {
          status: 0,
          result: error('unknown', "Jira's answer was too large to read."),
        };
      }

      /**
       * An empty body is a success, not a parse failure.
       *
       * `POST /transitions` answers `204 No Content` — there is nothing to
       * return and Jira does not pretend otherwise. Without this the one verb
       * that writes would report "Jira answered with something that was not
       * JSON" every time it worked.
       */
      if (text.trim() === '') {
        return {
          status: response.status,
          result: { ok: true, value: undefined as T },
        };
      }

      try {
        return { status: response.status, result: { ok: true, value: JSON.parse(text) as T } };
      } catch {
        // The body is not quoted. A proxy's HTML error page is the common case
        // here, and pasting it into the settings pane helps nobody. Status 0 —
        // a server answering HTML will answer HTML again.
        return {
          status: 0,
          result: error(
            'unknown',
            'Jira answered with something that was not JSON.',
          ),
        };
      }
  }

  return {
    /**
     * One request, with **one** automatic retry for 429 and 5xx.
     *
     * One, not a policy. This is a read refreshed on pane open and on user
     * action, so the user's next click already is the retry loop. What a single
     * automatic attempt buys is surviving the one transient 502 that would
     * otherwise put an error in front of something already fixed — and it costs
     * one request rather than a backoff schedule nobody can predict the end of.
     *
     * A second failure is reported, not retried again.
     */
    async get<T>(
      path: string,
      params?: Record<string, string>,
    ): Promise<JiraResult<T>> {
      const target = url(path, params);
      const first = await attempt<T>(target, 'GET');
      if (first.result.ok || !retryable(first.status)) return first.result;

      const retryAfter = first.result.ok ? undefined : first.result.error.retryAfter;

      /**
       * `Retry-After` is honoured, but only up to the cap.
       *
       * Past it the client returns *now*, with `retryAfter` still on the error,
       * so the pane can say when to try again instead of holding an IPC call
       * open for minutes with no way for the user to cancel it.
       */
      const wait =
        retryAfter === undefined ? JIRA_BACKOFF_MS : retryAfter * 1000;
      if (wait > JIRA_MAX_RETRY_DELAY_MS) return first.result;

      await sleep(wait);
      return (await attempt<T>(target, 'GET')).result;
    },

    /**
     * A write, attempted exactly once (HIVE-70).
     *
     * No retry, and that is the whole design rather than an omission. A
     * transition POST that timed out may already have applied — Jira does not
     * offer an idempotency key here — so a second attempt can move the issue
     * twice and fire whatever automation the workflow hangs off that
     * transition. A duplicate Slack message is recoverable; a duplicate deploy
     * is not, and neither is worth saving the user one click.
     *
     * A 429 is therefore reported with its `retryAfter` and the user decides.
     */
    async post<T>(path: string, body: unknown): Promise<JiraResult<T>> {
      return (await attempt<T>(url(path), 'POST', body)).result;
    },
  };
}

/**
 * The Jira integration's contract (HIVE-67).
 *
 * Separate from `ipc-contract.ts` because the epic adds four more stories'
 * worth of Jira types, and folding them into the channel registry would make
 * that file about Jira rather than about IPC. The same rules apply here as
 * there: types and constants only, no runtime imports, no Node APIs, no DOM
 * APIs — this is a module both processes import.
 */

/**
 * The variable consulted when nothing is stored.
 *
 * The Linux fallback, and the escape hatch on any machine: `safeStorage`
 * cannot encrypt without an OS keyring, and writing a base64 blob and calling
 * it encrypted would be worse than storing nothing, because the user would
 * believe it was protected.
 */
export const JIRA_TOKEN_ENV = 'JIRA_API_KEY';

/**
 * Where the credential comes from — never what it is.
 *
 * A discriminated union rather than a bag of booleans because the four cases
 * are mutually exclusive, and each one has different copy and different
 * controls. `stored` carries the email so the pane can say whose token it is
 * without a second read.
 */
export type JiraCredentialState =
  | { kind: 'none' }
  | { kind: 'stored'; email: string }
  | { kind: 'env'; variable: typeof JIRA_TOKEN_ENV }
  | { kind: 'unavailable'; reason: string };

/** What `jira:status` answers with. Contains no secret, by construction. */
export interface JiraStatus {
  /** The configured host, or `null`. A bare hostname, never a URL. */
  site: string | null;
  email: string | null;
  credential: JiraCredentialState;
  /**
   * Whether this machine can encrypt at all.
   *
   * Reported beside the union rather than folded into it, because the two
   * answer different questions and can disagree: a Linux box with no keyring
   * but `JIRA_API_KEY` set is `{ kind: 'env' }` *and* cannot store anything.
   * A fifth union member whose only job was to be that conjunction would have
   * to be repeated for every future state.
   */
  encryptionAvailable: boolean;
}

/** Answer to `jira:test` — `GET /rest/api/3/myself`, narrowed to two fields. */
export interface JiraIdentity {
  displayName: string;
  accountId: string;
}

export type JiraErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'offline'
  | 'timeout'
  | 'bad-query'
  | 'unknown';

export interface JiraError {
  kind: JiraErrorKind;
  /** Safe to show. Never contains the token or a raw response body. */
  message: string;
  /** Seconds, from `Retry-After`. Only on `rate-limited`. */
  retryAfter?: number;
}

/**
 * Every Jira verb answers with this rather than throwing across IPC.
 *
 * `gh.ts`'s rule (gh.ts:166-172): the pane must render either way. A section
 * that throws because an external service misbehaved tells the user this app is
 * broken, when the truth is that Jira is unreachable.
 */
export type JiraResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: JiraError };

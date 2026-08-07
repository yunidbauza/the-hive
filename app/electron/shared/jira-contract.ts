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

/** Jira's own three-bucket categorisation, normalised (HIVE-68). */
export type JiraStatusCategory = 'todo' | 'in-progress' | 'done';

/**
 * One issue, as this app is willing to carry it across IPC (HIVE-68).
 *
 * Deliberately **not** the renderer's `Ticket`. Two reasons, and they point the
 * same way: `electron/main/**` may not import `src/**`, so the mapping layer
 * could not produce a `Ticket` even if it wanted to; and `Ticket` carries
 * `sessions`, which is the app's own concern and has no Jira counterpart.
 *
 * This is *what Jira said, named and narrowed*. HIVE-69 converts it into *what
 * the app renders*. Collapsing the two would drag `sessions` into a Jira type or
 * Jira's vocabulary into the store.
 */
export interface JiraIssue {
  key: string;
  summary: string;
  /** The status as Jira names it. Displayed verbatim, never mapped to a literal. */
  status: string;
  statusCategory: JiraStatusCategory;
  issueType: string;
  /** `null` on a project with no priority scheme. */
  priority: string | null;
  /** Display name. `null` when unassigned, which is a backlog's normal state. */
  assignee: string | null;
  /** ISO 8601, as Jira sent it. Not reformatted — the renderer owns display. */
  updated: string;
  /**
   * The browse URL.
   *
   * Built in main, because only main knows the site. Handing the renderer the
   * site so it could build this itself would hand it the one value the client
   * refuses to take from a payload.
   */
  url: string;
}

export interface JiraSearchResult {
  issues: JiraIssue[];
  /**
   * True when the cap stopped paging while Jira still had more.
   *
   * A truncated backlog shown silently is a lie the user cannot detect — they
   * would simply believe they have {@link JIRA_MAX_ISSUES} tickets. This is what
   * lets the panel say otherwise, and it is on the result rather than logged in
   * main precisely because a log is where nobody sees it.
   */
  capped: boolean;
}

/**
 * The fields `/rest/api/3/search/jql` is asked for (HIVE-68).
 *
 * **Required.** The endpoint returns no default field set; omit this and every
 * issue comes back with a key and nothing else. Exactly what the ticket card
 * renders and nothing more — every field named here has to survive the epic's
 * rule that only mapped, named fields cross IPC.
 */
export const JIRA_FIELDS = 'summary,status,issuetype,priority,updated,assignee';

/**
 * The query when the user has configured none (HIVE-68).
 *
 * `currentUser()` is evaluated by Jira, so the app never has to know the account
 * id to run it.
 */
export const JIRA_DEFAULT_JQL =
  'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

/** Jira Cloud's maximum page size for this endpoint. */
export const JIRA_PAGE_SIZE = 100;

/**
 * The paging cap.
 *
 * Reaching it sets {@link JiraSearchResult.capped}; it never truncates silently.
 */
export const JIRA_MAX_ISSUES = 200;

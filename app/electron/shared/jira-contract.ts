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
  /**
   * The issue moved underneath us (HIVE-70).
   *
   * The epic's error table is about HTTP conditions and has no row for this,
   * because it is not one: a stale transition id and a missing required field
   * are both `400`, and they are told apart by re-reading the transitions
   * rather than by matching Jira's prose, which would break on the first
   * non-English instance. It reads differently in the UI from a validation
   * failure, so it is its own kind.
   */
  | 'stale'
  | 'unknown';

export interface JiraError {
  kind: JiraErrorKind;
  /** Safe to show. Never contains the token or a raw response body. */
  message: string;
  /** Seconds, from `Retry-After`. Only on `rate-limited`. */
  retryAfter?: number;
  /**
   * Jira's own explanation, parsed into named fields (HIVE-70).
   *
   * Sits carefully *alongside* "no raw response body escapes" rather than
   * against it. Jira's error body is **structured** — `errorMessages`, and a
   * field-keyed `errors` map — so this is read from exactly those two, bounded
   * to {@link JIRA_MAX_DETAILS} entries of {@link JIRA_MAX_DETAIL_LENGTH}
   * characters with control characters stripped, and nothing else in the body
   * is looked at. The same discipline `mapping.ts` applies to an issue, not an
   * exception to it.
   *
   * Populated only where a 400 body parsed. It exists so a transition that
   * needs a resolution can name the field, which is the one thing the user has
   * to know in order to fix it.
   */
  details?: string[];
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

/**
 * One transition available from an issue's *current* status (HIVE-70).
 *
 * Read per issue, always. Transition ids are per-workflow and not stable across
 * projects, so an id cached from one issue is meaningless on another and a
 * hard-coded one is meaningless everywhere.
 */
export interface JiraTransition {
  id: string;
  /** The label, as Jira names it — "Start progress", "Done". */
  name: string;
  /** Where it lands, so the menu shows a destination and not just a verb. */
  to: {
    name: string;
    statusCategory: JiraStatusCategory;
  };
}

/** How many of Jira's own error strings are carried across IPC (HIVE-70). */
export const JIRA_MAX_DETAILS = 10;

/** And how long each may be. Bounded, because it came from a server. */
export const JIRA_MAX_DETAIL_LENGTH = 300;

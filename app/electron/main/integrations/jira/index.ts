import type {
  AddJiraCommentRequest,
  ApplyJiraTransitionRequest,
  ConfigSnapshot,
  JiraConversationRequest,
  JiraIssueRequest,
  JiraSearchRequest,
  JiraTransitionsRequest,
  SetJiraTokenRequest,
} from '../../../shared/config-contract';
import {
  JIRA_DEFAULT_JQL,
  JIRA_FIELDS,
  JIRA_MAX_COMMENTS,
  JIRA_MAX_ISSUES,
  JIRA_PAGE_SIZE,
  type JiraIdentity,
  type JiraIssue,
  type JiraResult,
  type JiraSearchResult,
  type JiraComment,
  type JiraLink,
  type JiraStatus,
  type JiraTransition,
} from '../../../shared/jira-contract';

import { validateAdf } from './adf/adf-validate';
import { convertMarkdown } from './adf/markdown-to-adf';
import {
  createJiraAuth,
  type JiraAuth,
  type SecretFile,
  type SecretStore,
} from './auth';
import { createJiraClient, type FetchLike, type JiraClient, type Sleep } from './client';
import {
  toComment,
  toIssue,
  toIssueLink,
  toRemoteLink,
  toTransition,
} from './mapping';

/**
 * The verbs main exposes for Jira (HIVE-67).
 *
 * Composition, and nothing else. `auth.ts` owns the credential, `client.ts`
 * owns HTTP, and this file owns two decisions: which of them a verb needs, and
 * what happens when the app is not configured yet.
 *
 * **Every verb answers; none throws.** A settings pane that cannot render
 * because Jira is unreachable tells the user this app is broken, when the truth
 * is that Jira is unreachable — `gh.ts:166-172`'s rule, and the reason the
 * result union exists.
 */

/** Endpoints. Constants, never assembled from a payload. */
const MYSELF = '/rest/api/3/myself';
const SEARCH = '/rest/api/3/search/jql';
const ISSUE = '/rest/api/3/issue';

export interface Jira {
  status(): JiraStatus;
  setToken(request: SetJiraTokenRequest): JiraStatus;
  clearToken(): JiraStatus;
  test(): Promise<JiraResult<JiraIdentity>>;
  /** Run a JQL query, paging to {@link JIRA_MAX_ISSUES} (HIVE-68). */
  search(request: JiraSearchRequest): Promise<JiraResult<JiraSearchResult>>;
  /** Read one issue by key (HIVE-68). */
  issue(request: JiraIssueRequest): Promise<JiraResult<JiraIssue>>;
  /** The transitions available from this issue's current status (HIVE-70). */
  transitions(
    request: JiraTransitionsRequest,
  ): Promise<JiraResult<JiraTransition[]>>;
  /**
   * Apply one, and answer with the **re-read** issue (HIVE-70).
   *
   * Returning the issue rather than `void` is what makes an optimistic guess
   * impossible: a caller that wanted to assume the new status would have to
   * ignore a value it was handed.
   */
  applyTransition(
    request: ApplyJiraTransitionRequest,
  ): Promise<JiraResult<JiraIssue>>;
  /** An issue's conversation, oldest first (HIVE-71). */
  comments(request: JiraConversationRequest): Promise<JiraResult<JiraComment[]>>;
  /** Remote links and Jira-to-Jira links, in one list (HIVE-71). */
  links(request: JiraConversationRequest): Promise<JiraResult<JiraLink[]>>;
  /** Post a comment written as markdown (HIVE-71). */
  addComment(request: AddJiraCommentRequest): Promise<JiraResult<JiraComment>>;
}

/**
 * What every network verb needs, or the reason it cannot run.
 *
 * A discriminated union rather than three thrown errors, because "not
 * configured yet" is an ordinary state of a fresh install and the pane has to
 * render a sentence about it.
 */
type Connection =
  | { ok: true; site: string; client: JiraClient }
  | { ok: false; error: JiraResult<never> };

export function createJira(deps: {
  store: SecretStore;
  file: SecretFile;
  env: NodeJS.ProcessEnv;
  /**
   * Read fresh on every verb, not captured.
   *
   * The config file is hand-editable and story 107 ships a button that reveals
   * it, so a site captured at construction would be the site the app started
   * with rather than the one on disk.
   */
  config: () => ConfigSnapshot;
  fetch: FetchLike;
  /** Injected so no test waits on the retry path. */
  sleep?: Sleep;
}): Jira {
  const { config, fetch } = deps;
  const auth: JiraAuth = createJiraAuth({
    store: deps.store,
    file: deps.file,
    env: deps.env,
  });

  const status = (): JiraStatus => {
    const { site, email } = config().jira;
    return {
      site,
      email,
      credential: auth.state(email),
      encryptionAvailable: auth.encryptionAvailable(),
    };
  };

  /**
   * Resolve the three things a request needs, or the reason it cannot be made.
   *
   * Shared by all three network verbs so a half-configured install gets the same
   * sentence whichever one the pane called — three copies of this preamble is
   * how two verbs quietly start disagreeing about what "not set up" means.
   *
   * The config is read here, on every call, so an edit to the file reaches the
   * next request without a restart.
   */
  const connect = (): Connection => {
    const { site, email } = config().jira;
    if (site === null) {
      return {
        ok: false,
        error: {
          ok: false,
          error: { kind: 'bad-query', message: 'No Jira site is configured yet.' },
        },
      };
    }
    if (email === null) {
      return {
        ok: false,
        error: {
          ok: false,
          error: {
            kind: 'bad-query',
            message: 'No account email is configured yet.',
          },
        },
      };
    }

    const token = auth.token();
    if (token === null) {
      return {
        ok: false,
        error: {
          ok: false,
          error: {
            kind: 'unauthorized',
            message: 'No API token is stored, and JIRA_API_KEY is not set.',
          },
        },
      };
    }

    return {
      ok: true,
      site,
      client: createJiraClient({
        fetch,
        site,
        credential: { email, token },
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      }),
    };
  };

  /**
   * Read one issue and map it.
   *
   * A local function rather than a method, so `applyTransition` can re-read
   * without reaching through `this` — an object literal's `this` is the kind of
   * binding that survives every refactor until the one where it does not.
   */
  const readIssue = async (
    request: JiraIssueRequest,
  ): Promise<JiraResult<JiraIssue>> => {
    const connection = connect();
    if (!connection.ok) return connection.error;

    const result = await connection.client.get<unknown>(
      `${ISSUE}/${request.key}`,
      { fields: JIRA_FIELDS },
    );
    if (!result.ok) return result;

    const mapped = toIssue(result.value, connection.site);
    if (mapped === null) {
      return {
        ok: false,
        error: {
          kind: 'unknown',
          message: `Jira's answer for ${request.key} could not be read.`,
        },
      };
    }
    return { ok: true, value: mapped };
  };

  return {
    status,

    setToken(request) {
      try {
        auth.save(request.token);
      } catch {
        /**
         * Swallowed deliberately — the returned *state* is the report.
         *
         * `save` throws for exactly one reason, and in that case `status()`
         * already answers `unavailable` carrying the sentence the pane shows.
         * Rejecting the invoke as well would make the renderer handle one fact
         * twice, in two shapes, and the rejection path is the one that would
         * rot.
         */
      }
      return status();
    },

    clearToken() {
      auth.clear();
      return status();
    },

    async test() {
      const connection = connect();
      if (!connection.ok) return connection.error;

      const result = await connection.client.get<{
        displayName?: unknown;
        accountId?: unknown;
      }>(MYSELF);
      if (!result.ok) return result;

      /**
       * Narrowed to two fields before it crosses IPC.
       *
       * `/myself` also returns an avatar map, a locale, a time zone and the
       * account's email address. The epic's rule is that only mapped, named
       * fields ever cross — forwarding the payload would hand the renderer
       * personal data it has no use for, and would set the precedent that raw
       * Jira JSON is allowed through.
       */
      const { displayName, accountId } = result.value;
      if (typeof displayName !== 'string' || typeof accountId !== 'string') {
        return {
          ok: false,
          error: {
            kind: 'unknown',
            message: 'Jira answered without an account name.',
          },
        };
      }
      return { ok: true, value: { displayName, accountId } };
    },

    /**
     * Run a JQL query, paging to the cap (HIVE-68).
     *
     * Pagination is **token-based** on this endpoint — `nextPageToken`, not
     * `startAt`/`total`. There is no total count, so there is no progress to
     * report and no way to size the array up front; the only stopping
     * conditions are "Jira sent no token" and "we hit the cap".
     *
     * Reaching the cap sets `capped` rather than truncating quietly. A user
     * shown 200 of 900 tickets with no indication would simply believe they
     * have 200 — the one failure mode a read path can have that the user cannot
     * detect for themselves.
     */
    async search(request) {
      const connection = connect();
      if (!connection.ok) return connection.error;

      /**
       * Three levels, most specific first (HIVE-69).
       *
       * An explicit request wins — that is the settings pane's "Test query",
       * checking a draft before it is saved. Otherwise the configured override,
       * which **replaces** the default rather than being appended to: a user
       * who writes JQL expects their query to be the query. Otherwise the
       * default, whose `currentUser()` Jira evaluates so the app never needs an
       * account id.
       *
       * Resolved here rather than in the renderer because main already reads
       * the config on every verb, and passing it in would mean the store
       * holding a setting it would then race a hand-edit of the file over.
       */
      const jql = request.jql ?? config().jira.jql ?? JIRA_DEFAULT_JQL;
      const issues: JiraIssue[] = [];
      let nextPageToken: string | undefined;
      let capped = false;

      for (;;) {
        const page = await connection.client.get<{
          issues?: unknown;
          nextPageToken?: unknown;
        }>(SEARCH, {
          jql,
          // Required. The endpoint returns no default field set — omit this and
          // every issue comes back with a key and nothing else.
          fields: JIRA_FIELDS,
          maxResults: String(
            Math.min(JIRA_PAGE_SIZE, JIRA_MAX_ISSUES - issues.length),
          ),
          ...(nextPageToken === undefined ? {} : { nextPageToken }),
        });
        if (!page.ok) return page;

        const raw = Array.isArray(page.value.issues) ? page.value.issues : [];
        for (const entry of raw) {
          // A malformed entry costs itself and nothing else: forty-nine tickets
          // beat an error because the thirtieth had no `fields`.
          const mapped = toIssue(entry, connection.site);
          if (mapped !== null) issues.push(mapped);
        }

        const token = page.value.nextPageToken;
        if (typeof token !== 'string' || token === '') break;
        if (issues.length >= JIRA_MAX_ISSUES) {
          // Jira had more and the cap is why we stopped — which is exactly the
          // case `capped` exists to distinguish from "that was all of them".
          capped = true;
          break;
        }
        nextPageToken = token;
      }

      return { ok: true, value: { issues, capped } };
    },

    /**
     * Read one issue (HIVE-68).
     *
     * The key reaches a URL path, so it is validated by `assertJiraIssueKey`
     * at the IPC boundary before it ever gets here. This is the second half of
     * that rule and not a substitute for it: nothing in this function would stop
     * a path segment, which is why the guard matches rather than escapes.
     */
    issue: readIssue,

    /**
     * What this issue can become, right now (HIVE-70).
     *
     * Read per issue, never cached across issues. Jira does not let you set a
     * status: you fetch the transitions available *from the issue's current
     * status in its workflow* and apply one by id, and those ids are
     * per-workflow — an id from one issue means nothing on another.
     */
    async transitions(request) {
      const connection = connect();
      if (!connection.ok) return connection.error;

      const result = await connection.client.get<{ transitions?: unknown }>(
        `${ISSUE}/${request.key}/transitions`,
      );
      if (!result.ok) return result;

      const raw = Array.isArray(result.value.transitions)
        ? result.value.transitions
        : [];
      const mapped: JiraTransition[] = [];
      for (const entry of raw) {
        // One malformed transition costs itself: a workflow with a bad entry
        // should still offer the others rather than refuse to open a menu.
        const one = toTransition(entry);
        if (one !== null) mapped.push(one);
      }
      return { ok: true, value: mapped };
    },

    /**
     * Apply a transition, then re-read the issue (HIVE-70).
     *
     * ## Telling a stale id from a missing field
     *
     * Both are `400`, and Jira's prose is the only thing that distinguishes
     * them — which would break on the first non-English instance. So the
     * distinction is made **by asking again**: on any 400, re-read the
     * transitions. If the id that was sent is no longer among them, the issue
     * moved underneath us. If it is still there, the request itself was
     * rejected, and `details` carries the field Jira named.
     *
     * Deterministic, locale-independent, and it costs one extra GET on a path
     * that has already failed.
     */
    async applyTransition(request) {
      const connection = connect();
      if (!connection.ok) return connection.error;

      const applied = await connection.client.post<void>(
        `${ISSUE}/${request.key}/transitions`,
        { transition: { id: request.transitionId } },
      );

      if (!applied.ok) {
        if (applied.error.kind !== 'bad-query') return applied;

        const fresh = await connection.client.get<{ transitions?: unknown }>(
          `${ISSUE}/${request.key}/transitions`,
        );
        const still =
          fresh.ok &&
          Array.isArray(fresh.value.transitions) &&
          fresh.value.transitions.some(
            (entry) => toTransition(entry)?.id === request.transitionId,
          );

        if (!still) {
          return {
            ok: false,
            error: {
              kind: 'stale',
              message:
                'This issue has moved since its transitions were read. They have been read again.',
            },
          };
        }
        return applied;
      }

      /**
       * Re-read rather than guess.
       *
       * A transition can land the issue somewhere the menu did not predict —
       * a post-function, a workflow condition, another transition firing — so
       * the only honest answer to "what is it now" is to ask.
       */
      return readIssue({ key: request.key });
    },

    /**
     * The conversation, oldest first (HIVE-71).
     *
     * Oldest first because a comment thread is an argument, and reading an
     * argument backwards is how you misunderstand it. Jira's default for this
     * endpoint is already ascending; asking explicitly means a change to that
     * default does not silently reverse the panel.
     */
    async comments(request) {
      const connection = connect();
      if (!connection.ok) return connection.error;

      const result = await connection.client.get<{ comments?: unknown }>(
        `${ISSUE}/${request.key}/comment`,
        { orderBy: 'created', maxResults: String(JIRA_MAX_COMMENTS) },
      );
      if (!result.ok) return result;

      const raw = Array.isArray(result.value.comments)
        ? result.value.comments
        : [];
      const mapped: JiraComment[] = [];
      for (const entry of raw) {
        // One unreadable comment costs itself, not the conversation.
        const one = toComment(entry);
        if (one !== null) mapped.push(one);
      }
      return { ok: true, value: mapped };
    },

    /**
     * Both kinds of link, in one list (HIVE-71).
     *
     * Two requests, because Jira keeps them in two places: remote/web links have
     * their own endpoint, and Jira-to-Jira links ride on the issue as
     * `fields.issuelinks`. The user does not care which API a link came from, so
     * they arrive merged.
     *
     * A failure on either half is reported rather than half-answered. A link
     * list missing the half that happened to fail is indistinguishable from an
     * issue that genuinely has no links that way.
     */
    async links(request) {
      const connection = connect();
      if (!connection.ok) return connection.error;

      const remote = await connection.client.get<unknown>(
        `${ISSUE}/${request.key}/remotelink`,
      );
      if (!remote.ok) return remote;

      const issue = await connection.client.get<{ fields?: unknown }>(
        `${ISSUE}/${request.key}`,
        { fields: 'issuelinks' },
      );
      if (!issue.ok) return issue;

      const links: JiraLink[] = [];

      for (const entry of Array.isArray(remote.value) ? remote.value : []) {
        const one = toRemoteLink(entry);
        if (one !== null) links.push(one);
      }

      const fields = issue.value.fields;
      const issuelinks =
        typeof fields === 'object' && fields !== null
          ? (fields as { issuelinks?: unknown }).issuelinks
          : undefined;
      for (const entry of Array.isArray(issuelinks) ? issuelinks : []) {
        const one = toIssueLink(entry, connection.site);
        if (one !== null) links.push(one);
      }

      return { ok: true, value: links };
    },

    /**
     * Post a comment (HIVE-71).
     *
     * ## Validated locally, before anything is sent
     *
     * An ADF document Jira rejects comes back as a 400 whose message does not
     * say which node was wrong. `validateAdf` is what turns that into a
     * diagnosable failure — and because it runs *before* the request, a
     * malformed document never reaches Jira at all.
     *
     * ## Markdown in, ADF out, conversion in main
     *
     * The renderer sends what the user typed. Building the document there would
     * mean shipping the vendored parser into the browser bundle and trusting a
     * structure the IPC guard cannot meaningfully check — a guard can bound a
     * string, but "is this a valid ADF tree" is exactly the question this
     * validator exists to answer, in main, where the answer is enforceable.
     */
    async addComment(request) {
      const connection = connect();
      if (!connection.ok) return connection.error;

      const body = convertMarkdown(request.markdown);
      const validation = validateAdf(body);
      /**
       * Defensive, and deliberately so.
       *
       * No markdown reaches this branch today: the converter resolves ADF's
       * mark exclusivity itself, always sets `localId` on task nodes, always
       * gives table cells an `attrs`, and never puts a block inside a
       * paragraph. `markdown-to-adf.test.ts` asserts that pairing directly —
       * every document it produces validates.
       *
       * The branch exists for the change that breaks one of those, which is
       * the change that would otherwise ship a 400 naming nothing. Its cost is
       * one comparison; its absence would be a silent failure mode.
       */
      if (!validation.ok) {
        return {
          ok: false,
          error: {
            kind: 'bad-query',
            message: 'That comment could not be turned into a valid document.',
            // The rule and the path, so the failure names something. This is
            // the app's own diagnosis, not a quoted server response.
            details: [`${validation.rule} at ${validation.path || 'the document'}: ${validation.message}`],
          },
        };
      }

      const posted = await connection.client.post<unknown>(
        `${ISSUE}/${request.key}/comment`,
        { body },
      );
      if (!posted.ok) return posted;

      const mapped = toComment(posted.value);
      if (mapped === null) {
        return {
          ok: false,
          error: {
            kind: 'unknown',
            message: 'The comment was posted, but Jira\'s answer could not be read.',
          },
        };
      }
      return { ok: true, value: mapped };
    },
  };
}

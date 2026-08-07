import type {
  ConfigSnapshot,
  JiraIssueRequest,
  JiraSearchRequest,
  SetJiraTokenRequest,
} from '../../../shared/config-contract';
import {
  JIRA_DEFAULT_JQL,
  JIRA_FIELDS,
  JIRA_MAX_ISSUES,
  JIRA_PAGE_SIZE,
  type JiraIdentity,
  type JiraIssue,
  type JiraResult,
  type JiraSearchResult,
  type JiraStatus,
} from '../../../shared/jira-contract';

import {
  createJiraAuth,
  type JiraAuth,
  type SecretFile,
  type SecretStore,
} from './auth';
import { createJiraClient, type FetchLike, type JiraClient, type Sleep } from './client';
import { toIssue } from './mapping';

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
    async issue(request) {
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
    },
  };
}

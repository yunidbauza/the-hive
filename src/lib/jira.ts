import type {
  AddJiraCommentRequest,
  ApplyJiraTransitionRequest,
  JiraConversationRequest,
  JiraIssueRequest,
  JiraSearchRequest,
  JiraTransitionsRequest,
} from '@shared/config-contract';
import type {
  JiraComment,
  JiraIdentity,
  JiraIssue,
  JiraLink,
  JiraResult,
  JiraSearchResult,
  JiraStatus,
  JiraTransition,
} from '@shared/jira-contract';

/**
 * The renderer's half of the Jira bridge (HIVE-67).
 *
 * Mirrors `project-config.ts` in the two ways that matter. **No bridge returns
 * `null`** — that is the browser demo, not a failure, and story 083's rule is to
 * feature-detect the bridge rather than the user agent. **A rejected channel
 * returns `null` too**, logged once, because a settings section that throws when
 * IPC hiccups is worse than one that says it does not know.
 *
 * No module-level cache here, unlike `project-config.ts`. The credential state
 * is read by exactly one pane, which holds it in component state and re-reads
 * after each write — there is no second consumer for a cache to keep in sync,
 * and a stale credential state is the one thing this surface must not show.
 *
 * The token appears in exactly one function's parameter list, and is never
 * logged — including on the failure path, which is the branch where a careless
 * `console.error('…', request)` would put a live credential in the devtools
 * console.
 */

async function call<T>(
  verb: string,
  run: (bridge: NonNullable<Window['hive']>) => Promise<T>,
): Promise<T | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await run(bridge);
  } catch (cause) {
    // The verb name and the cause — never the payload. `saveJiraToken`'s
    // payload is a secret, and this line is shared by all four verbs.
    console.error(`[hive] jira.${verb} failed:`, cause);
    return null;
  }
}

/** Where the credential comes from, and what the site and email are. */
export const readJiraStatus = (): Promise<JiraStatus | null> =>
  call('status', (bridge) => bridge.jira.status());

/**
 * Store a token.
 *
 * Answers with the fresh status, so the pane never has to follow a write with a
 * read — the same contract every mutating config verb has.
 */
export const saveJiraToken = (token: string): Promise<JiraStatus | null> =>
  call('setToken', (bridge) => bridge.jira.setToken({ token }));

export const clearJiraToken = (): Promise<JiraStatus | null> =>
  call('clearToken', (bridge) => bridge.jira.clearToken());

/**
 * `GET /rest/api/3/myself`.
 *
 * Resolves `null` only when the channel itself failed. A Jira that answered
 * with a refusal is a `JiraResult` whose `ok` is false — that is an answer, and
 * the pane shows it.
 */
export const testJiraConnection = (): Promise<JiraResult<JiraIdentity> | null> =>
  call('test', (bridge) => bridge.jira.test());

/**
 * Run a JQL query (HIVE-68).
 *
 * Named for what it searches rather than just `search`, because a bare `search`
 * in `src/lib/` says nothing about what is being searched. Resolves `null` only
 * when the channel itself failed — a Jira that refused is a `JiraResult` whose
 * `ok` is false, and that is an answer the panel shows.
 */
export const searchJiraIssues = (
  request: JiraSearchRequest = {},
): Promise<JiraResult<JiraSearchResult> | null> =>
  call('search', (bridge) => bridge.jira.search(request));

/** Read one issue by key (HIVE-68). */
export const readJiraIssue = (
  request: JiraIssueRequest,
): Promise<JiraResult<JiraIssue> | null> =>
  call('issue', (bridge) => bridge.jira.issue(request));

/** What an issue can become right now (HIVE-70). Read per issue, never cached. */
export const readJiraTransitions = (
  request: JiraTransitionsRequest,
): Promise<JiraResult<JiraTransition[]> | null> =>
  call('transitions', (bridge) => bridge.jira.transitions(request));

/**
 * Move an issue (HIVE-70).
 *
 * Answers with the re-read issue, so a caller has no reason to guess the new
 * status and nothing to reconcile if the workflow landed it somewhere else.
 */
export const applyJiraTransition = (
  request: ApplyJiraTransitionRequest,
): Promise<JiraResult<JiraIssue> | null> =>
  call('applyTransition', (bridge) => bridge.jira.applyTransition(request));

/** An issue's conversation, oldest first (HIVE-71). */
export const readJiraComments = (
  request: JiraConversationRequest,
): Promise<JiraResult<JiraComment[]> | null> =>
  call('comments', (bridge) => bridge.jira.comments(request));

/** Remote and Jira-to-Jira links, merged, with their direction wording. */
export const readJiraLinks = (
  request: JiraConversationRequest,
): Promise<JiraResult<JiraLink[]> | null> =>
  call('links', (bridge) => bridge.jira.links(request));

/**
 * Post a comment, written as markdown (HIVE-71).
 *
 * The markdown goes to main and is converted there. That keeps the vendored
 * parser out of the browser bundle and puts the ADF validation on the side of
 * the boundary that can enforce it.
 */
export const addJiraComment = (
  request: AddJiraCommentRequest,
): Promise<JiraResult<JiraComment> | null> =>
  call('addComment', (bridge) => bridge.jira.addComment(request));

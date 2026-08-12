# HIVE-68 — Jira REST client and read verbs: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two IPC read verbs — search by JQL and read one issue — returning mapped, named fields, with the retry and paging behaviour the epic's error table specifies. No UI.

**Architecture:** Extends HIVE-67's `electron/main/integrations/jira/`. `client.ts` gains query parameters and one automatic retry; `mapping.ts` is new and pure; `index.ts` gains `search` and `issue`. The mapped type is `JiraIssue` in `electron/shared/jira-contract.ts`, not the renderer's `Ticket` — `electron/main/**` may not import `src/**`.

**Tech Stack:** Node ≥22 global `fetch`, `URLSearchParams`, `AbortSignal.timeout`, TypeScript strict, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-07-hive-68-jira-rest-client-design.md`

**Base:** stacked on `worktree-feat+hive-67-jira-settings-credential` (PR #52), which is not yet merged.

## Global Constraints

Inherited verbatim from HIVE-67's plan. Restated where this story can break them:

- `pnpm lint`, `pnpm type-check`, `pnpm verify:boundaries` must pass. No inline rule disables.
- `electron/main/**` may not import `src/**`. This is why `JiraIssue` lives in `electron/shared/`.
- `electron/shared/**` is types and constants only.
- **No real timers in tests.** The retry delay is injected; tests pass a recording no-op.
- **No raw Jira payload crosses IPC.** Only fields `mapping.ts` named.
- The endpoint is `/rest/api/3/search/jql`. `fields` is required. Paging is `nextPageToken`.
- `fields` is exactly `summary,status,issuetype,priority,updated,assignee`.
- The cap is 200 issues, 100 per page. `Retry-After` is honoured up to 5 seconds.
- The default JQL is `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`.
- Retries are for GETs only. HIVE-70's POST does not inherit them.

---

### Task 1: Contract and guards

**Files:**
- Modify: `app/electron/shared/jira-contract.ts` (add `JiraIssue`, `JiraSearchResult`, `JiraStatusCategory`, `JIRA_FIELDS`, `JIRA_DEFAULT_JQL`, `JIRA_MAX_ISSUES`, `JIRA_PAGE_SIZE`)
- Modify: `app/electron/shared/config-contract.ts` (add `JiraSearchRequest`, `JiraIssueRequest`)
- Modify: `app/electron/shared/guards.ts` (add `assertJiraIssueKey`, `parseJiraSearchRequest`, `parseJiraIssueRequest`)
- Test: `app/tests/electron/shared/guards.jira.test.ts` (extend)

**Interfaces produced:** the types above, plus `assertJiraIssueKey(value, label): string`, `parseJiraSearchRequest(input): JiraSearchRequest`, `parseJiraIssueRequest(input): JiraIssueRequest`.

- [ ] **Step 1: Extend the guard test**

Add to `tests/electron/shared/guards.jira.test.ts`:

```typescript
describe('parseJiraIssueRequest', () => {
  it('accepts a well-formed key', () => {
    expect(parseJiraIssueRequest({ key: 'HIVE-68' })).toEqual({ key: 'HIVE-68' });
  });

  it('accepts digits in the project part', () => {
    expect(parseJiraIssueRequest({ key: 'AB2C-1' })).toEqual({ key: 'AB2C-1' });
  });

  it('refuses lower case, which Jira keys never are', () => {
    refuses(() => parseJiraIssueRequest({ key: 'hive-68' }), /key/);
  });

  it('refuses a key that starts with a digit', () => {
    refuses(() => parseJiraIssueRequest({ key: '1AB-2' }), /key/);
  });

  it('refuses path separators, the whole point of the pattern', () => {
    refuses(() => parseJiraIssueRequest({ key: 'HIVE-68/../../admin' }), /key/);
    refuses(() => parseJiraIssueRequest({ key: '../HIVE-68' }), /key/);
  });

  it('refuses a query fragment', () => {
    refuses(() => parseJiraIssueRequest({ key: 'HIVE-68?expand=all' }), /key/);
  });

  it('refuses a missing number, and a missing project', () => {
    refuses(() => parseJiraIssueRequest({ key: 'HIVE-' }), /key/);
    refuses(() => parseJiraIssueRequest({ key: '-68' }), /key/);
  });

  it('refuses whitespace and an unknown sibling key', () => {
    refuses(() => parseJiraIssueRequest({ key: 'HIVE 68' }), /key/);
    refuses(() => parseJiraIssueRequest({ key: 'HIVE-68', jql: 'x' }), /unexpected key/);
  });
});

describe('parseJiraSearchRequest', () => {
  it('accepts an absent jql — the default query', () => {
    expect(parseJiraSearchRequest({})).toEqual({});
  });

  it('accepts a jql string', () => {
    expect(parseJiraSearchRequest({ jql: 'project = HIVE' })).toEqual({
      jql: 'project = HIVE',
    });
  });

  it('refuses control characters, which no JQL needs', () => {
    refuses(() => parseJiraSearchRequest({ jql: 'a\nb' }), /jql/);
  });

  it('refuses an over-long query and an unknown key', () => {
    refuses(() => parseJiraSearchRequest({ jql: 'x'.repeat(4097) }), /jql/);
    refuses(() => parseJiraSearchRequest({ key: 'HIVE-1' }), /unexpected key/);
  });
});
```

- [ ] **Step 2: Run it, expect failure** — `pnpm vitest run tests/electron/shared/guards.jira.test.ts`, FAIL on missing exports.

- [ ] **Step 3: Add the contract types** to `jira-contract.ts`:

```typescript
/** Jira's own three-bucket categorisation, normalised. */
export type JiraStatusCategory = 'todo' | 'in-progress' | 'done';

/**
 * One issue, as this app is willing to carry it across IPC.
 *
 * Not the renderer's `Ticket`: `electron/main/**` may not import `src/**`, and
 * `Ticket` carries `sessions`, which has no Jira counterpart. This is what Jira
 * said, named and narrowed; HIVE-69 converts it to what the app renders.
 */
export interface JiraIssue {
  key: string;
  summary: string;
  /** The status as Jira names it. Displayed verbatim. */
  status: string;
  statusCategory: JiraStatusCategory;
  issueType: string;
  /** `null` on a project with no priority scheme. */
  priority: string | null;
  /** Display name. `null` when unassigned. */
  assignee: string | null;
  /** ISO 8601, as Jira sent it. */
  updated: string;
  /** The browse URL. Built in main, because only main knows the site. */
  url: string;
}

export interface JiraSearchResult {
  issues: JiraIssue[];
  /**
   * True when the cap stopped paging while Jira still had more.
   *
   * A truncated backlog shown silently is a lie the user cannot detect. This is
   * what lets the panel say otherwise.
   */
  capped: boolean;
}

/**
 * The fields `/rest/api/3/search/jql` is asked for.
 *
 * Required — the endpoint returns no default field set, and omitting this gives
 * back a key and nothing else. Exactly what the ticket card renders, and nothing
 * more: every field here has to survive the "no raw payload crosses IPC" rule.
 */
export const JIRA_FIELDS = 'summary,status,issuetype,priority,updated,assignee';

/**
 * The query when the user has configured none.
 *
 * `currentUser()` is evaluated by Jira, so the app never needs the account id.
 */
export const JIRA_DEFAULT_JQL =
  'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

/** Jira Cloud's maximum for this endpoint. */
export const JIRA_PAGE_SIZE = 100;

/** The paging cap. Reaching it sets `capped`, it does not truncate silently. */
export const JIRA_MAX_ISSUES = 200;
```

And to `config-contract.ts`:

```typescript
/** Payload of `jira:search` (HIVE-68). Absent `jql` means the default query. */
export interface JiraSearchRequest {
  jql?: string;
}

/** Payload of `jira:issue` (HIVE-68). */
export interface JiraIssueRequest {
  key: string;
}
```

- [ ] **Step 4: Add the guards** to `guards.ts`:

```typescript
/**
 * A Jira issue key.
 *
 * The epic's replacement for "argv is a constant", applied: this value is
 * interpolated into a URL path, so the pattern is the whole defence. A key is
 * an uppercase project prefix, a hyphen, and digits — nothing in that shape can
 * carry a path segment, a query, or a fragment, which is why it is matched
 * rather than escaped.
 */
const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

export function assertJiraIssueKey(value: unknown, label: string): string {
  const key = assertString(value, label);
  if (!ISSUE_KEY.test(key)) {
    return fail(`${label}: expected an issue key like HIVE-68`);
  }
  return key;
}

/**
 * A JQL query (HIVE-68).
 *
 * Bounded and control-character-free, and that is deliberately all. JQL is not
 * parsed here and never will be: a client-side parser would be a thing to
 * maintain forever and would be wrong more often than Jira is. It goes into one
 * URL-encoded parameter with no larger query built around it, and it runs under
 * the user's own credential and permissions — so the failure mode is a query
 * broader than intended, not a query that reaches data the account cannot read.
 */
export function parseJiraSearchRequest(input: unknown): JiraSearchRequest {
  const raw = assertShape(input, [], 'jiraSearch', ['jql']);
  return {
    ...(raw.jql !== undefined
      ? { jql: assertText(raw.jql, 'jiraSearch.jql') }
      : {}),
  };
}

export function parseJiraIssueRequest(input: unknown): JiraIssueRequest {
  const raw = assertShape(input, ['key'], 'jiraIssue');
  return { key: assertJiraIssueKey(raw.key, 'jiraIssue.key') };
}
```

- [ ] **Step 5: Run, expect pass. Then `pnpm type-check && pnpm lint`.**

- [ ] **Step 6: Commit** — `feat(jira): the read-path contract and its guards (HIVE-68)`

---

### Task 2: `mapping.ts`

**Files:**
- Create: `app/electron/main/integrations/jira/mapping.ts`
- Test: `app/tests/electron/main/integrations/jira/mapping.test.ts`

**Interfaces produced:** `toIssue(raw: unknown, site: string): JiraIssue | null`, `toStatusCategory(key: unknown): JiraStatusCategory`.

- [ ] **Step 1: Write the test** covering, one `it` each: all three categories; the uncategorised `undefined` key mapping to `todo`; an unknown key mapping to `todo`; missing assignee → `null`; absent priority → `null`; a status name with unusual characters preserved verbatim; the browse URL built from the site; a malformed entry (no `fields`, no `key`, non-object) returning `null`; and a deep scan asserting no unrequested Jira field (`avatarUrls`, `self`, `expand`, `emailAddress`) survives mapping.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** Pure, no imports beyond the contract types. Returns `null` rather than throwing, so one malformed entry costs itself and a page of fifty still renders forty-nine.

- [ ] **Step 4: Run, expect pass. Commit** — `feat(jira): pure mapping from Jira JSON to named fields (HIVE-68)`

---

### Task 3: `client.ts` — query parameters and one retry

**Files:**
- Modify: `app/electron/main/integrations/jira/client.ts`
- Test: `app/tests/electron/main/integrations/jira/client.test.ts` (extend)

**Interfaces produced:** `get<T>(path, params?)`, `Sleep` seam, `JIRA_MAX_RETRY_DELAY_MS`.

- [ ] **Step 1: Extend the test** — query encoding through `URLSearchParams` (including a JQL with `&`, `=` and spaces); one automatic retry on 429 that honours `Retry-After`; the 5-second cap, past which it reports immediately with `retryAfter` set and does **not** sleep; one retry with backoff on 5xx; **no** retry on 401/403/404/400; a second failure after the retry reported rather than retried again; and the injected sleep asserted to have been asked for the right number of milliseconds without any real wait.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** `get(path, params?)` builds the URL with `URLSearchParams`. A `sleep` dependency defaults to a real `setTimeout` and is injected in tests. Retry once for 429 and 5xx only.

- [ ] **Step 4: Run, expect pass. Commit** — `feat(jira): query parameters and one automatic retry (HIVE-68)`

---

### Task 4: The two verbs, and paging

**Files:**
- Modify: `app/electron/main/integrations/jira/index.ts`
- Test: `app/tests/electron/main/integrations/jira/index.test.ts` (extend)

**Interfaces produced:** `Jira.search(request)`, `Jira.issue(request)`.

- [ ] **Step 1: Extend the test** — the default JQL is used when none is given; a supplied one replaces it wholesale rather than being appended to; paging follows `nextPageToken` until absent; paging stops at 200 and sets `capped`; `capped` stays false when Jira ran out first; the "not configured" refusals reuse HIVE-67's; a malformed entry inside a good page is skipped rather than failing the page; and the deep scan for unrequested Jira fields in the serialised result.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** Both verbs reuse the existing `connect()` preamble that resolves site, email and token or returns HIVE-67's refusal.

- [ ] **Step 4: Run, expect pass. Commit** — `feat(jira): search and read-issue verbs, with token paging (HIVE-68)`

---

### Task 5: Channels, bridge, and the renderer module

**Files:**
- Modify: `app/electron/shared/ipc-contract.ts` (`CH.jiraSearch`, `CH.jiraIssue`, two bridge verbs, `BRIDGE_JIRA_KEYS`)
- Modify: `app/electron/preload/index.ts`
- Modify: `app/electron/main/ipc/index.ts`
- Modify: `app/src/lib/jira.ts`
- Test: `app/tests/electron/preload/bridge.test.ts`, `app/tests/e2e/electron/security.spec.ts`, `app/tests/lib/jira.test.ts`

- [ ] **Step 1: Extend the surface tests first** — `BRIDGE_JIRA_KEYS` becomes six, and the security spec's exact-set assertion must be updated deliberately rather than discovered by a failure.

- [ ] **Step 2: Add the channels and bridge verbs**, with a contract comment recording what the widening grants: the renderer can now cause a *search* against the configured site under the user's credential, returning only mapped fields. Still no verb that returns a token.

- [ ] **Step 3: Register the handlers** with `parseJiraSearchRequest` / `parseJiraIssueRequest`.

- [ ] **Step 4: Add `searchJiraIssues` and `readJiraIssue`** to `src/lib/jira.ts`, through the existing never-throw `call` helper.

- [ ] **Step 5: Run everything** — `pnpm lint && pnpm type-check && pnpm verify:boundaries && pnpm test && pnpm test:e2e`.

- [ ] **Step 6: Commit** — `feat(jira): the two read channels and their bridge verbs (HIVE-68)`

---

## Self-review

**Acceptance coverage.** `searchJql`/`readIssue` returning a result union → Task 4. Every error-table row unit-tested against a fake fetch → Task 3 (HIVE-67 covered the non-retry rows; this adds 429 and 5xx). A malformed key rejected before any request, asserted by the fake fetch never being called → Task 1's guard plus a Task 4 assertion. `AbortSignal.timeout` and a size cap → already in HIVE-67's client, re-asserted. Paging to the cap and reporting it → Task 4. `mapping.ts` pure and covered against recorded payloads → Task 2. No raw response body crossing IPC → Task 2 and Task 4 deep scans. Lint/type-check/test/boundaries → every task's final step.

**Naming.** `toIssue`, `toStatusCategory`; `JiraIssue`, `JiraSearchResult`, `JiraStatusCategory`; `search`/`issue` on the main-side `Jira`, `searchJiraIssues`/`readJiraIssue` in the renderer — the renderer names are verbose on purpose, because `search` alone in `src/lib/` says nothing about what is being searched.

**Known deviation to state in the PR.** The ticket names the verbs `searchJql(query)` and `readIssue(key)`. They are `search(request)` and `issue(request)` here, taking an object like every other verb in the contract, so the channel payload has a shape a guard can check. Behaviour is as specified.

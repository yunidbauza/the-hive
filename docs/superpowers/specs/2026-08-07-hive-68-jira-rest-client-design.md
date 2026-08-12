# HIVE-68 — Jira REST client and IPC read verbs

Design, 2026-08-07. Second story of the HIVE-66 Jira epic. Builds on HIVE-67.

The read path, with no UI attached. Two verbs — search and read-one — plus the
mapping layer that turns Jira's JSON into something this app is willing to hand
across IPC. HIVE-69 is what puts the result on screen.

## What HIVE-67 already built, and what changes

HIVE-67 shipped `auth.ts` (complete), `client.ts` (one `get`, no retries), and
`index.ts` (four credential verbs). This story:

| Module | Change |
| --- | --- |
| `client.ts` | Query parameters, and the retry behaviour the epic's error table specifies for 429 and 5xx |
| `mapping.ts` | **New.** Pure. Jira JSON to `JiraIssue` |
| `index.ts` | Two more verbs: `search`, `issue` |
| `jira-contract.ts` | `JiraIssue`, `JiraSearchResult`, the two request types |
| `guards.ts` | `assertJiraIssueKey`, `parseJiraSearchRequest`, `parseJiraIssueRequest` |

## The mapped type lives in `electron/shared/`, not `src/types/`

`electron/main/**` may not import `src/**` — the fence is lint-enforced and
`verify:boundaries` proves it fires. So `mapping.ts` cannot produce the app's
`Ticket`, and should not try to:

```typescript
export interface JiraIssue {
  key: string;
  summary: string;
  /** The status as Jira names it. Displayed verbatim. */
  status: string;
  /** Jira's own three-bucket categorisation. Drives colour and grouping. */
  statusCategory: 'todo' | 'in-progress' | 'done';
  issueType: string;
  /** Absent on projects with no priority scheme. */
  priority: string | null;
  /** Display name. Absent when unassigned. */
  assignee: string | null;
  /** ISO 8601, as Jira sent it. */
  updated: string;
  /** The browse URL. Built in main, because only main knows the site. */
  url: string;
}
```

`JiraIssue` is **what Jira said, named and narrowed**. `Ticket` is **what the
app renders**, and it carries `sessions`, which has no Jira counterpart. HIVE-69
converts one to the other in the renderer. Collapsing them would either drag
`sessions` into a Jira type or drag Jira's vocabulary into the store.

`url` is assembled here rather than in the renderer for the same reason the host
is: the renderer does not know the site, and giving it the site so it can build a
link would hand it the one value the client refuses to take from a payload.

## The search endpoint

`GET /rest/api/3/search/jql` — not `/rest/api/3/search`, which was removed from
Jira Cloud. Verified: this session's own `jira-writer` uses it against
`behiques.atlassian.net` today.

Two consequences, both easy to get wrong:

**`fields` is required.** The endpoint returns no default field set — omit it and
every issue comes back with a key and nothing else. The app asks for exactly what
the ticket card renders:

```text
summary,status,issuetype,priority,updated,assignee
```

**Pagination is token-based.** `nextPageToken`, not `startAt`/`total`. There is no
total count, so there is no progress to report and no way to size the array up
front. The client pages until the token is absent or the cap is reached.

### The cap, and saying so

200 issues, 100 per page. When the cap stops paging before Jira ran out, the
result says so:

```typescript
export interface JiraSearchResult {
  issues: JiraIssue[];
  /** True when the cap stopped paging while Jira still had more. */
  capped: boolean;
}
```

A truncated backlog shown silently is a lie the user cannot detect — they would
simply believe they have 200 tickets. `capped` is what lets HIVE-69's panel say
otherwise. This is the epic's "no silent caps" rule, and it is why the flag is on
the result rather than logged in main where nobody sees it.

## Retries

The epic's error table asks for two behaviours HIVE-67 did not implement:

| Condition | Behaviour |
| --- | --- |
| 429 | Honour `Retry-After`. One automatic retry, then report. |
| 5xx | One retry with backoff, then report. |

**One retry, not a policy.** A read that is refreshed on pane open and on user
action does not need exponential backoff with jitter — the user's next click is
the retry loop. What one automatic retry buys is surviving the single transient
502 that would otherwise show an error for something already fixed.

**`Retry-After` is honoured only up to a cap of 5 seconds.** Jira can answer with
a much larger number, and blocking an IPC call for three minutes is worse than
reporting. Past the cap the client returns immediately with `retryAfter` set, so
the pane can say *when* rather than making the user wait inside a verb.

**The delay is injected**, like `fetch`. `CLAUDE.md` requires fake timers rather
than real waits, and a retry test that actually sleeps is a test that makes the
suite slower every time someone adds a case. The seam defaults to a real
`setTimeout` and every test passes a no-op that records what it was asked to wait.

Retries apply to `GET`s only, which is all this story has. HIVE-70 adds a POST,
and it does not get to inherit this — retrying a transition that may already have
applied is how an issue moves twice.

## Input handling

`gh.ts`'s "argv is a constant" cannot hold: a JQL string and an issue key come
from the renderer. HIVE-67 replaced it with three rules; this story is where two
of them finally have something to guard.

**Issue keys are validated against `/^[A-Z][A-Z0-9]*-\d+$/` in main before
reaching a URL.** Anything else is rejected rather than encoded and sent. The test
that matters asserts the injected `fetch` was **never called** — rejecting after
the request is not rejecting.

**JQL is never parsed or concatenated.** It goes into one `URLSearchParams` entry.
No larger query is built around it. The "JQL injection" failure mode is a query
broader than intended, and the mitigation is that the user typed it themselves and
it runs under their own credential and their own Jira permissions — a JQL string
cannot reach data the account cannot already read.

So `client.get` grows a `params` argument, and it is a `Record<string, string>`
fed to `URLSearchParams` rather than a string appended to a path. The difference
is the whole point: there is no syntax for a caller to escape from.

## Mapping, and what a malformed issue costs

`mapping.ts` is pure and takes no I/O, which is what lets it be tested against
recorded payloads rather than a server.

`toIssue(raw, site)` returns `JiraIssue | null`. **Null rather than throwing**: one
malformed entry costs itself and nothing else. A page of fifty issues where the
thirtieth has no `fields` should render forty-nine tickets, not an error — the
epic's rule that the pane must render either way applies inside the page too.

`statusCategory` comes from `fields.status.statusCategory.key`:

| Jira key | Mapped |
| --- | --- |
| `new` | `todo` |
| `indeterminate` | `in-progress` |
| `done` | `done` |
| anything else | `todo` |

The last row is a real case, not a defensive default: Jira's category id 1 is
literally named "No Category" with key `undefined`, and Jira itself paints that
lozenge grey — the same family as To Do's blue-grey. Mapping it to `todo` agrees
with what the user already sees in Jira, which is the only thing that makes a
category mapping defensible at all.

`priority` and `assignee` are `null` when absent. Both genuinely are: a project can
have no priority scheme, and an unassigned issue is the normal state of a backlog.

## The verbs

```typescript
search(request: { jql?: string }): Promise<JiraResult<JiraSearchResult>>;
issue(request: { key: string }): Promise<JiraResult<JiraIssue>>;
```

`jql` is optional. Absent means the epic's default:

```text
assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC
```

`currentUser()` is evaluated by Jira, so the app never needs the account id to run
it. HIVE-69 adds the config override that fills this in; keeping the parameter
optional now means that story wires a value rather than changing a signature.

Both verbs reuse HIVE-67's "not configured yet" refusals — no site, no email, no
credential — so the pane gets the same sentence whichever verb it called.

## No raw payload crosses IPC

Asserted, not assumed. `search` returns `JiraIssue[]`, every field of which
`mapping.ts` named. The test deep-scans the serialised result for fields Jira sent
that the app did not ask for — `avatarUrls`, `self`, `expand`, `emailAddress` — and
fails if any survives. That is the epic's strongest carried-over rule from
`gh.ts`, and the one a future "just pass the raw issue through, we might need it"
would quietly break.

## Testing

| Layer | How |
| --- | --- |
| `mapping.ts` | Recorded payloads. Every status category, the uncategorised one, missing assignee, absent priority, a status name with unusual characters, a malformed entry |
| `client.ts` | Injected `fetch`. Query encoding, one case per error row, both retry paths, the `Retry-After` cap, the size cap |
| Paging | A fake `fetch` that hands out `nextPageToken`s: stops on absence, stops at the cap, sets `capped` only when it stopped early |
| Guards | A malformed key is refused **before** any request — asserted by the fake `fetch` never being called |
| IPC | The two new channels round-trip, and the bridge surface still matches its declared key set |

The 80% gate covers only `src/**` (`vitest.config.ts:34`), so none of this is
gate-enforced. It is required by this design regardless.

## Out of scope

The WORK tab (HIVE-69), transitions (HIVE-70), comments (HIVE-71), the JQL
override field and its "Test query" button (HIVE-69). Nothing in `src/` changes in
this story — it is deliverable and fully testable with no UI attached, which is
what makes it a separate story at all.

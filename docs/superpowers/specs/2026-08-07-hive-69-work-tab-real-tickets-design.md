# HIVE-69 — WORK tab: real tickets, fixtures retired on desktop

Design, 2026-08-07. Third story of the HIVE-66 Jira epic. **This is the story
that closes the epic's stated goal.**

HIVE-68 shipped the verbs. This wires them to the panel, widens the `Ticket`
type so real Jira statuses survive the trip, and adds the JQL override.

## The type widening, and the file that actually changes

`Ticket.status` is a closed union of four literals today. That is a fixture
artifact: real Jira statuses are per-workflow and arbitrary, so mapping them onto
four literals means either dropping information or lying about it.

```typescript
export interface Ticket {
  key: string;
  /** The status as Jira names it. Displayed verbatim. */
  status: string;
  /** Jira's own three-bucket categorisation. Drives colour and grouping. */
  statusCategory: JiraStatusCategory;
  title: string;
  sessions: string[];
  /** Absent for fixtures; present for real issues. */
  url?: string;
}
```

`work-panel.tsx` genuinely does not change for this — it is a twenty-line map
over `useTickets()`. The file that does is `ticket-card.tsx:8-13`:

```typescript
const STATUS_TEXT: Record<Ticket['status'], string> = { 'To Do': …, … };
```

A `Record` keyed on the literal union stops compiling the moment `status` widens.
It is rekeyed on `statusCategory`, which is exactly the change the widening
exists to enable: **the app shows Jira's own status name and styles by Jira's own
category, and no mapping table has to be maintained as workflows change.**

`statusCategory` is reused from `electron/shared/jira-contract.ts` rather than
redeclared. It is a type-only import through `@shared`, which the renderer is
allowed and which keeps one definition of the three buckets.

## Where tickets come from, and what the store knows

The store gains one field beside `tickets`:

```typescript
export type TicketSource =
  /** The browser demo. Fixtures are its data, not a fallback. */
  | { kind: 'fixtures' }
  /** Desktop, nothing configured. The panel explains rather than sits empty. */
  | { kind: 'unconfigured' }
  /** Desktop, at least one successful read. */
  | { kind: 'live'; stale: boolean; capped: boolean }
  /** Desktop, the first read failed. There is nothing to keep. */
  | { kind: 'failed'; message: string };
```

Three actions, each narrow and id-free, following `setSessionStatus`'s shape:

- `hydrateTickets(issues, capped)` — replaces `tickets`, source becomes `live`
  with `stale: false`.
- `reportTicketFailure(message)` — **staleness over emptiness.** If the source is
  already `live`, the tickets stay exactly as they are and only `stale` flips.
  Otherwise there is nothing to keep and the source becomes `failed`. Replacing a
  populated panel with an error is the wrong trade for a tool the user leaves
  open on a second monitor.
- `reportTicketsUnconfigured()` — desktop with no credential.

`refreshTickets()` is the async orchestrator and lives on the store beside them,
following `sendToEntity` (`hive-store.ts:331`), which already gates on
`isDesktop()` and calls into `lib/`. It reads the status, decides which of the
three actions applies, and returns. It never throws: `lib/jira.ts` answers `null`
rather than rejecting, and `null` is a failure this maps to a message.

### Converting a `JiraIssue` into a `Ticket`

`sessions` is `[]` for a real issue. Linking a Hive session to a ticket is the
app's own concern and has no Jira counterpart — the ticket says so, and this
story does not invent one. A real ticket card therefore renders its key, status
and title, and no session or PR rows, which is correct rather than empty: there
is nothing yet that knows a session is working `HIVE-69`.

`title` comes from `summary`, and `url` from the mapped issue, so a card can link
out to Jira without the renderer ever learning the site.

## The browser target keeps its fixtures

`pnpm dev` has no Electron and no main process, so `isDesktop()` is false and
`createInitialState()`'s tickets are the browser target's data — gated the way
`hive-store.ts:331` already gates `sendToEntity`, which is the real precedent
(`message-input.tsx` only switches placeholder copy).

This is a constraint, not a nicety. `hive-store.ts:196` spreads
`createInitialState()` unconditionally, and three unit suites hard-assert fixture
ticket data. The eight fixtures each gain one line — `statusCategory` — and
nothing else.

**Correction carried from the reconciliation:** the ticket claims deleting the
fixtures would break `pnpm test:e2e:web`. It would not — no e2e spec touches the
WORK panel at all. So this story *adds* that coverage rather than relying on it:
a new web spec asserts the panel renders fixture tickets in the browser target.

## The query, and its override

Default, when nothing is configured — HIVE-68 already holds it as
`JIRA_DEFAULT_JQL`:

```text
assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC
```

The config's `jira` block gains an optional `jql`. When non-empty it **replaces
the default wholesale**, never appends: a user who writes JQL expects their query
to be the query. HIVE-68 already made `search`'s `jql` optional for exactly this,
so this story wires a value rather than changing a signature — and HIVE-68's
config test already asserts that a hand-written `jql` survives a `setJira` write.

**Validated by running it.** A "Test query" button calls `search` with the
override and reports the match count, or Jira's own parse error verbatim. A
client-side JQL parser would be a thing to maintain forever and would be wrong
more often than Jira is.

The field lives in a third settings group, "Ticket query", beside "Jira site" and
"API token". It is not connection and it is not the credential; folding it into
either would put a thing you tune next to a thing you set once.

## Refresh, and when

**On pane open.** `WorkPanel` unmounts when another left-rail tab is selected
(`left-rail.tsx:31`), so mounting *is* the pane opening — no extra plumbing, and
the refresh is exactly as frequent as the user looking at it.

**On explicit user action.** A refresh control on the panel header, which is also
what the stale state offers as its fix.

**No polling.** `integrations-section.tsx:156-167` writes down the reasoning at
length for its `gh` status and it holds here: nothing outside the app changes
these tickets on a timescale that justifies a background request the user did not
ask for, and a request per interval is a request per interval forever.

## What the panel renders in each state

| Source | Panel |
| --- | --- |
| `fixtures` | The eight fixture tickets. No notice — this is the demo, not a degraded mode. |
| `unconfigured` | A short line naming Settings → Integrations. Not an empty list. |
| `live`, not stale | The tickets. A "showing the first 200" line when `capped`. |
| `live`, stale | The same tickets, plus a line saying they may be out of date and a retry. |
| `failed` | The message from main, plus a retry. Only ever reached with no tickets to keep. |

## Testing

| Layer | How |
| --- | --- |
| Store | `hydrateTickets` against a fresh store; `reportTicketFailure` keeping tickets and flipping `stale`; the same action with no tickets producing `failed`; `refreshTickets` gated off in the browser target |
| `ticket-card.tsx` | Colour derives from `statusCategory`; a status Jira invented renders verbatim rather than falling back |
| `work-panel.tsx` | One case per `TicketSource` |
| Settings | The JQL field commits; "Test query" reports a count and reports a parse error |
| Fixtures | The existing three suites, updated for the widened type |
| Playwright (web) | **New.** The browser target renders fixture tickets — the coverage the ticket assumed already existed |

## Out of scope

Transitions (HIVE-70), comments (HIVE-71), and linking a Hive session to a Jira
ticket, which no story in this epic owns and which is the app's own concern.

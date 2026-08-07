# HIVE-70 — Jira transitions from the ticket card

Design, 2026-08-07. Fourth story of the HIVE-66 Jira epic. Additive — the epic's
stated goal is met by HIVE-67 to HIVE-69. This is what makes the panel a place to
work rather than only to look.

## Why this is not a status field write

Jira does not let you set a status. You fetch the transitions available **from
the issue's current status in its workflow**, then apply one by id. Transition
ids are per-workflow and not stable across projects, so they are read per issue
and never cached across issues or hard-coded.

That constraint drives the whole shape: the card cannot know what it can offer
until it asks, so the menu fetches on open rather than on render.

## Two verbs

```typescript
transitions(request: { key: string }): Promise<JiraResult<JiraTransition[]>>;
applyTransition(
  request: { key: string; transitionId: string },
): Promise<JiraResult<JiraIssue>>;
```

```typescript
export interface JiraTransition {
  id: string;
  /** The button's label, as Jira names it — "Start progress", "Done". */
  name: string;
  /** Where it lands. Lets the menu show the destination, not just the verb. */
  to: { name: string; statusCategory: JiraStatusCategory };
}
```

`applyTransition` **returns the re-read issue**, not `void`. The acceptance
criterion is that the card shows the new status rather than an optimistic guess,
and the cheapest way to make that impossible to get wrong is for the verb to have
nothing else to return. A caller that wanted to guess would have to ignore a
value it was handed.

## `client.ts` gets a POST, and it does not inherit the retry

HIVE-68's client retries 429 and 5xx once. **`post` does not.** Retrying a
transition that may already have applied is how an issue moves twice, and a
duplicated workflow transition can fire automation — a Slack message, a deploy —
that cannot be taken back. HIVE-68's header already wrote this down as a rule for
whoever added the first POST; this is that story, and the rule holds.

A 429 on a POST is therefore reported with its `retryAfter` and the user decides.

## Telling a stale id from a missing field

Both are `400`. The epic asks for different words for each, and string-matching
Jira's prose would break on the first non-English instance.

So the distinction is made **by asking again**: on any 400 from the POST, re-read
the transitions. If the id that was sent is no longer among them, the issue moved
underneath us. If it is still there, the request itself was rejected — a required
field.

That is deterministic, locale-independent, and costs one extra GET on a path that
has already failed.

A new `stale` kind joins `JiraErrorKind` for the first case. The epic's error
table is about HTTP conditions and has no row for this, but HIVE-70 names the
condition explicitly and it needs to read differently in the UI from a validation
failure.

## Surfacing Jira's message without quoting a raw body

The acceptance criterion — "a transition requiring a field surfaces Jira's own
message naming the field" — sits directly against the epic's strongest rule, that
no raw response body escapes.

They are reconcilable, because Jira's error body is **structured**:

```json
{ "errorMessages": ["..."], "errors": { "resolution": "Field required" } }
```

So the client parses it into named fields rather than quoting it: at most ten
messages, each capped at 300 characters with control characters stripped, taken
from exactly `errorMessages` and the values of `errors`. Nothing else in the body
is read. That is the same discipline `mapping.ts` applies to an issue — named
fields, bounded, nothing raw — rather than an exception to it.

`JiraError` gains an optional `details?: string[]`. Optional, and populated only
where a 400 body parsed. The deep-scan test extends to cover it.

## The card control

A `DropdownMenu`, following `project-row-menu.tsx` — the only existing consumer
of that primitive, whose header records that shadcn's default classes are inert
here because this app's colour comes from `--cc-*`. Every surface, border and
text colour is supplied explicitly for the same reason.

The menu:

- Is present only on a **real** ticket. A fixture has no Jira behind it, and a
  transition control on the browser demo would be a button that cannot work —
  `integrations-section.tsx:30-35`'s rule: absent rather than disabled.
- **Fetches on open, per issue.** Not on render, because that would be one
  request per card on every panel open; and not cached across issues, because
  transition ids are per-workflow.
- Shows `name`, with the destination status beside it.
- On success, replaces that one ticket in the store with the re-read issue.

### Failure, in the menu

| Condition | What the card says |
| --- | --- |
| `stale` | "This issue has moved. Its transitions were re-read." — and the menu shows the fresh list |
| `bad-query` with `details` | Jira's own messages, verbatim from the named fields |
| `forbidden` | "You do not have permission to make this change." |
| anything else | The error's message |

## The store gains one action

`updateTicket(issue)` replaces a single ticket by key, leaving the rest and the
source alone. `hydrateTickets` replaces everything, which is right for a refresh
and wrong for a transition — re-reading the whole query after moving one issue
would reorder the panel under the user's cursor.

If the key is not in the list the action is a no-op rather than an append: a
transition can only be applied to a ticket that is on screen, so an unknown key
means the list changed underneath and the next refresh is the right fix.

## Testing

| Layer | How |
| --- | --- |
| `client.post` | Body, headers, **no retry** on 429 or 5xx, the 400 detail parser and its bounds |
| `transitions` | Mapped to named fields; a malformed entry skipped |
| `applyTransition` | Success re-reads and returns the issue; 400 with the id still present is a field error carrying Jira's messages; 400 with the id gone is `stale`; 403 is `forbidden` |
| Guards | A non-numeric transition id is refused before any request |
| Store | `updateTicket` replaces one and leaves the rest; unknown key is a no-op |
| Card | The menu is absent for a fixture; fetches on open; applies; renders each failure |

## Out of scope

Comments and links (HIVE-71). Transitions that open a Jira screen with required
fields are **reported, not filled** — guessing a resolution on the user's behalf
is exactly what the ticket says not to do.

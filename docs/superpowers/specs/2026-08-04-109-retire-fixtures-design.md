# 109 — Retire fixtures where real data exists — design

| | |
|---|---|
| **Ticket** | unassigned |
| **Epic** | [100 — Settings](../../../stories/100-settings-epic.md) (HIVE-51) |
| **Depends on** | 101 (HIVE-52) — config is the project source; 048 (HIVE-48) — real PTY sessions |
| **Points** | 3 |
| **Location** | `app/src/data/`, `app/src/stores/`, `app/tests/` |

The workspace now maps four real repositories and spawns real sessions in them.
The demo dataset that made the command center legible before any of that
existed now sits alongside the real thing, and a panel showing both cannot be
used to judge whether a feature works.

The goal is to stop showing invented data **where real data exists**, without
blanking panels whose data source has not been built.

## What already exists (reconciled against the code, not the ticket)

- **`createInitialState()` (`fixtures.ts:300`) seeds eight things**: `entities`
  (10 sessions + 3 agents), `order`, `agentOrder`, 5 `projects`, `tickets`,
  `prs`, `notifs`, `feed`, `orchLines`.
- **Projects are already real.** `useProjects` (`hive-store.ts:724`) prefers the
  config snapshot; fixture projects survive only when they still own a session
  (`hive-store.ts:753`, `projectsOwningSessions` at `:646`). With four
  configured projects the fixture five are already invisible.
- **`ProjectRow.source` already distinguishes them.** `'demo'` and `'config'`
  exist today (`hive-store.ts:737` and `:747`). The vocabulary for "this is not
  real" is in the type system already; nothing new needs inventing.
- **Removing fixture sessions removes fixture projects for free.** The merge
  keeps a fixture project only if `owning.includes(fixture.id)`. Empty
  `entities`/`order` makes `projectsOwningSessions` return `[]`, so no fixture
  project can pass. The two are one change, not two.
- **Agents are decorative.** `agents-panel.tsx:7` states it: "Agents are
  fixture-defined in this phase: there is no create or pause here". `Agent`
  (`entity.ts:27`) has `status: 'online'` — a literal type with one member. No
  spawn path, no exit, no error state.
- **A browser demo path exists.** `hive-store.ts:741` returns fixtures wholesale
  when there is no snapshot, and `isDesktop` (`@config/runtime`) is imported at
  `hive-store.ts:24`. In a browser build there is no config and no PTY, so
  fixtures are the entire application.
- **An import zone binds the module** (story 014): nothing outside `src/stores/`
  may import it. Enforced by lint, not review.

## Decisions

### 1. Split the dataset by whether a real source exists

| Data | Real source today | Disposition |
|---|---|---|
| `projects` | `config:get` | **Retire** |
| `entities` (sessions), `order` | `pty:*`, `session:status` | **Retire** |
| `entities` (agents), `agentOrder` | none — no agent runtime | Keep, marked demo |
| `tickets` | none — no `jira:*` channel | Keep, marked demo |
| `prs` | none — no PR channel | Keep, marked demo |
| `feed`, `notifs`, `orchLines` | derived from the above | Keep, marked demo |

Agents are in the keep column despite looking like sessions. Nothing in the app
can create one, so retiring them empties the panel permanently and removes the
only way to see that the agent terminal view works at all. Retiring data whose
producer does not exist is not cleanup; it is deleting a feature.

### 2. The module is renamed, not emptied

`src/data/fixtures.ts` becomes `src/data/demo-data.ts`, keeping only the
sections in the keep column. The name change is the point: "fixtures" reads as
test scaffolding that someone forgot to remove, which is what made this ticket
necessary. "Demo data" says what it is and why it is still there.

Story 014's import zone follows the rename. `icon.tsx:36` and
`entity.ts:45-52`, which both reference the old filename in prose, are updated
in the same change — a comment pointing at a file that no longer exists is a
worse defect than the one being fixed.

### 3. Desktop starts empty; the browser demo does not

The seed becomes conditional on the runtime, not deleted:

```
isDesktop  →  entities: {}, order: [], projects: []   + demo agents/tickets/prs/feed
browser    →  the full demo dataset, unchanged
```

The browser build has no config file and no pty-host. Emptying it would leave a
blank page and destroy the concept demo the dataset was ported from, for no
gain — there is nothing real in a browser for it to be confused with. On the
desktop the opposite is true, and that is where the ambiguity being removed
actually lives.

### 4. Demo rows stay visibly demo

Panels rendering kept data carry the same `demo` marking `ProjectRow` already
uses, so a ticket or PR on screen is never mistaken for something fetched. This
reuses an established affordance rather than inventing a second one.

## Why the kept data stays demo

Recorded so this is not re-litigated when the panels are next touched.

**PRs should be native, not agent-driven.** `gh pr list --json` is
deterministic, and `integrations/gh.ts:65` already shells out to `gh` through
`execFile` with `shell: false` and already detects auth. Real PR data is a
modest addition on a proven path. Putting a model in front of a CLI call that
already returns structured JSON costs tokens per refresh and adds
non-determinism for no benefit.

**Jira splits by read versus write.** A panel wants data that is cheap, exact
and pollable; an LLM call per refresh is none of those, and UI data must be
exact — a paraphrase of `"In Progress"` silently breaks status grouping. Reads
belong in a native client. Writes and reasoning ("create a ticket from this
session", "what is blocking GRAC-3018") are genuinely agentic and should reuse
the existing `jira-writer` skill rather than reimplementing it.

**Both are gated on an agent runtime that does not exist.** A `jira-agent` is
not an addition to `pr-reviewer` and `slack-agent`, because those do nothing —
`Agent.status` cannot express anything but `'online'`. Giving `Agent` a real
lifecycle is its own epic and a prerequisite, not a detail.

## Error handling

No new failure modes. The change removes a data source; it does not add one.
The one risk is a panel that assumed non-empty seed data and renders badly at
zero rows, which the testing below targets directly.

## Testing

- **Unit** — `createInitialState()` under desktop returns no entities, no order,
  no projects, and still returns the kept sections; under browser it returns the
  full dataset. `fixtures.test.ts` is renamed and rewritten against both.
- **Unit** — `useProjects` with a snapshot and empty entities returns exactly
  the configured rows, no demo rows.
- **Component** — every panel that read a retired section renders at zero rows
  without throwing: work panel, orchestrator table, left rail, session list.
- **E2E** — a desktop launch against a seeded config shows only configured
  projects and no sessions until one is spawned.
- `app/tests/e2e/electron/fixtures/` is Playwright's own fixtures directory and
  is untouched by this story. The name collision is worth stating once so a
  future sweep does not delete it.

## Out of scope

Building the missing sources. No `jira:*` channel, no PR channel, no agent
runtime. Those are named above so the direction is on record, and are separate
epics.

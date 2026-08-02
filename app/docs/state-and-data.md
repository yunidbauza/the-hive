# State and data

**Scope:** store shape, actions, selector hooks, and the fixture dataset.

**Owned by story 012** (`../../stories/012-mock-data-layer.md`).

## Stores

Two, split along what the user is *looking at* versus what the system *knows*.
The split keeps a keystroke in the picker from re-rendering thirteen live
terminals.

- `src/stores/hive-store.ts` — domain state and the actions that mimic the future
  orchestrator daemon: `spawnSession`, `sendToEntity`, `runOrchCommand`,
  `markAllRead`, `markRead`, `pushFeed`, `appendEntityLines`.
- `src/stores/ui-store.ts` — view state: theme, `activeTab`, `selIdx`, `leftTab`,
  `railTab`, `collapsed`, picker fields, `showActivityRail`.

Cross-store effects call the other store's action explicitly. No store subscribes
to another, so the dependency stays one-way and the effect is visible at the call
site.

## Selector hooks

Components never read a store object directly and never call `getState()`.

| Hook | Returns |
| --- | --- |
| `useEntity(id)` | one entity, or `undefined` |
| `useCounts()` | `{ working, waiting, idle, done }` |
| `useNavOrder()` | active session ids, then done ones |
| `useProjectSessions(projectId)` | a project's non-done sessions |
| `useTicketPrs(ticketKey)` | PRs reachable from a ticket's sessions |
| `useUnreadCount()` | inbox unread count |
| `useActiveEntity()` | the entity behind `activeTab`, or `null` |

Derived values are computed in selectors and **never stored** — one source of
truth for every number on screen.

## Fixtures

`src/data/fixtures.ts` ports the concept's dataset verbatim: 10 sessions, 3
agents, 5 projects, 8 tickets, 4 PRs, 5 notifications, 7 feed items, and the
orchestrator boot banner. Change values here only alongside `../../concept/`.

`createInitialState()` is a factory, not a frozen object, so every test starts
from a clean copy and one test's mutation cannot leak into the next.

**Fixtures are store-only consumers.** Nothing that renders may import them —
enforced by an import zone, not by review.

## Deferred

`runOrchCommand` currently handles `help`, `send`, and the error paths. Story 041
owns the full console grammar.

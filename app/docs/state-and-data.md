# State and data

**Scope:** store shape, actions, selector hooks, and the fixture dataset.

**Owned by story 012** (`../../stories/012-mock-data-layer.md`).

## Stores

Two, split along what the user is *looking at* versus what the system *knows*.
The split keeps a keystroke in the picker from re-rendering thirteen live
terminals.

- `src/stores/hive-store.ts` — domain state and the actions that mimic the future
  orchestrator daemon: `spawnSession`, `sendToEntity`, `runOrchCommand`,
  `markAllRead`, `markRead`, `pushNotif`, `pushFeed`, `appendEntityLines`.
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
| `useNotifs()` | the inbox, newest first (051) |
| `usePrs()` | every open PR the fleet produced (052) |
| `useFeed()` | the orchestrator's activity feed, newest first (053) |
| `useMarkRead()` | mark one notification read, by index |
| `usePushNotif()` | push a notification — the simulation's entry point |
| `useActiveEntity()` | the entity behind `activeTab`, or `null` |

Derived values are computed in selectors and **never stored** — one source of
truth for every number on screen.

## Caps

Two collections are bounded, because a long-running demo must not grow without
end:

- **`feed` at 24** (`FEED_CAP`) — `pushFeed` prepends and drops the oldest.
- **`notifs` at 8** (`NOTIF_CAP`) — `pushNotif` does the same. Eight is what fits
  the rail without scrolling on a laptop, and an inbox that grows forever stops
  being an inbox.

Panels render whatever they are handed; neither adds a second cap, because a
second place to get the number right is a second place to get it wrong.

## The fake clock

`src/lib/fake-clock.ts` — story 053.

Feed items are stamped by `stamp()`, which starts at **14:38** and advances one
minute per call. Two reasons it is not `new Date()`: a demo recorded at 03:11
should not say so (the seeded feed ends at 14:37, and the story continues from
14:38), and a wall clock makes the store's own tests unassertable.

- **It lives in `lib/`, not `features/activity-feed/`** as story 053 first
  suggested. `stores/` is what stamps items on spawn and send, and the import
  zone forbids `stores/ → features/`. `lib/` is leaf-level, which is what a
  clock should be.
- **`reset()` exists for test isolation** and is called by the hive-store's own
  `reset()`. Without it, the first test to push a feed item leaks its minutes
  into every test after it — which is why story 053 requires a module with an
  explicit reset rather than a module-level counter.
- `peek()` reads the current time without advancing it.

## Fixtures

`src/data/fixtures.ts` ports the concept's dataset verbatim: 10 sessions, 3
agents, 5 projects, 8 tickets, 4 PRs, 5 notifications, 7 feed items, and the
orchestrator boot banner. Change values here only alongside `../../concept/`.

`createInitialState()` is a factory, not a frozen object, so every test starts
from a clean copy and one test's mutation cannot leak into the next.

**Fixtures are store-only consumers.** Nothing that renders may import them —
enforced by an import zone, not by review.

## The console grammar

`runOrchCommand` takes an **already-parsed** `ParsedCommand`, not a string. The
parser is pure and lives in `features/orchestrator/utils/parse-command.ts`;
`stores/` may not import `features/`, so the shared type sits in
`types/command.ts`.

The split is worth keeping for its own sake: the parser catches *shape* errors
(`send` with no message, an unknown verb) and the store catches *existence*
errors (no such session, unknown repo). Neither needs the other to be tested.

All six commands are implemented — `help`, `status`, `open`, `send`, `spawn`,
`clear` — with `usage` and `command not found` for everything else. The
transcript is capped at 200 lines, oldest dropped first, because it is replayed
into an xterm on every subscribe.

`useActiveSessions()` / `useDoneSessions()` are two flat selectors rather than
one returning `{ active, done }`: `useShallow` compares the returned value's own
properties, so an object of two freshly-built arrays never compares equal and the
component re-renders forever.

# State and data

**Scope:** store shape, actions, selector hooks, and the fixture dataset.

**Owned by story 012** (HIVE, Jira).

## Stores

Two, split along what the user is *looking at* versus what the system *knows*.
The split keeps a keystroke in the picker from re-rendering thirteen live
terminals.

- `src/stores/hive-store.ts` — domain state and the actions that mimic the future
  orchestrator daemon: `spawnSession`, `sendToEntity`, `runOrchCommand`,
  `markAllRead`, `markRead`, `pushNotif`, `pushFeed`, `appendEntityLines`.
- `src/stores/ui-store.ts` — view state: `activeTab`, `selIdx`, `leftTab`,
  `railTab`, `collapsed`, picker fields, `showActivityRail`.
- `src/stores/appearance-store.ts` — durable preferences: `theme`,
  `terminalFont`, `terminalFontSize`, `terminalScrollback`, `density`.

## What persists, and where (story 105)

The line between `ui-store` and `appearance-store` is persistence, and it is
structural rather than a matter of taste:

- **Nothing in `ui-store` is persisted.** Restoring `picker` or `activeTab`
  across a launch would reopen an overlay the user had closed.
- **Everything in `appearance-store` is persisted**, to `localStorage` through
  zustand's `persist`, whitelisted by `partialize`. Making the boundary the
  store rather than a field list is the point: otherwise every new `ui-store`
  field becomes a question somebody has to remember to answer, and answering it
  wrong is silent.

`systemDark` is the one exception inside `appearance-store` — it is an
observation of the OS, not a preference, so it is excluded from `partialize`.
Restoring it would mean trusting a stale answer on a machine whose theme has
since changed. `resolvedTheme` is likewise derived in a selector and never
stored, per the one-source-of-truth rule below.

**Why `localStorage` and not `~/.hive/config.json`.** That file is main's and
describes the *workspace* — project paths, shell, agent command — facts a
session needs before it can run. Appearance is a fact about the person looking
at the screen, wanted by the renderer before its first paint. Reading it over
the async bridge would paint dark and then flip on every launch, and the browser
target (`pnpm dev`) has no bridge at all, so that route would need this fallback
anyway rather than replacing it. The cost, stated plainly: appearance does not
follow the user to another machine and cannot be hand-edited.

Terminal settings reach the terminal **by prop, not by store**:
`components/terminal/**` may not import `stores/**`, so `center-stage.tsx` (the
composition root) reads the store and passes `fontFamily`/`fontSize`/`scrollback`
down, exactly as it already did for `theme`.

Cross-store effects call the other store's action explicitly. No store subscribes
to another, so the dependency stays one-way and the effect is visible at the call
site.

## Selector hooks

Components never read a store object directly and never call `getState()`.

| Hook | Returns |
| --- | --- |
| `useEntity(id)` | one entity, or `undefined` |
| `useCounts()` | `{ working, waiting, idle, done, terminated }` |
| `useNavOrder()` | active session ids, then ended ones |
| `useActiveSessions()` / `useEndedSessions()` | the two sides of the table's divider |
| `useProjectSessions(projectId)` | a project's sessions that have not ended |
| `useOpenEntity()` | open an entity's tab, refusing a `terminated` one (108) |
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

## What the store seeds, and what it no longer does

**The app boots with an empty fleet.** Six slices that used to arrive
pre-populated now start empty in both targets, because each has a real producer:

| Slice | Comes from |
| --- | --- |
| `entities`, `order`, `agentOrder` | sessions the user starts (PTYs) |
| `projects` | the config file, read through `useProjects()` |
| `tickets` | Jira, via `refreshTickets()` |
| `orchLines` | what the orchestrator actually does |

`src/data/fixtures.ts` used to hold the concept's whole dataset — 10 sessions, 3
agents, 5 projects, 8 tickets and the orchestrator boot banner — and the store
loaded it at launch. That is what made the header count a fleet that was not
running, the projects tree list repositories nobody had mapped, and the WORK tab
paint eight sample tickets for a frame before the real Jira read replaced them.

What remains in `fixtures.ts` is `prs`, `notifs` and `feed`: the three slices
with no live producer yet. They are **knowingly stale** — their `session` and
`target` fields name sessions that no longer exist — and each dies the day
something real feeds it.

`createInitialState()` is a factory, not a frozen object, so every test starts
from a clean copy and one test's mutation cannot leak into the next.

**Fixtures are store-only consumers.** Nothing that renders may import them —
enforced by an import zone, not by review.

### The sample fleet lives in `tests/`

`tests/support/demo-fleet.ts` holds the dataset that was removed, for the tests
that need entities to assert against. Call `seedDemoFleet()` after `reset()`;
`seedDemoProjectConfig()` declares the same projects in the config, which is what
`useProjects()` reads. An import zone stops `src/` and `electron/` reaching it.

### Tickets have one source, and a state before it answers (HIVE-69)

Every ticket is a real Jira issue. `ticketSource` says where the read has got to:

```typescript
type TicketSource =
  | { kind: 'loading' }                               // boot, and every refresh
  | { kind: 'unconfigured' }                          // no credential — or a browser
  | { kind: 'live'; stale: boolean; capped: boolean }
  | { kind: 'failed'; message: string };
```

`loading` replaced a `fixtures` variant that meant "these eight are samples",
which is precisely what made real issues arrive *behind* fake ones. The panel
renders a skeleton for it — see `ticket-card-skeleton.tsx`.

Two subtleties in `refreshTickets()`:

- **It only enters `loading` when the list is empty.** A refresh over tickets
  already on screen keeps them there; blanking a good list to a placeholder for
  the length of a round trip is the original bug wearing the opposite mask.
- **The browser reports `unconfigured` rather than returning early.** A browser
  has no bridge and therefore no Jira, which is an answer. An early return would
  now strand the panel on `loading` forever.

Two properties worth not breaking:

- **Staleness over emptiness.** `reportTicketFailure` keeps the tickets it has
  and only flips `stale`. It becomes `failed` only when there is nothing to keep.
  Replacing a populated panel with an error is the wrong trade for a tool the
  user leaves open on a second monitor.
- **`capped` is not a truncation.** Reaching the 200-issue limit sets the flag so
  the panel can say so. A backlog silently cut to 200 is the one failure a read
  path can have that the user cannot detect for themselves.

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

### Where a message actually goes

`sendToEntity` is the one branch point in the coordination layer (story 097). On
desktop, for a real session, it calls `sendToSession` and returns
`{ kind: 'routed' }` — a feed item, **no transcript echo** and **no
acknowledgement timer**, because status now comes from the process itself
(story 096) rather than from a timer narrating one.

Everything else keeps the prototype's round-trip: the browser target, which has
no bridge to ask, and agents, which have no project and no pty this epic. That
is why the timer still exists. It is covered by `tests/stores/` rather than by a
browser spec — `waiting-session.spec.ts` asserted the acknowledgement directly,
and was removed along with the seeded fleet it drove.

The action returns a `SendOutcome` rather than a bare timer handle:

```ts
type SendOutcome =
  | { kind: 'routed' }
  | { kind: 'refused'; reason: string }
  | { kind: 'demo'; timer: ReturnType<typeof setTimeout> };
```

It has to *report*, not merely act, because the console prints the refusal and
only its caller knows where that line belongs. `demo` still carries the handle so
the simulation and the tests cancel deterministically rather than racing a wait.

`spawnSession` asks main for the process itself rather than leaving it to the
transport's lazy path, so main's refusal — "not mapped", "session limit
reached", "pty host unavailable" — reaches the console transcript verbatim. Both
routes share one channel, so whoever asks first is the only one who asks.

`useActiveSessions()` / `useDoneSessions()` are two flat selectors rather than
one returning `{ active, done }`: `useShallow` compares the returned value's own
properties, so an object of two freshly-built arrays never compares equal and the
component re-renders forever.

# Component patterns

**Scope:** panels, atoms, the rails, and the center-stage view-state machine.

**Owned by stories 020–053.** The shell (020) has landed; the panels have not.

## What already holds today

- Chrome lives in `src/components/layout/`, shared atoms in
  `src/components/ui/`, and domain surfaces in `src/features/<slice>/`.
- A feature slice follows the bulletproof-react shape: `components/`, `hooks/`,
  `stores/`, `types/`, `utils/`, plus an `index.ts` barrel that is the only thing
  outside code imports.
- Slices never import each other. Cross-slice communication goes through the
  store, or through `features/shared`.
- `src/components/**` may not import from `features/**` — chrome and atoms stay
  domain-agnostic.
- Colour comes from `--cc-*` tokens via Tailwind utilities. Raw hex literals in
  component code are banned.
- Only the shadcn primitives actually needed are installed: `dialog`, `tooltip`,
  `dropdown-menu`.

## The shell

`src/components/layout/app-shell.tsx` is the whole chrome. `src/app.tsx` renders
it and nothing else.

```
<body>                      100vh, overflow hidden, --cc-bg / --cc-ink
└── AppShell                flex column, h-full
    ├── Header              <header>  56px fixed, --cc-panel, border-bottom soft
    └── Row                 flex-1, min-h-0, flex
        ├── LeftRail        <nav>     268px fixed, --cc-panel, border-right soft,
        │                             own vertical scroll
        ├── CenterStage     <main>    flex-1, min-w-0, --cc-panel-2, flex column
        └── ActivityRail    <aside>   316px fixed, --cc-panel, border-left soft,
                                      own vertical scroll, unmounted when hidden
```

Each region is a landmark element, so tests address them by role
(`banner` / `navigation` / `main` / `complementary`) rather than by class.

### The rules the layout depends on

- **`min-h-0` on the row and `min-w-0` on the center stage.** A flex item
  defaults to `min-*: auto` and refuses to shrink below its content. Without
  `min-h-0` a tall rail pushes the shell past the viewport instead of scrolling
  inside itself; without `min-w-0` a long terminal line widens the center column,
  which xterm's fit addon then measures and grows into. Both are load-bearing,
  not defensive.
- **The rails never flex** (`w-[268px]` / `w-[316px]` + `shrink-0`), so the
  center column absorbs every width change and the document never gains a
  horizontal scrollbar.
- **The page never scrolls.** `body { overflow: hidden }` plus `overflow-y-auto`
  on each rail — three independent scrollbars, and the terminal keeps a stable
  size regardless of what lands in the rails.
- **The activity rail unmounts rather than hides.** `showActivityRail` in the
  ui-store is read through `useShowActivityRail()` — deliberately narrower than
  `useRailState()`, so switching rail tabs does not re-render the terminal.

Desktop-width only, by design: no responsive or mobile layout, and the rails are
not draggable. Both are explicit non-goals of story 020.

## The header

`src/components/layout/header.tsx` (story 021) fills the shell's top region.
Anatomy, sub-component contracts, and the two easy-to-get-wrong details live in
[`../.claude/COMPONENTS.md`](../.claude/COMPONENTS.md). The pattern worth
repeating in every other region:

**Chrome composes; the leaves subscribe.** The header itself reads only what its
own controls need. `ModelChip` and `StatusCounts` each own their store
subscription, so a session changing status repaints one span rather than the
whole bar. Rails and panels should be built the same way — a container that
subscribes on behalf of its children re-renders all of them.

Its corollary in tests: sub-components are asserted in their own files, and the
container's tests cover only the wiring.

## The center-stage view-state machine (040)

The stage shows **exactly one thing at a time**, and which one is decided by a
pure function rather than by nested JSX conditionals:

```ts
resolveView({ activeTab, picker, entity }): 'picker' | 'orchestrator' | 'session' | 'agent'
```

It lives in `src/lib/resolve-view.ts` and is tested exhaustively. A machine
embedded in JSX is one that grows a fifth state by accident; this one cannot.

Two precedence rules carry the weight:

- **Picker wins over everything**, and deliberately does *not* change
  `activeTab`. That is what lets closing it return the user to whatever was
  underneath — the tab was never touched.
- **The orchestrator is the floor.** An `activeTab` naming no entity resolves
  there rather than to a blank stage, because a session can be removed while its
  tab is open.

### What the component does with it

`CenterStage` is the composition root: it reads the stores so
`components/terminal/` never has to, builds one cached `StaticTransport` per
entity, and renders `SessionMetaBar` only for the two entity views.

**The picker hides the terminal region; it never unmounts it.** Unmounting would
dispose every live xterm instance and throw away the scrollback story 042 exists
to preserve. The region is hidden with a class, and `activeId` is passed as
`null` so each surface marks itself invisible — which also means closing the
picker re-reveals the previous surface and refits it through machinery that
already exists.

`overflow-hidden` on the stage enforces the story's rule that the stage never
scrolls as a whole; only the terminal region does.

### A consequence worth knowing

The meta bar appearing above a terminal *shrinks* that terminal. Rows come off
the bottom of the viewport, so a terminal parked at the end of its transcript
would silently show the middle of it. `TerminalSurface` therefore applies the
bottom-stick rule to fits as well as to writes — see
[`terminal-architecture.md`](terminal-architecture.md).

## The orchestrator console (041)

Three surfaces stacked inside the orchestrator view, in this order:

1. **`SessionTable`** — the fleet, as **DOM, not xterm**. Rows have to stay
   clickable and focusable, which terminal text cannot be. Eight active
   sessions, an `ENDED` divider, then the ones that have finished or
   terminated. A `terminated` row is `disabled`: it still reads and still
   selects, but its pty is gone and entering it would show a dead rectangle
   (story 108).
2. **The transcript** — an ordinary `TerminalSurface` bound to the `'orch'`
   pseudo-entity, so the console gets real ANSI colour and selection for free.
3. **`ConsoleInput`** — the command row and the hint bar beneath it.

The concept scrolls the table and transcript as one region. They cannot be: the
transcript is a real xterm with its own viewport, and a DOM table cannot share
it. The table keeps its own scroll and the terminal fills what is left.

### Parse, then execute — two halves that fail differently

```
parseCommand(raw) → ParsedCommand → runOrchCommand(parsed)
```

- `features/orchestrator/utils/parse-command.ts` is **pure**. It catches *shape*
  errors — `send` with no message, an unknown verb — and never touches the store.
- `hive-store.runOrchCommand` takes an already-parsed command and catches
  *existence* errors — no such session, unknown repo.

The type lives in `types/command.ts` rather than beside the parser because
`stores/` may not import `features/`. That constraint produced a better shape
than it interrupted: the union is the closest thing the prototype has to the
future daemon's API surface, and both halves are exhaustively testable alone.

`status` colours each row by session status rather than colouring the status
column alone — `TermLine` carries one colour per line, and a wall of amber still
reads as "these need you".

The transcript is capped at 200 lines. Unlike the feed's cap, this one has a
second job: the transcript is replayed into an xterm on every subscribe, so an
unbounded array would make opening the orchestrator slower over time.

### Selectors and the re-render trap

The table's two groups come from `useActiveSessions()` and `useDoneSessions()` —
two flat selectors, deliberately **not** one returning `{ active, done }`.

`useShallow` compares the returned value's own properties. An object holding two
freshly-built arrays is never shallow-equal to the previous one, so the component
re-renders, rebuilds the arrays, and loops until React throws "Maximum update
depth exceeded". Flat arrays are compared element by element, which is what makes
them stable. This cost a debugging cycle; it is written down so it costs nobody
another.

## The session / agent view (043)

Meta bar, terminal, and — over a **recording** — a message row. The row is
`MessageInput`, mounted by `CenterStage` and **keyed by entity id** — switching
sessions remounts it, which both clears a half-typed message meant for somebody
else and re-runs its autofocus.

### A live session has no message row (108)

The row is mounted only where the surface above it cannot be typed into: the
browser demo and the agent tabs, both replays. A live desktop session already
*is* Claude Code's prompt, and a second text box beneath it gives one session two
places to type, with different keybindings and no way to tell from the caret
which will receive the next character. The two autofocuses were also racing on
every newly opened session, which is how a brand-new session came to swallow what
was typed into it.

The keyboard goes to the terminal instead: `TerminalSurface` focuses itself when
it **becomes visible** and is interactive — reveal rather than mount, because
instances are created lazily and kept alive hidden, so the two coincide only
once. Read-only surfaces are excluded, which is what keeps the orchestrator
console's own command row focused.

There is no `session-view.tsx` wrapper, though story 043 names one. The terminal
belongs to the shared `TerminalHost`, so a component wrapping meta bar +
terminal + input would have to reach into it; composition happens in the stage
instead.

The authority for that is the **UPDATED SPECS block on Jira ticket HIVE-20**
("mount feature panels directly from this region's component in
`src/components/layout/` … no composition module inside a feature slice"). Note
that block exists only in Jira — story 040 in this repo had
not been synced with it, so do not go looking for it there.

### Send is one action with an origin

`sendToEntity(id, msg, origin)` handles both paths. The transcript records who
spoke, so the echo differs — `❯ [orchestrator] msg` from the console, a blank
line then `❯ msg` from the session's own row — but the acknowledgement is one
shared line, because it means the same thing either way.

One timer per message: two rapid sends produce two independent acknowledgements
rather than one cancelling the other. `appendEntityLines` only applies a status
to sessions, so agents stay `online` with no branch at the call site.

### Click-to-focus, without eating the selection

Clicking the terminal focuses the message row — but only when
`window.getSelection()` is empty. Moving focus collapses the document selection,
so an unconditional focus-on-click would delete the highlight the user's drag had
only just made. Over a live terminal the stage steps aside entirely and the
surface focuses itself, which is the same guard duplicated rather than assumed:
it is the same bug in both places.

## The new-session picker (044)

Keyboard-first: New session → type a query → Enter → a live terminal, hands
never leaving the keyboard. Pinned pills for the first four projects, two
bespoke steppers for model and effort, and a search box over all projects.

### Why the Radix primitive rather than `components/ui/dialog`

The vendored `DialogContent` always portals to `document.body` and centres a
fixed-position card. This picker **fills the center stage** — rails and header
stay visible, as the concept shows — so it composes `Dialog.Root` and
`Dialog.Content` from `radix-ui` directly and renders in place.

What the story actually asks for is Radix's *behaviour*, and the parts that
matter are kept: the focus trap, Escape, and `aria-modal` — all of which live in
`Content`. `onOpenAutoFocus` is intercepted so focus lands on the search box
rather than the container.

**Scroll locking is not kept**, and that is deliberate: Radix implements it in
`Dialog.Overlay`, which this picker omits because an overlay would paint a scrim
across the whole app and destroy the full-stage look. The shell is a
fixed-height, non-scrolling layout, so there is no page scroll to lock.

### The steppers

`OptionStepper` is bespoke and lives in this slice because nothing else uses it.
Its *semantics* are a radio group, so that is the role it exposes — and the
keyboard contract that role promises is implemented, not merely announced:
arrow keys step the selection (clamped, not wrapped), focus follows selection,
and roving `tabIndex` makes the group a single tab stop. Exposing `role="radio"`
without those is worse than using plain buttons, because it advertises an
interaction that does not exist. The track and fill are `aria-hidden`; the dots
carry the meaning.

Model and effort live in `ui-store`, not component state, so a deliberate choice
survives closing and reopening the picker.

### Spawn logging belongs to the store

`spawnSession` writes its own console line (`spawned {id} on {repo}`). The
`spawn` command used to write one too; that duplicate is gone. Logging at the
action rather than at each call site is what keeps the transcript complete when a
third caller — the picker today, a daemon event later — arrives.

## The activity rail (050–053)

Structurally the left rail's twin, and deliberately so: a `Record<TabId,
ComponentType>` panel map, a pinned `<TabBar />`, and a `role="tabpanel"`
wrapper labelled with `tabId(active)` that owns the scrollbar. Two rails, one
shape — if you are adding a third tabbed region, copy this and not something
new.

```tsx
const PANELS: Record<RailTab, ComponentType> = {
  inbox: InboxPanel,
  prs: PrsPanel,
  activity: ActivityFeedPanel,
};

const Panel = PANELS[railTab];
```

The map beats a `switch` in the body for one reason worth stating: `Record<RailTab,
…>` makes a new member of the union a **type error** here rather than a tab that
silently renders nothing.

### Scroll position resets on switch

Story 050 asks for an explicit choice, so: **reset**. Preserving per-panel
`scrollTop` means either keeping all three mounted or mirroring offsets into the
ui-store. Neither earns its complexity for three short lists, and a stale offset
into a list the simulation just prepended to is worse than starting at the top.

### One badge is loud, the rest are quiet

`TabBar` takes an optional `badgeTone`. Everything defaults to `muted`; the
Inbox tab passes `danger`, because its count is the one number in the app that
means *the user is what an agent is blocked on*. See
[`../.claude/COMPONENTS.md`](../.claude/COMPONENTS.md) for the atom contracts.

### The panels are feature slices, mounted from the composition root

`InboxPanel`, `PrsPanel`, and `ActivityFeedPanel` live in three separate slices
that cannot import each other. They meet only here, in `components/layout/` —
which is exactly what the composition-root exemption exists for. Rules the two
PR-rendering surfaces must agree on live in `features/shared/`, never in one
slice reaching into another.

## What later stories add here

Keyboard navigation (060) and simulation mode (061).

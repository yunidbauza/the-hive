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
   sessions, a `COMPLETED` divider, then the done ones.
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

## What later stories add here

The session/agent view's input row (043) and the real new-session picker (044) —
`CenterStage` currently renders a deliberately minimal picker placeholder so that
state stays exitable. Then the activity rail and its three panels (050–053).

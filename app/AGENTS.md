# AGENTS.md

Guidance for anyone — human or agent — working in this codebase.

This file is deliberately **thin**: the rules that always apply, plus a table
routing to deep-dives. Load the deep-dive that matches what you are working on
rather than carrying all of it every turn.

## Project overview

The Hive is a **command center for multiple agentic terminal sessions** running on
a single machine. An orchestrator ("Concierge"-style coordinator, called *maestro*
in the console) routes messages between the user and sessions, surfaces questions
and permission requests as an inbox, tracks PRs and tickets, and spawns new
sessions. **The most important component is the embedded terminal at the center of
the screen** — everything else exists to route the user's attention to the right
terminal at the right moment.

Current phase: **static prototype**. No backend. All data comes from an in-memory
mock layer, terminal content is canned ANSI fed into real xterm.js instances, and
state-mutating interactions mutate store state only. Full context, decision record,
and scope boundary: [`../stories/000-overview.md`](../stories/000-overview.md).

Stack: React 19 · TypeScript (strict) · Vite · xterm.js · Zustand · Tailwind v4 ·
shadcn/ui · pnpm.

## Essential commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server — the **browser** target (a fixtures-only demo) |
| `pnpm build` | Type-check, then production build of the browser target |
| `pnpm desktop:dev` | electron-vite: the Electron app, renderer HMR included |
| `pnpm desktop:build` | Type-check, then build `out/{main,preload,renderer}/` |
| `pnpm desktop:preview` | Run the built Electron app |
| `pnpm lint` | ESLint across `src/`, `electron/` and config |
| `pnpm type-check` | `tsc --noEmit` for the app, the Node-side configs, and `electron/` |
| `pnpm test` | Vitest, single run |
| `pnpm test:coverage` | Vitest with the 80% coverage gate |
| `pnpm test:e2e` | Playwright specs |
| `pnpm verify:boundaries` | Proves every architecture fence still fires |

**`pnpm lint` and `pnpm type-check` must both pass before any task is considered
done.** Neither is optional, and no rule may be disabled inline to make a task pass.

## Deep-dive docs

Load the one that matches the surface you are working on.

| When you are working on… | Load |
| --- | --- |
| The terminal, transports, ANSI, xterm config | [`docs/terminal-architecture.md`](docs/terminal-architecture.md) |
| Store shape, actions, selectors, fixture data | [`docs/state-and-data.md`](docs/state-and-data.md) |
| Panels, atoms, rails, the view-state machine | [`docs/component-patterns.md`](docs/component-patterns.md) |
| Simulation script and the fake clock | [`docs/simulation.md`](docs/simulation.md) |
| Any UI task — tokens, palette, type scale | [`.claude/DESIGN-SYSTEM.md`](.claude/DESIGN-SYSTEM.md) |
| Any UI task — atom inventory and props | [`.claude/COMPONENTS.md`](.claude/COMPONENTS.md) |

The visual source of truth is [`../concept/`](../concept/). When a story is silent
on a colour, size, or string, the concept file decides.

## Architecture rules

These are enforced by ESLint, not by review. `pnpm verify:boundaries` proves each
one still fires.

### Import zones

| Target | May **not** import from |
| --- | --- |
| `src/features/<slice>/**` | any other slice (except `src/features/shared/**`) |
| `src/components/**` (except `layout/`) | `src/features/**` |
| **`src/components/terminal/**`** | `src/features/**`, `src/data/**`, `src/stores/**` |
| `src/lib/**` | `src/features/**`, `src/components/**` |
| `src/hooks/**` | `src/features/**` |
| `src/stores/**` | `src/features/**`, `src/components/**` |
| everything except `src/stores/**` | `src/data/**` |
| `electron/main/**` | `src/**` |
| `electron/preload/**` | `src/**`, `electron/main/**` |
| `src/**` | `electron/main/**`, `electron/preload/**` |

`electron/shared/**` is the **only** module both processes may import, and it is
types and constants only — no runtime imports, no Node APIs, no DOM APIs. The
renderer reaches it through the `@shared` alias and must import from it
**type-only**; a value import would pull main-process code into the renderer
bundle. That is what makes the IPC contract a compile-time artifact rather than a
convention.

`src/components/layout/` is the **composition root** and is exempt from the
`features/` ban: the rails and the center stage exist to mount feature panels. The
exemption stops there — `components/ui/` and `components/terminal/` stay fully
fenced. It is expressed by listing the fenced directories in
`FENCED_COMPONENT_DIRS`, because `except` filters the *imported* module and can
never exempt the importing file; a **new** directory under `src/components/` gets
no fence until it is added to that list.

Feature isolation is generated as **one zone per slice**, each exempting itself and
`features/shared`. Adding a slice means adding it to `FEATURE_SLICES` in
`eslint.config.mjs` — a slice that is not listed gets no isolation zone and
silently becomes importable from everywhere.

### Naming and imports

- **kebab-case** for every file and folder under `src/` and `electron/`.
- **Absolute `@/` imports**, never relative parent imports (`../`).
- Import order: builtin → external → internal → parent → sibling → index, with
  `@/**` pinned before internal, blank lines between groups, alphabetised.
- **No circular dependencies.** Barrel files that create cycles are a bug.
- Path aliases live in **two** places — `vite.aliases.mjs` and `tsconfig.json`.
  Every bundler config (`vite.config.ts`, `vitest.config.ts`,
  `electron.vite.config.ts`) imports the first; TypeScript cannot import a JS
  module to build its config, so `paths` is the second copy. Add an alias to
  both or it will resolve in the editor and fail at runtime —
  `pnpm verify:boundaries` fails if the two disagree.

## The terminal seam

**The single most important invariant in the codebase.**

`src/components/terminal/` speaks only `TerminalTransport`. It may not import from
`features/`, `data/`, or `stores/` — and cannot, because the lint zone fails the
build.

In this phase the transport is a static/scripted fake. Later it becomes IPC to a
local PTY daemon **with no changes to the component tree**. That is the whole
reason the seam exists: when real terminals arrive, the work touches
`src/lib/terminal/` and nothing else.

Corollary: xterm resolves colours from its own JS `theme` option and paints them
into markup it owns, so a `--cc-*` custom property has no path to a terminal cell.
Terminal colour comes from JS — `TERM` and `XTERM_THEME` in
`src/lib/terminal/ansi.ts` are the single definition. Never hand-write a hex into a
terminal component. (Older revisions said "xterm paints to a canvas". It does not:
xterm 6 core ships the DOM renderer and no canvas/WebGL addon is installed. The
conclusion stands regardless — see `docs/terminal-architecture.md`.)

## State management

Two stores, split along what the user is *looking at* versus what the system
*knows*. The split is not cosmetic — it keeps a keystroke in the picker from
re-rendering thirteen live terminals.

- `src/stores/hive-store.ts` — domain state: entities, tickets, PRs, notifications,
  feed, orchestrator transcript.
- `src/stores/ui-store.ts` — view state: theme, tabs, selection, picker, rails.

**Components never read a store object directly and never call `getState()`.**
Every consumer goes through a named selector hook exported next to the store
(`useCounts()`, `useEntity(id)`, `useUnreadCount()`, …). This is what keeps a
status change from re-rendering the whole shell.

Derived values are computed **in selectors, never stored** — there is exactly one
source of truth for every number on screen.

Cross-store effects call the other store's action explicitly. No store subscribes
to another.

Fixtures (`src/data/`) are **store-only consumers**. Nothing that renders may
import them; read derived state through a hook.

## Styling

- Colour comes from the `--cc-*` tokens in `src/styles/tokens.css`, bound to
  Tailwind through `@theme inline`. Use the resulting utilities (`bg-panel`,
  `text-muted`, `border-soft`).
- **Raw hex literals in component code are banned.** If a colour is missing, add a
  token.
- The terminal keeps its dark background in light mode, like the concept and most
  real tools.
- Icons: `@phosphor-icons/react`. The app ships one icon library.

## Testing requirements

- `tests/` **mirrors** `src/`. A test for `src/features/inbox/components/x.tsx`
  lives at `tests/features/inbox/components/x.test.tsx`. No exceptions — the mirror
  is what makes "is this covered?" answerable by path.
- **80% coverage** on lines, statements, branches, and functions. The gate fails
  the build; it is what CI runs.
- Stores are plain functions and are the highest-value target: every action gets a
  test against a fresh store. See `tests/stores/hive-store.test.ts` for the pattern.
- Timer-based behaviour uses **fake timers**, never real waits.
- **xterm is never instantiated for real in unit tests** — happy-dom performs no
  layout, so xterm can never measure a cell.
  `__mocks__/@xterm/` holds recording fakes; assert plumbing only. Colours,
  selection, and scrollback belong in Playwright.
- Do not add a coverage-ignore comment to get past the gate. An untestable branch
  is usually a design smell — fix the shape instead.

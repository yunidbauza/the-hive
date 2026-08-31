# AGENTS.md

Guidance for anyone — human or agent — working in this codebase.

This file is deliberately **thin**: the rules that always apply, plus a table
routing to deep-dives. Load the one matching what you are working on rather than
carrying all of it every turn.

## Project overview

The Hive is a **command center for multiple agentic terminal sessions** running on
a single machine. An orchestrator ("Concierge"-style coordinator, called *maestro*
in the console) routes messages between the user and sessions, surfaces questions
and permission requests as an inbox, tracks PRs and tickets, and spawns new
sessions. **The most important component is the embedded terminal at the center of
the screen** — everything else exists to route the user's attention to the right
terminal at the right moment.

Current phase: terminals are **real PTYs**, projects come from a config file,
tickets from **Jira**, PRs from `gh`, and notifications from Claude Code's hooks.
The right rail's third tab is a **project explorer** over the active session's
repository, opening files into a CodeMirror editor on the centre stage. Full
context and scope: the **HIVE project in Jira**, the backlog.

Stack: React 19 · TypeScript (strict) · Vite · xterm.js · CodeMirror 6 ·
Zustand · Tailwind v4 · shadcn/ui · pnpm.

## Essential commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server — the **browser** target (chrome only: no PTYs, no Jira, no config) |
| `pnpm build` | Type-check, then production build of the browser target |
| `pnpm desktop:dev` | electron-vite: the Electron app, renderer HMR included |
| `pnpm desktop:build` | Type-check, then build `out/{main,preload,renderer}/` |
| `pnpm desktop:preview` | Run the built Electron app |
| `pnpm desktop:dist` | Package `.dmg` + `.zip` into `dist/` (macOS arm64); `:publish` uploads them |
| `pnpm lint` | ESLint across `src/`, `electron/` and config |
| `pnpm type-check` | `tsc --noEmit` for the app, the Node-side configs, and `electron/` |
| `pnpm test` | Vitest, single run |
| `pnpm test:coverage` | Vitest with the 80% coverage gate |
| `pnpm test:e2e` | Playwright — both the web and electron projects |
| `pnpm test:e2e:web` · `:electron` | Either half alone — browser specs (070), or the built app (085) |
| `pnpm test:pty` | PTY conformance — real PTYs, Electron ABI, no UI (098) |
| `pnpm test:hooks` · `:statusline` · `:skills` · `:done` · `:ready` · `:back` · `:title` · `:ledger` · `:agent` | Live conformance against a **real `claude`** — hooks (~3½ min), the status line, custom skills, `/done`, the boot-ready signal, the bare-`←` claim in the built app, that an unnamed session titles itself (~2½ min), the ledger MCP tools, and the headless agent runs — hooks, `--resume`, and the two-wake ledger conversation (~1 min, after a `desktop:build`) |
| `pnpm verify:boundaries` | Proves every architecture fence still fires |

**`pnpm lint` and `pnpm type-check` must both pass before any task is considered
done.** Neither is optional, and no rule may be disabled inline to make a task pass.

## Deep-dive docs

| When you are working on… | Load |
| --- | --- |
| The terminal, transports, ANSI, xterm config | [`docs/terminal-architecture.md`](docs/terminal-architecture.md) |
| The project explorer, the editor, the fs IPC surface | [`docs/explorer-and-editor.md`](docs/explorer-and-editor.md) |
| The main process, IPC, native modules | [`docs/desktop-architecture.md`](docs/desktop-architecture.md) |
| Installers, releases, auto-update, the app name | [`docs/packaging-and-updates.md`](docs/packaging-and-updates.md) |
| Store shape, actions, selectors, fixture data | [`docs/state-and-data.md`](docs/state-and-data.md) |
| Panels, atoms, rails, the view-state machine | [`docs/component-patterns.md`](docs/component-patterns.md) |
| Simulation script and the fake clock | [`docs/simulation.md`](docs/simulation.md) |
| The ledger, parties, asks and claims; agent definitions | [`docs/agents-and-ledger.md`](docs/agents-and-ledger.md) |
| Any UI task — tokens and type scale, then atoms and props | [`.claude/DESIGN-SYSTEM.md`](.claude/DESIGN-SYSTEM.md) · [`.claude/COMPONENTS.md`](.claude/COMPONENTS.md) |

The visual source of truth is [`.claude/DESIGN-SYSTEM.md`](.claude/DESIGN-SYSTEM.md):
it records what the retired concept mock fixed (`git log -- concept/` still has it).

## Architecture rules

These are enforced by ESLint, not by review. `pnpm verify:boundaries` proves each
one still fires.

### Import zones

| Target | May **not** import from |
| --- | --- |
| `src/features/<slice>/**` | any other slice (except `src/features/shared/**`) |
| `src/components/**` (except `layout/`) | `src/features/**` |
| **`src/components/terminal/**`** | `src/features/**`, `src/data/**`, `src/stores/**` |
| **`src/components/editor/**`** | `src/features/**`, `src/data/**`, `src/stores/**` |
| `src/lib/**` | `src/features/**`, `src/components/**` |
| `src/hooks/**` | `src/features/**` |
| `src/stores/**` | `src/features/**`, `src/components/**` |
| everything except `src/stores/**` | `src/data/**` |
| `src/**`, `electron/**` | `tests/**` (test scaffolding never ships) |
| `electron/main/**` | `src/**` |
| `electron/preload/**` | `src/**`, `electron/main/**` |
| **`electron/pty-host/**`, `electron/mcp-host/**`** | `src/**`, `electron/main/**`, `electron/preload/**` |
| `src/**` | `electron/main/**`, `electron/preload/**`, `electron/pty-host/**`, `electron/mcp-host/**` |

`electron/shared/**` is the **only** module both processes may import, and it is types,
constants, and pure dependency-free logic only — no runtime imports, no Node APIs, no
DOM APIs. The renderer reaches it through `@shared`; anything with behaviour behind it
must be imported **type-only**, or main-process code lands in the renderer bundle. That
is what makes the IPC contract a compile-time artifact rather than a convention.

`src/components/layout/` is the **composition root** and is exempt from the
`features/` ban: the rails and the center stage exist to mount feature panels.
The exemption stops there — `ui/`, `terminal/` and `editor/` stay fully fenced,
expressed by listing them in `FENCED_COMPONENT_DIRS`, because `except` filters
the *imported* module and can never exempt the importing file. A **new**
directory under `src/components/` gets no fence until it is added to that list.

Feature isolation is generated as **one zone per slice**, each exempting itself and
`features/shared`. Adding a slice means adding it to `FEATURE_SLICES` in
`eslint.config.mjs` — a slice that is not listed gets no isolation zone and
silently becomes importable from everywhere.

### Naming and imports

- **kebab-case** everywhere; **absolute `@/` imports**, never `../`.
- Import order: builtin → external → internal → parent → sibling → index, with
  `@/**` pinned before internal, blank lines between groups, alphabetised.
- **No circular dependencies.** Barrel files that create cycles are a bug.
- Path aliases live in **two** places — `vite.aliases.mjs` (imported by every
  bundler config) and `tsconfig.json`'s `paths`, because TypeScript cannot
  import a JS module to build its config. Add an alias to both or it resolves in
  the editor and fails at runtime; `pnpm verify:boundaries` catches a mismatch.

## The terminal seam

**The single most important invariant in the codebase.**

`src/components/terminal/` speaks only `TerminalTransport`. It may not import from
`features/`, `data/`, or `stores/` — and cannot, because the lint zone fails the build.

In this phase the transport is a static/scripted fake; later it becomes IPC to a
local PTY daemon **with no changes to the component tree**. That is the whole
reason the seam exists.

Corollary: xterm resolves colours from its own JS `theme` option and paints them
into markup it owns, so a `--cc-*` custom property has no path to a terminal
cell. Terminal colour comes from JS — the active theme's `terminal` group, whose
built-in values are defined in `src/lib/theme/built-in.ts`. Never hand-write a
hex into a terminal component (`docs/terminal-architecture.md`).

`src/components/editor/` is the same seam with the colour rule **inverted**:
CodeMirror emits real CSS, so its palette is `--cc-code-*` in `tokens.css`. The
ban on hex literals holds in both ([`docs/explorer-and-editor.md`](docs/explorer-and-editor.md)).

## State management

Four stores: what the system *knows*, what the user is *looking at*, what they
have *chosen*, and what they have *open*. Not cosmetic — it keeps a picker
keystroke from re-rendering thirteen live terminals.

- `hive-store.ts` — domain: entities, tickets, PRs, notifications, transcript,
  and the ledger tail (a capped mirror of main's log; it merges, never replaces).
- `ui-store.ts` — view state: tabs, selection, picker, rails, tree expansion.
- `appearance-store.ts` — theme, terminal and editor typography, density.
- `editor-store.ts` — open file buffers: text, dirty, stale, conflict.

**Everything in `appearance-store` is persisted, to `localStorage` and not the
config file; nothing anywhere else is.** That rule is the boundary, and it is
why buffers earned a fourth store — see `docs/state-and-data.md`.

**Components never read a store object directly and never call `getState()`.**
Every consumer goes through a named selector hook exported next to the store
(`useCounts()`, `useEntity(id)`, `useUnreadCount()`, …). This is what keeps a
status change from re-rendering the whole shell.

Derived values are computed **in selectors, never stored** — one truth per number
on screen. Cross-store effects call the other store's action; none subscribes.

Fixtures (`src/data/`) are **store-only**, seed only `notifs`, and never gain a
slice back; boot data is last run's ended sessions. Tests: `tests/support/`.

## Styling

- Colour comes from the `--cc-*` tokens in `src/styles/tokens.css`, bound to
  Tailwind through `@theme inline`. Use the utilities (`bg-panel`, `text-muted`).
- **Raw hex literals in component code are banned.** If a colour is missing, add a
  token.
- Terminal and editor both follow the theme — terminal colour from JS, editor from CSS.
- Icons: `@phosphor-icons/react`. The app ships one icon library.

## Testing requirements

- `tests/` **mirrors** `src/`. A test for `src/features/inbox/components/x.tsx`
  lives at `tests/features/inbox/components/x.test.tsx`. No exceptions — the mirror
  is what makes "is this covered?" answerable by path.
- **80% coverage** on all four metrics. The gate fails the build; CI runs it.
- Stores are plain functions and the highest-value target: every action gets a
  test against a fresh store (`tests/stores/hive-store.test.ts`).
- Timer-based behaviour uses **fake timers**, never real waits.
- **xterm is never instantiated for real** — happy-dom performs no layout, so it
  can never measure a cell. `__mocks__/@xterm/` holds recording fakes; assert
  plumbing only. Colours, selection and scrollback belong in Playwright.
  **CodeMirror is the opposite**: it renders without measuring first, so
  `.cm-content` really holds the text. Do not add a mock for it.
- **`node-pty` is never loaded for real** — a unit test that spawns real
  processes leaks them. `__mocks__/node-pty.ts` records; assert spawn arguments,
  cwd, write/resize/kill routing, exit handling. What only a real process can
  show: terminal semantics — `pnpm test:pty` (098); what Claude Code's hooks
  actually send — `pnpm test:hooks`; what it actually **draws**, which no staged
  buffer can prove — `pnpm test:back` (HIVE-79, `docs/terminal-architecture.md`).
- Never add a coverage-ignore comment to pass the gate. An untestable branch is
  usually a design smell — fix the shape instead.

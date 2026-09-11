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
| `pnpm test:hooks` · `:statusline` · `:skills` · `:done` · `:ready` · `:hook-context` · `:marker` · `:back` · `:nudge` · `:title` · `:ledger` · `:mcp-http` · `:agent` · `:container` · `:server` | Live conformance against a **real `claude`** — hooks (~3½ min), the status line, custom skills, `/done`, the boot-ready signal, that a hook's response reaches the model's context over http and command alike, `SessionStart` over http excepted, and what a slow, erroring or absent receiver costs the prompt (HIVE-136, ~2½ min), that a marker landing in a real session carries its entry whole as hook context through the real receiver and a real ledger (HIVE-138, ~1½ min), the bare-`←` claim in the built app, that a nudge marker is held while the visible input box holds a draft and lands once it is cleared (HIVE-135), that an unnamed session titles itself (~2½ min), the ledger MCP tools, the same tools served over `POST /mcp` with the container config's `${VAR}` shape, the headless agent runs — hooks, `--resume`, the two-wake ledger conversation, the permission fence, the scheduler's own clock, two task runs live at once with distinct receipts, and — skipped rather than failed without both Slack tokens stored — that a real Socket Mode `app_mention` starts a real run with no `runs.run` call behind it (HIVE-124, ~3½ min, after a `desktop:build`) — the container session profile and a containerised agent against a real Docker container: the mechanism half needs only `alpine:3`; the claude and agent halves need `HIVE_LIVE_CONTAINER_IMAGE` naming an image built from `tests/live/container/Dockerfile` plus a credential in env (~2 min) — and, needing no `claude` at all, only the built app spawned twice over: server mode's real socket answering on loopback, a wrong or revoked token and a disallowed Origin each refused by their own code, a version mismatch that ends the socket with no frame following, an unattached socket refusing a call frame, `--pair` run in a second process reaching the already-running server with no restart and without erasing a device paired just before it, no token ever landing in `config.json`, a `0.0.0.0` bind refused with a reason while the app keeps running, and — read off the served process's own listening sockets with `lsof`, not a network probe a firewall could make look identical either way — that the OS-level bind itself is loopback-only, with a positive control proving that same check on this machine can see a genuine wildcard bind when one exists (HIVE-142), and — two real built apps, one serving and one attaching — that a client whose server is killed underneath it says it is reconnecting rather than going on claiming an attachment, and reattaches on its own when that server comes back, with nobody flipping a switch (HIVE-150), and that a client dropped by a cut connection re-states what it has on screen, so a block on a session every device is watching still arrives already-read (HIVE-160) (after a `desktop:build`, ~2 min) |
| `pnpm verify:boundaries` | Proves every architecture fence still fires |

**`pnpm lint` and `pnpm type-check` must both pass before any task is considered
done.** Neither is optional, and no rule may be disabled inline to make a task pass.

## Working a ticket

Two audits now. A week of sessions (Sep 2026) found the hours going to
confirmation prompts and to a serial implement-review-re-review chain. HIVE-144
then proved the first half fixed and the second half untouched: four human turns
in 17h34m, the orchestrator idle 29 minutes out of 853, and still 6.8 of the 14.2
implementation hours inside the review chain. These rules follow from both:

- **Execute plans inline.** Subagent-driven development is for a plan that spans
  two or more subsystems with no shared test harness (main process + renderer +
  a live suite) *and* touches a risk surface (auth, tokens, a wire protocol,
  concurrency). One subsystem runs inline, however many tasks it has.
- **The per-task review is conditional, and lean.** Only a task the plan marks
  risk-bearing gets a reviewer subagent; the rest the controller adjudicates by
  reading the diff itself. One reviewer, one pass, scoped to that task's diff and
  its brief. Never fan reviewers out by category per task. HIVE-144 gave all 15
  tasks a reviewer plus a scoped re-reviewer, 29 agents, and ship's whole-branch
  review still found a Critical across the seams none of them could see.
- **No scoped re-review subagent.** The implementer proves its own fix, with the
  mutation or the test that fails without it, and the controller adjudicates the
  proof. Two fix rounds per task stays the cap. Review-driven fix rounds were 5.5
  hours of HIVE-144 against 7.4 for the implementation itself.
- **Ship's self review is the one whole-branch review**, and the one place the
  deep multi-dimension pass belongs.
- **Re-split when the plan is wrong about size.** Tasks are twenty
  implementer-minutes. Two consecutive tasks over that means every remaining
  estimate is wrong: re-split what is left before the next dispatch. HIVE-144's
  task 2 came back at forty minutes, its mean was fifty-one, its worst a hundred
  and four, and nothing re-sized.
- **A thirteen-point ticket is more than one PR.** HIVE-144 shipped 100 files and
  15,698 insertions on one branch, a diff no whole-branch review can hold. Split
  it in the plan, not at the merge.
- **Ask decisions in one batch.** One `AskUserQuestion` call carries up to four
  questions; the recommended option goes first. Never one question per turn.
- **Never sleep-poll a subagent.** Its task notification is the wake-up; a
  `sleep N; git log` loop overshoots by up to its own length every time.
- **The tail runs unattended.** After the reconciliation go-ahead, the flow
  pushes, opens the draft PR and invokes ship in the same turn; auto-merge for
  this repo is on in `~/.claude/workstream/ship-config.json`.
- **A failing e2e spec is re-run alone before it counts as red.** Playwright is
  pinned to two workers here because the timeout flake scales with parallelism;
  it lowers the flake, it does not remove it. A spec that passes alone is a
  flake to note, not a finding to fix; an assertion failure is real either way.

## Deep-dive docs

| When you are working on… | Load |
| --- | --- |
| The terminal, transports, ANSI, xterm config | [`docs/terminal-architecture.md`](docs/terminal-architecture.md) |
| The project explorer, the editor, the fs IPC surface | [`docs/explorer-and-editor.md`](docs/explorer-and-editor.md) |
| The main process, IPC, native modules | [`docs/desktop-architecture.md`](docs/desktop-architecture.md) |
| Installers, releases, auto-update, the app name | [`docs/packaging-and-updates.md`](docs/packaging-and-updates.md) |
| Server mode: the Mac mini deployment, pairing, the LaunchAgent, what a socket may call | [`docs/server-mode.md`](docs/server-mode.md) |
| Store shape, actions, selectors, fixture data, the fake clock | [`docs/state-and-data.md`](docs/state-and-data.md) |
| Panels, atoms, rails, the view-state machine | [`docs/component-patterns.md`](docs/component-patterns.md) |
| The map: processes, fences, which deep dive owns what | [`docs/architecture.md`](docs/architecture.md) |
| What a feature does for the user (the guides, indexed) | [`docs/README.md`](docs/README.md) |
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

`electron/shared/**` is the **only** module both processes may import, and its rule is
what a module **drags in** — no runtime imports, no Node APIs, no DOM APIs — not "types
only" (`guards.ts`, `ledger-derive.ts`, `mcp-tools.ts` all ship logic both sides run).
The renderer reaches it via `@shared`, **type-only** for anything with behaviour behind
it, or main-process code lands in the renderer bundle — that compile-time contract.

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
- **`node-pty` is never loaded for real** — a unit test that spawns real processes
  leaks them. `__mocks__/node-pty.ts` records; assert spawn arguments, cwd,
  write/resize/kill routing, exit handling. What only a real process can show:
  terminal semantics — `pnpm test:pty` (098); what Claude Code's hooks actually
  send — `pnpm test:hooks`; what it actually **draws**, which no staged buffer
  can prove — `pnpm test:back` (HIVE-79) and `pnpm test:nudge` (HIVE-135).
- Never add a coverage-ignore comment to pass the gate. An untestable branch is
  usually a design smell — fix the shape instead.

# 000 — The Hive: Product Overview & Prototype Scope

| | |
|---|---|
| **ID** | HIVE-000 |
| **Epic** | Foundation |
| **Depends on** | — |
| **Blocks** | Everything |
| **Points** | 1 |
| **Source** | `concept/Command Center.dc.html` |
| **Architecture reference** | `incorpHQ/incorpx` (FE) |

## Vision

The Hive is a **command center for multiple agentic terminal sessions** running on a
single machine. A developer runs many Claude Code (or similar) sessions in parallel —
each on its own project/branch — plus long-lived background agents (Slack responder,
PR reviewer, standup compiler). An **orchestrator** coordinates them: it routes
messages between the user and sessions, surfaces questions/permission requests as an
inbox, tracks PRs and tickets, and lets the user spawn new sessions.

**The most important component is the embedded terminal at the center of the screen.**
Everything else (rails, inbox, tabs) exists to route the user's attention to the right
terminal at the right moment.

## Decision record (already made)

- **Stack**: React 19 + TypeScript (strict) + **Vite**, **xterm.js** for the terminal
  surface, **Zustand** for state, **Tailwind v4** for styling, **pnpm** as the package
  manager.
- **Why Vite and not Next.js** — the Hive is a single-screen app destined for a desktop
  shell (Electron/Tauri). There is no server, no routing, and no SSR to gain. The
  architecture reference (`incorpx`) is a Next.js app; we take its *conventions*, not
  its framework.
- **Target**: runs in a browser now; will be wrapped in a desktop shell later. All
  sessions run on a **single machine**.
- **Architectural seam**: the terminal component only speaks a transport interface
  (`write(bytes)` / `onData(bytes)` / `resize(cols, rows)`). In this prototype phase the
  transport is a **static/scripted fake**. Later it becomes IPC→PTY without UI changes.
  See [042-terminal-surface.md](042-terminal-surface.md).

## Architecture baseline (modeled on `incorpx`)

The prototype adopts the FE conventions already proven in `incorpHQ/incorpx`, so the
Hive graduates from prototype to product without an architectural rewrite. The
mapping is deliberate:

| `incorpx` convention | How the Hive applies it | Story |
|---|---|---|
| Bulletproof-react feature slices — `src/features/<feature>/{components,hooks,stores,types,utils}` + `index.ts` | One slice per domain surface: `projects`, `work`, `agents`, `orchestrator`, `sessions`, `inbox`, `pull-requests`, `activity-feed`, `simulation` | [010](010-project-scaffold.md), [014](014-architecture-boundaries.md) |
| **Feature isolation** — features never import each other (except `features/shared`), enforced by ESLint `import/no-restricted-paths` | Same zones; cross-feature communication goes through the store, never through direct imports | [014](014-architecture-boundaries.md) |
| Unidirectional imports `shared → features → app`; `import/no-cycle` | Identical | [014](014-architecture-boundaries.md) |
| kebab-case files and folders, enforced by `check-file` | Identical | [014](014-architecture-boundaries.md) |
| Absolute `@/` imports plus the alias set (`@components/*`, `@features/*`, `@stores/*`, …) | Identical alias set, resolved in both `tsconfig.json` and `vite.config.ts` | [010](010-project-scaffold.md) |
| **One transport module** every call goes through (`src/lib/http-client.ts`) | `src/lib/terminal/` — `TerminalTransport` interface + `StaticTransport`. The single swap point for the future PTY daemon | [042](042-terminal-surface.md) |
| Zustand stores with **selector hooks**, never raw store reads in components | `hive-store.ts` (domain) + `ui-store.ts` (theme, tabs, picker) with `useCounts()`, `useEntity(id)`, `useUnreadCount()` … | [012](012-mock-data-layer.md) |
| `tests/` mirroring `src/`, Vitest + React Testing Library, **80% coverage gate** | Identical layout and gate | [013](013-testing-infrastructure.md) |
| Playwright e2e in `tests/e2e/` | Identical; the keyboard-only path and the waiting-session payoff loop are the flagship specs | [070](070-e2e-harness.md) |
| Tailwind + CSS-variable theming, shadcn/ui primitives | Tailwind v4 with the concept's `--cc-*` tokens registered via `@theme`; only the shadcn primitives actually needed (dialog, tooltip, dropdown-menu) | [011](011-design-tokens-and-theming.md) |
| `AGENTS.md` as a thin index + `docs/` deep-dives + `.claude/DESIGN-SYSTEM.md` | Identical, seeded from day one rather than retrofitted | [015](015-project-docs.md) |
| CI runs lint + type-check + coverage + e2e | Identical | [071](071-ci-workflow.md) |

**What we deliberately do *not* take from `incorpx`**: Next.js App Router, the
`src/app/` route tree, `better-auth`, the HTTP/axios client, React Query, and the
form/table/wizard component families. The Hive has no server, no auth, no forms, and
one screen.

## Scope of THIS phase: static prototype

Reproduce the concept UI in React with **no real backend**:

- All data comes from an in-memory mock data layer ([012](012-mock-data-layer.md)).
- Terminal content is canned ANSI text fed into real xterm.js instances.
- Interactions that mutate state (spawn, send, mark read, theme) mutate store state only.
- An optional simulation mode replays scripted events to make the demo feel alive
  ([061](061-simulation-mode.md)).

Out of scope for this phase: real PTYs, persistence, auth, real Git/Slack/Jira
integrations, multi-machine support.

## Domain glossary

| Term | Meaning |
|---|---|
| **Session** | One agentic terminal session bound to a project + branch (e.g. `hero-refresh` on `apfm-web`/`feat/hero-refresh`). Has status, task, optional PR, cost. |
| **Agent** | Long-lived background worker not tied to a branch (e.g. `slack-agent`, `pr-reviewer`, `standup-agent`). Always `online`. |
| **Orchestrator** | The coordinator ("maestro"). Owns the session table view, the command console, message routing, and the activity feed. |
| **Entity** | Union of Session and Agent — anything that owns a terminal tab. |
| **Ticket** | A work item (Jira-like key e.g. `GRAC-3018`) linking one or more sessions and their PRs. |
| **Inbox** | Notifications requiring user attention (approvals, questions, PR events). |

## Session status model

| Status | Label | Color token | Notes |
|---|---|---|---|
| `working` | working | `--cc-green` | dot pulses (`ccpulse` animation) |
| `waiting` | needs input | `--cc-amber` | blocked on user answer/permission |
| `idle` | idle | `--cc-subtle` | context saved, resumable |
| `done` | done | `--cc-brand` | listed under COMPLETED |
| `online` | online | `--cc-green` | agents only |

## Screen anatomy (from concept)

```
┌────────────────────────── Header (56px) ──────────────────────────┐
│ brand                 model-chip (centred)   counts·theme·bell·New│
├───────────┬────────────────────────────────────┬──────────────────┤
│ Left rail │        CENTER STAGE                │  Activity rail   │
│  (268px)  │  - Orchestrator console (default)  │    (316px)       │
│ Projects  │  - Session terminal view           │  Inbox           │
│ Work      │  - Agent terminal view             │  PRs             │
│ Agents    │  - New-session picker (overlay)    │  Activity        │
├───────────┴──────────── input / hint bar ──────┴──────────────────┤
```

## Story map & build order

Foundation → shell → panels → center → polish. Each story lists its dependencies.

1. [010-project-scaffold.md](010-project-scaffold.md)
2. [011-design-tokens-and-theming.md](011-design-tokens-and-theming.md)
3. [012-mock-data-layer.md](012-mock-data-layer.md)
4. [013-testing-infrastructure.md](013-testing-infrastructure.md)
5. [014-architecture-boundaries.md](014-architecture-boundaries.md)
6. [015-project-docs.md](015-project-docs.md)
7. [020-app-shell-layout.md](020-app-shell-layout.md)
8. [021-header.md](021-header.md)
9. [030-left-rail.md](030-left-rail.md) → [031](031-projects-panel.md), [032](032-work-panel.md), [033](033-agents-panel.md)
10. [040-center-stage.md](040-center-stage.md) → [041](041-orchestrator-console.md), [042](042-terminal-surface.md), [043](043-session-view.md), [044](044-new-session-picker.md)
11. [050-activity-rail.md](050-activity-rail.md) → [051](051-inbox-panel.md), [052](052-prs-panel.md), [053](053-activity-feed-panel.md)
12. [060-keyboard-navigation.md](060-keyboard-navigation.md)
13. [061-simulation-mode.md](061-simulation-mode.md)
14. [070-e2e-harness.md](070-e2e-harness.md)
15. [071-ci-workflow.md](071-ci-workflow.md)

Full index with dependency graph: [README.md](README.md)

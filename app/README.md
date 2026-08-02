# The Hive — app

A command center for multiple agentic terminal sessions running on a single machine.
This package is the **static React prototype**: real xterm.js terminal surfaces fed by
an in-memory mock data layer, with no backend. The terminal transport is the designed
seam for the future local-PTY daemon.

Context, decision record, and scope boundary: [`../stories/000-overview.md`](../stories/000-overview.md).
Full backlog: [`../stories/`](../stories/). The visual source of truth is
[`../concept/`](../concept/) — stories quote its exact colors, sizes, and copy.

## Requirements

- **Node** — the major pinned in [`.nvmrc`](.nvmrc) (22)
- **pnpm** — the package manager, pinned via `packageManager` in `package.json`

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the Vite dev server |
| `pnpm build` | Type-check, then produce a production build |
| `pnpm preview` | Serve the production build locally |
| `pnpm lint` | ESLint across `src/` and config files |
| `pnpm type-check` | `tsc --noEmit` for the app and the Node-side configs |
| `pnpm test` | Vitest, single run |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm test:coverage` | Vitest with the coverage gate |
| `pnpm test:ui` | Vitest browser UI |
| `pnpm test:e2e` | Playwright end-to-end specs |

**`pnpm lint` and `pnpm type-check` must both pass before any task is considered done.**

The test scripts are wired up by story 013 (testing infrastructure) and `test:e2e` by
story 070 (Playwright harness); the script names exist from the scaffold so the
vocabulary never changes underneath anyone.

## Stack

React 19 · TypeScript (strict) · Vite · xterm.js · Zustand · Tailwind v4 · shadcn/ui

Vite rather than Next.js: the Hive is a single-screen app destined for a desktop shell
(Electron/Tauri). There is no server, no routing, and no SSR to gain. The architecture
reference — `incorpHQ/incorpx` — is a Next.js app; we take its conventions, not its
framework.

## Layout

```
src/
  main.tsx          entry
  app.tsx           composition root
  styles/           tokens.css + global.css      (011)
  components/
    ui/             shadcn primitives + Hive atoms
    layout/         app chrome — the three-column shell
    terminal/       THE core component — domain-agnostic
  features/         one slice per domain surface
    shared/         the ONLY slice other slices may import
  stores/           hive-store.ts + ui-store.ts   (012)
  hooks/  lib/  types/  data/  config/  utils/
tests/              mirrors src/                  (013)
docs/               deep-dive docs                (015)
```

Feature slices follow the bulletproof-react shape — `components/`, `hooks/`, `stores/`,
`types/`, `utils/`, plus an `index.ts` barrel that is the only thing outside code
imports.

## Rules that are machine-enforced

Story 014 turns these into lint failures rather than review notes:

- **Feature isolation** — slices never import each other, except `features/shared`.
  Cross-slice communication goes through the store.
- **The terminal seam** — nothing under `src/components/terminal/` may import from
  `features/`, `data/`, or `stores/`. The terminal knows only its transport.
- **kebab-case** file and folder names; no circular imports; ordered imports.
- **Absolute `@/` imports**, never relative parent imports (`../`).

Path aliases are declared in **both** `tsconfig.json` and `vite.config.ts` — Vite does
not read TypeScript's `paths`, so the two lists must be kept in sync.

## shadcn/ui

Only the primitives the UI actually needs are installed — `dialog` (picker overlay),
`tooltip` (meta-bar back button), and `dropdown-menu`. The library is deliberately not
bulk-installed. Generated primitives are adapted to use `@phosphor-icons/react` so the
app ships a single icon library.

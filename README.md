# The Hive

A command center for multiple agentic terminal sessions running on a single machine.
This repository is the **static React prototype**: real xterm.js terminal surfaces fed by
an in-memory mock data layer, with no backend. The terminal transport is the designed
seam for the future local-PTY daemon.

Context, decision record, scope boundary and full backlog: the **HIVE project in
Jira**. The visual source of truth is
[`.claude/DESIGN-SYSTEM.md`](.claude/DESIGN-SYSTEM.md) — it records the exact colors,
sizes, and copy the concept mock fixed, and tickets quote them.

## Requirements

- **Node** — the major pinned in [`.nvmrc`](.nvmrc) (22)
- **pnpm** — the package manager, pinned via `packageManager` in `package.json`
- **Chromium** — for `pnpm test:e2e` only. `pnpm install` does not fetch browser
  binaries, so run `pnpm exec playwright install chromium` once per machine.

### Native toolchain (desktop target only)

`node-pty` is a native addon. `pnpm install` handles it on a clean checkout, but the
compiler toolchain has to be present if a prebuild is ever unavailable for your
platform:

| Platform | Needs |
| --- | --- |
| macOS | Xcode Command Line Tools — `xcode-select --install` |
| Linux | `build-essential` and `python3` |
| Windows | **Not supported.** See the gap below. |

**Windows is a known gap.** This epic targets macOS and Linux. Windows terminals go
through ConPTY/`winpty` rather than a POSIX pty, and `titleBarStyle: 'hiddenInset'`
(story 081) is not honoured there either. It is its own body of work, deliberately
not attempted here.

Two facts about the native module that produce unreadable errors when forgotten:

- **`node-pty@1.1.0` ships N-API prebuilds, so it does *not* need rebuilding for
  Electron.** N-API is ABI-stable across Node versions and across Electron. Verified
  on this tree: the same `prebuilds/darwin-arm64/pty.node` spawns a working PTY under
  plain Node (ABI 127) and under Electron 43 (ABI 148). Running `electron-rebuild`
  unconditionally would *replace* that portable prebuild with an ABI-locked one.
  `pnpm rebuild:pty` exists for the case that genuinely needs it — no prebuild for
  your platform (musl, some Linux arches), `node-pty` falls back to `node-gyp
  rebuild`, and that build *is* Node-ABI-locked.
- **The published `spawn-helper` has no executable bit.** `node-pty@1.1.0` ships
  `prebuilds/<platform>-<arch>/spawn-helper` as mode `0644` in the tarball itself, so
  every package manager reproduces it, and the package's own `post-install.js` only
  chmods `build/Release/` — which a prebuild install never populates. The symptom is
  `Error: posix_spawnp failed.` on the first spawn, *after* `require` has already
  succeeded. `postinstall` repairs it automatically; `pnpm check:abi --fix` repairs it
  by hand.

Vitest never loads the real module — `__mocks__/node-pty.ts` holds a recording fake.
A unit test that spawns real processes is a unit test that leaks them. Real terminal
semantics get their own runner under Electron's ABI:

```sh
pnpm test:pty                      # builds, then runs the conformance matrix
pnpm test:pty --filter signals     # one property group
```

`ELECTRON_RUN_AS_NODE=1` runs the Electron binary as a plain Node process — same ABI,
no window, no Chromium.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the Vite dev server — the **browser** target |
| `pnpm build` | Type-check, then produce a production build |
| `pnpm preview` | Serve the production build locally |
| `pnpm desktop:dev` | The **Electron** app, with renderer HMR |
| `pnpm desktop:build` | Type-check, then build `out/{main,preload,renderer}/` |
| `pnpm desktop:preview` | Run the built Electron app |
| `pnpm check:abi` | Diagnose the native toolchain; `--fix` repairs what it can |
| `pnpm rebuild:pty` | Rebuild `node-pty` against Electron's ABI (escape hatch) |
| `pnpm lint` | ESLint across `src/`, `electron/` and config files |
| `pnpm type-check` | `tsc --noEmit` for the app, the configs, and `electron/` |
| `pnpm test` | Vitest, single run |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm test:coverage` | Vitest with the coverage gate |
| `pnpm test:ui` | Vitest browser UI |
| `pnpm test:e2e` | Playwright end-to-end specs |

**`pnpm lint` and `pnpm type-check` must both pass before any task is considered done.**

The test scripts are wired up by story 013 (testing infrastructure); the script names
exist from the scaffold so the vocabulary never changes underneath anyone.

`pnpm test:e2e` runs Playwright against a **production build** — the config starts
`pnpm build && pnpm preview` itself, so no server needs to be running first. It
currently covers the shell smoke spec; the full suite (terminal, keyboard,
waiting-session, picker, simulation) lands with story 070 as the surfaces it drives
are built.

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

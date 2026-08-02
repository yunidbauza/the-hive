# 080 — Electron Scaffold (electron-vite)

| | |
|---|---|
| **ID** | HIVE-080 |
| **Epic** | Desktop shell |
| **Depends on** | [010-project-scaffold.md](010-project-scaffold.md), [014-architecture-boundaries.md](014-architecture-boundaries.md) |
| **Blocks** | [081](081-main-process-window.md), [082](082-preload-ipc-security.md), [083](083-runtime-target-transport.md), [084](084-native-modules-dev-workflow.md), [085](085-electron-test-harness.md) |
| **Points** | 5 |
| **Location** | `app/electron/`, `app/electron.vite.config.ts`, `app/package.json` |
| **Architecture reference** | this repo — `app/vite.config.ts`, `app/eslint.config.mjs` |

## Story

> As a developer, I want the existing Vite app to build as an Electron application
> **without moving a single file under `src/`**, so the renderer we already shipped
> becomes the desktop app's UI rather than a thing we port to one.

This story adds a second and third build target. It does not change the app.

## Why in-place, and not a monorepo

The alternative — `apps/renderer` + `apps/desktop` + `packages/ipc-contract` — is a
cleaner long-term boundary and was considered. It was rejected for this epic because it
relocates every file in the repo, and everything that makes this codebase enforceable
is **path-coupled**: the ESLint import zones in `eslint.config.mjs`, the three alias
declaration sites, the `tests/` mirror ([013](013-testing-infrastructure.md)), and the
`check-file` kebab-case rules. A move costs all of that on day one and buys nothing the
epic needs.

`electron/` as a sibling of `src/` keeps every existing fence intact and adds new ones.

## Layout

```
app/
├─ electron/
│  ├─ main/
│  │  ├─ index.ts               # entry — app lifecycle only (081)
│  │  ├─ window.ts              # BrowserWindow factory (081)
│  │  └─ ipc/                   # channel handlers (082)
│  ├─ preload/
│  │  └─ index.ts               # contextBridge surface (082)
│  └─ shared/
│     └─ ipc-contract.ts        # types + channel names — imported by BOTH sides
├─ src/                         # UNCHANGED
├─ tests/
│  ├─ electron/                 # mirrors electron/ (013's rule, extended)
│  └─ …
├─ electron.vite.config.ts      # main + preload + renderer
├─ vite.config.ts               # browser-only target, kept (083)
├─ vite.aliases.mjs             # single alias definition, imported by both
├─ tsconfig.json                # renderer (DOM)
├─ tsconfig.node.json           # main + preload + configs (Node)
└─ package.json
```

`electron/shared/` is **types and constants only** — no runtime imports, no Node APIs,
no DOM APIs. It is the one module both processes may import, which is what makes the
IPC contract a compile-time artifact instead of a convention ([082](082-preload-ipc-security.md)).

## The alias problem gets worse before it gets better

`AGENTS.md` currently states aliases live in **three** places (`tsconfig.json`,
`vite.config.ts`, `vitest.config.ts`). Adding `electron.vite.config.ts` would make it
four, and four hand-synced copies is a defect waiting to happen.

Fix it in this story rather than propagating it: extract the alias map to a single
`vite.aliases.mjs`, and have every config import it.

```js
// vite.aliases.mjs — the ONLY place a renderer alias is declared
import { fileURLToPath, URL } from 'node:url';

const srcPath = (segment = '') =>
  fileURLToPath(new URL(`./src/${segment}`, import.meta.url));

export const aliases = {
  '@components': srcPath('components'),
  '@features':   srcPath('features'),
  '@stores':     srcPath('stores'),
  '@config':     srcPath('config'),
  '@hooks':      srcPath('hooks'),
  '@utils':      srcPath('utils'),
  '@types':      srcPath('types'),
  '@lib':        srcPath('lib'),
  '@shared':     fileURLToPath(new URL('./electron/shared/', import.meta.url)),
  '@':           srcPath(),
};
```

`tsconfig.json` still declares its own `paths` (TypeScript cannot import a JS module for
config), so the count drops from four to two — and `pnpm verify:boundaries` gains a
check that the two agree. `@shared` is new: it is how the renderer reaches the IPC
contract types without reaching into the main process.

## `electron.vite.config.ts`

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { aliases } from './vite.aliases.mjs';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: 'electron/main/index.ts' } },
    resolve: { alias: aliases },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: 'electron/preload/index.ts' } },
    resolve: { alias: aliases },
  },
  renderer: {
    root: '.',
    plugins: [react(), tailwindcss()],
    resolve: { alias: aliases },
    build: { rollupOptions: { input: 'index.html' } },
  },
});
```

`externalizeDepsPlugin()` is load-bearing on the main and preload targets: it leaves
`dependencies` unbundled. Bundling a native module is not a thing that works, and
`node-pty` arrives in [092](092-pty-session-manager.md).

## Versions

Pinned deliberately, verified against the npm registry rather than recalled:

| Package | Version | Role |
|---|---|---|
| `electron` | `43.2.0` | devDependency — never a runtime dep |
| `electron-vite` | `5.0.0` | the three-target build |

`electron` is a **devDependency**. It ships as the runtime via the packager, not via
`node_modules`; listing it as a dependency is a common mistake that bloats every
future build.

## Scripts

```jsonc
{
  "main": "out/main/index.js",
  "scripts": {
    "dev":            "vite",                    // browser target, unchanged
    "build":          "pnpm type-check && vite build",
    "desktop:dev":    "electron-vite dev",
    "desktop:build":  "pnpm type-check && electron-vite build",
    "desktop:preview":"electron-vite preview"
  }
}
```

The existing `dev`/`build` keep working and keep meaning the browser target
([083](083-runtime-target-transport.md)). Nothing in the current developer's muscle
memory breaks.

## ESLint zones

Three new rules in `eslint.config.mjs`, in the same `import/no-restricted-paths` style
as [014](014-architecture-boundaries.md):

| Target | May **not** import from | Why |
|---|---|---|
| `electron/main/**` | `src/**` | the main process has no renderer, no DOM, no store |
| `electron/preload/**` | `src/**`, `electron/main/**` | preload is a bridge, not a participant |
| `src/**` | `electron/main/**`, `electron/preload/**` | the renderer may only see `@shared` |

`electron/shared/**` is importable from all three and may import from none of them.

`check-file` kebab-case coverage extends to `electron/**`. `verify-boundaries.mjs`
gains a fixture per new zone — a zone with no proof is a zone that silently stopped
firing.

## Acceptance criteria

- [ ] `pnpm desktop:dev` opens an Electron window rendering the existing app, with HMR
      working on `src/` edits.
- [ ] `pnpm dev` still serves the browser target unchanged; `pnpm build` still passes.
- [ ] `pnpm desktop:build` produces `out/main/`, `out/preload/`, `out/renderer/`.
- [ ] `pnpm lint`, `pnpm type-check` and `pnpm test` are green with zero changes to any
      file under `src/`. Prove the last clause with `git diff --stat -- app/src` being
      empty.
- [ ] `pnpm verify:boundaries` fails when a fixture violates each of the three new
      zones, and passes otherwise.
- [ ] The alias map exists in exactly two places (`vite.aliases.mjs`, `tsconfig.json`)
      and `verify:boundaries` asserts they agree.
- [ ] `AGENTS.md`'s "three places" paragraph is corrected to describe the new
      arrangement.

## Out of scope

- Window chrome, menus, lifecycle — [081](081-main-process-window.md).
- Any IPC channel — [082](082-preload-ipc-security.md).
- Packaging, installers, code signing, auto-update — a later epic entirely.
- `node-pty` and native rebuilds — [084](084-native-modules-dev-workflow.md).

# 084 — Native Modules & Dev/Build Workflow

| | |
|---|---|
| **ID** | HIVE-084 |
| **Epic** | Desktop shell |
| **Depends on** | [080-electron-scaffold.md](080-electron-scaffold.md) |
| **Blocks** | [092](092-pty-session-manager.md), [098](098-pty-conformance-suite.md), [099](099-desktop-ci.md) |
| **Points** | 3 |
| **Location** | `app/package.json`, `app/.npmrc`, `app/scripts/` |

## Story

> As a developer, I want `pnpm install && pnpm desktop:dev` to just work on a clean
> checkout with a native module in the tree, so nobody loses an afternoon to an ABI
> mismatch that produces an error message naming neither Electron nor node-pty.

Every project that puts a real terminal in Electron pays this tax once. This story pays
it deliberately, before [092](092-pty-session-manager.md) needs it, so that story is
about PTYs rather than about toolchains.

## The problem, stated precisely

`node-pty` is a native addon. It compiles against a specific **`NODE_MODULE_VERSION`**
(the ABI), and Electron's bundled Node is built with a different one than the `node` on
your `PATH`.

`node-pty@1.1.0`'s install script is:

```
"install": "node scripts/prebuild.js || node-gyp rebuild"
```

So it does ship prebuilt binaries — **for the Node ABI**. Loading that binary inside
Electron fails at `require` time with `ERR_DLOPEN_FAILED` and a message about a module
being "compiled against a different Node.js version", which reads like a Node version
problem and is not one.

Three separate consequences, each needing a decision:

## 1. pnpm 10 does not run install scripts by default

The repo pins `pnpm@10.2.1`. Since pnpm 10, lifecycle scripts of dependencies are
**blocked unless allowlisted** — a supply-chain default, and the right one. Without the
allowlist, `node-pty` installs with no binary at all and fails with `MODULE_NOT_FOUND`
rather than an ABI error, which sends you looking in the wrong place.

```jsonc
// package.json
"pnpm": {
  "onlyBuiltDependencies": ["node-pty"]
}
```

Every entry added here is a package granted arbitrary code execution at install time.
The list stays minimal and every addition is justified in review.

## 2. The binary must be rebuilt for Electron's ABI

`@electron/rebuild@4.2.0`, run after install:

```jsonc
"scripts": {
  "postinstall":  "electron-rebuild --force --only node-pty",
  "rebuild:pty":  "electron-rebuild --force --only node-pty"
}
```

`--only node-pty` matters: an unscoped `electron-rebuild` walks every dependency and
takes minutes on a tree this size, for one native module.

`electron-rebuild` reads the installed `electron` version to pick headers, which is why
[080](080-electron-scaffold.md) keeps `electron` a devDependency at a pinned version. A
floating range here means a silent ABI change on an unrelated install.

Toolchain prerequisites — Xcode CLT on macOS, build-essential + python3 on Linux,
VS Build Tools on Windows — go in `app/README.md`. The Windows story is the worst of
the three and this epic does not attempt it ([099](099-desktop-ci.md) pins CI to macOS
and Linux); recording that as a known gap is the honest move.

## 3. One binary, two ABIs, two test runners

This is the consequence people discover last and it shapes the whole test strategy
([085](085-electron-test-harness.md), [098](098-pty-conformance-suite.md)).

After `postinstall`, `node_modules/node-pty` holds an **Electron-ABI** binary. Vitest
runs on plain `node`. Therefore:

- **Vitest can never `require('node-pty')` for real.** Main-process unit tests mock it —
  the same rule `AGENTS.md` already states for xterm in the renderer, for the same
  reason and with a different mechanism. `__mocks__/node-pty.ts` holds a recording fake
  and tests assert plumbing: spawn arguments, cwd, write/resize/kill routing, exit
  handling.
- **Real-PTY tests must run under Electron's Node**, via:

  ```
  ELECTRON_RUN_AS_NODE=1 electron scripts/run-pty-conformance.mjs
  ```

  `ELECTRON_RUN_AS_NODE=1` runs the Electron binary as a plain Node process — same ABI,
  no window, no Chromium. It is what makes [098](098-pty-conformance-suite.md) possible
  without booting a UI, and it is the single most useful thing in this story.

Both facts get written into `docs/desktop-architecture.md`
([085](085-electron-test-harness.md) creates it), because the failure mode when
forgotten is an unreadable error at `require` time.

## Bundling

`externalizeDepsPlugin()` from [080](080-electron-scaffold.md) keeps `node-pty` out of
the main bundle; a bundler cannot inline a `.node` file. In dev and in an unpackaged
build it resolves from `node_modules` normally.

Packaging is a later epic, but record the constraint now so it is not rediscovered:
the `.node` binary must be **unpacked from the asar** (`asarUnpack`), because
`dlopen` cannot load from inside an archive.

## Dev loop

| Command | Behaviour |
|---|---|
| `pnpm desktop:dev` | electron-vite: renderer HMR; main/preload changes restart Electron |
| `pnpm rebuild:pty` | after an Electron version bump, or a confusing `dlopen` failure |
| `pnpm dev` | browser target, no native module involved at all |

A `scripts/check-native-abi.mjs` runs as part of `desktop:dev` and prints one
actionable line — *"node-pty was built for ABI X, this Electron needs Y — run
`pnpm rebuild:pty`"* — instead of letting the raw `dlopen` error be the first thing a
new contributor sees.

## Tests

- `check-native-abi.mjs` is unit-tested against synthetic ABI pairs (match, mismatch,
  binary absent) and asserts the exact remediation string.
- A test asserts `onlyBuiltDependencies` contains `node-pty` — the guard against
  someone "cleaning up" package.json and breaking every clean install.
- A test asserts `electron` appears in `devDependencies` and not `dependencies`.

## Acceptance criteria

- [ ] On a clean checkout, `pnpm install && pnpm desktop:dev` opens the app with no
      manual rebuild step.
- [ ] `node_modules/node-pty` contains a binary whose ABI matches the pinned Electron;
      `check-native-abi.mjs` exits 0.
- [ ] Deliberately corrupting the ABI produces the actionable message, not a raw
      `dlopen` error.
- [ ] `pnpm test` passes with `node-pty` mocked and never loads the real binary.
- [ ] `ELECTRON_RUN_AS_NODE=1 electron -e "require('node-pty')"` succeeds.
- [ ] `pnpm dev` and `pnpm build` (browser) are unaffected.
- [ ] `app/README.md` documents the per-platform toolchain prerequisites and the
      Windows gap.

## Out of scope

- Packaging, asar, signing, notarisation, auto-update — a later epic.
- Windows support. Recorded as a known gap; `winpty`/ConPTY is its own body of work.
- Prebuild caching in CI — [099](099-desktop-ci.md).

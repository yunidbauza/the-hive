# 085 — Electron Test Harness (Playwright `_electron`)

| | |
|---|---|
| **ID** | HIVE-085 |
| **Epic** | Desktop shell |
| **Depends on** | [081-main-process-window.md](081-main-process-window.md), [084-native-modules-dev-workflow.md](084-native-modules-dev-workflow.md), [070-e2e-harness.md](070-e2e-harness.md) |
| **Blocks** | [095](095-interactive-terminal-surface.md), [097](097-orchestrator-drives-ptys.md), [098](098-pty-conformance-suite.md), [099](099-desktop-ci.md) |
| **Points** | 8 |
| **Location** | `app/playwright.config.ts`, `app/tests/e2e/`, `app/docs/desktop-architecture.md` |

## Story

> As a developer, I want to drive the **real Electron application** in tests — its
> window, its menus, its main process — so that "it works in the browser build" stops
> being mistaken for "the desktop app works."

## The strategy, and why Playwright is still the answer

The reflex when a web app becomes a desktop app is that Playwright no longer applies.
That is half right: Playwright is the wrong tool for the *lowest* layer and remains the
right tool for the highest. Three layers, split by what each can actually prove.

| Layer | Runner | ABI / process | Proves |
|---|---|---|---|
| **Main-process unit** | Vitest, node env, `node-pty` mocked | plain Node | spawn arguments, cwd resolution, IPC routing, guards, teardown |
| **PTY conformance** | `ELECTRON_RUN_AS_NODE=1 electron` | Electron ABI, no window | *terminal semantics*: signals, resize, alt-screen, exit codes — [098](098-pty-conformance-suite.md) |
| **Electron e2e** | Playwright `_electron` | full app | window chrome, menus, the UI wired to a live PTY |

The middle layer is the one that does not exist in a web project and is the reason the
naive answer ("just keep using Playwright") is insufficient. Whether Ctrl-C delivers
`SIGINT` to the foreground process group is not a UI question; asserting it through a
browser driver is slow, flaky, and indirect. It gets its own story.

The top layer is where Playwright earns its place: `_electron` launches the actual built
app and gives you both the renderer *and* a handle on the main process.

### WebdriverIO, considered and declined

`@wdio/electron-service@10.1.0` is the more purpose-built option — automatic binary path
detection for Forge and electron-builder, mocking of Electron APIs, and the mature
successor to Spectron. It is a genuinely good tool.

It is declined because this repo already owns a Playwright config, six specs
([070](070-e2e-harness.md)), a selector policy, and a CI shape. Adopting a second
runner to gain path detection — a `join()` call — would mean two harnesses, two
reporters and two flake budgets. The trade is not worth it while the Electron surface
is one window.

Recorded as a **revisit trigger**: if packaging (later epic) makes locating the built
binary genuinely painful across three platforms, or if Playwright's Electron support
regresses, `@wdio/electron-service` is the first alternative to evaluate.

### One honest caveat

Playwright's Electron support is officially **experimental**. Mitigations, not
hand-waving: pin `@playwright/test` exactly rather than by range; keep the used API
surface small (`launch`, `firstWindow`, `evaluate`, `close`); and confine every call
into it to the fixture below, so a breaking change is a one-file fix rather than a
suite-wide one.

## Config: two projects

`playwright.config.ts` gains a second project. The existing one is renamed but not
otherwise touched.

```ts
projects: [
  {
    name: 'web',                       // unchanged behaviour — 070's suite
    testDir: './tests/e2e/web',
    use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  },
  {
    name: 'electron',
    testDir: './tests/e2e/electron',
    use: {},                           // no baseURL, no browser — the fixture launches the app
  },
],
```

The `webServer` block stays scoped to the `web` project. The `electron` project must
**not** start a Vite server: it runs the built app, which serves its renderer from
`out/renderer/`.

Existing specs move from `tests/e2e/` to `tests/e2e/web/` with no content change — a
pure `git mv`, verifiable as such in review.

## The fixture

Everything Electron-specific is confined here.

```ts
// tests/e2e/electron/fixtures/hive-app.ts
export const test = base.extend<{ hive: ElectronApplication; page: Page }>({
  hive: async ({}, use, testInfo) => {
    const app = await electron.launch({
      args: [
        path.join(__dirname, '../../../../out/main/index.js'),
        `--user-data-dir=${testInfo.outputPath('user-data')}`,
      ],
      env: {
        ...process.env,
        HIVE_E2E: '1',
        HIVE_CONFIG_PATH: testInfo.outputPath('hive-config.json'),
      },
    });
    await use(app);
    await app.close();
  },
  page: async ({ hive }, use) => use(await hive.firstWindow()),
});
```

Three isolation properties, each load-bearing:

- **A per-test `userData` directory**, via Electron's own `--user-data-dir` switch
  rather than an environment variable the main process would have to be taught to read.
  Window state persists ([081](081-main-process-window.md)); sharing the real directory
  means test order changes results and a local run pollutes the developer's actual
  window position.
- **A per-test config path.** `HIVE_CONFIG_PATH` overrides `~/.hive/config.json`
  ([090](090-workspace-config.md)) so specs point at a scratch fixture repo and never
  at the developer's real projects. A test suite that can spawn `claude` in a real
  working tree is a test suite that can commit to it.
- **`HIVE_E2E=1`** disables the simulation clock and any animation-driven timing, the
  same determinism concern `?sim=0` handles for the web project
  ([061](061-simulation-mode.md)).

The `electron` project depends on the build: `pnpm desktop:build` must have run.
Enforce it with a Playwright `globalSetup` that builds if `out/main/index.js` is
missing or stale, rather than a README instruction.

## Spec suite

```
tests/e2e/
  web/                       # 070's suite, moved verbatim
  electron/
    fixtures/hive-app.ts
    launch.spec.ts           # app boots, one window, correct title, no white flash
    chrome.spec.ts           # no native title bar; header is a drag region
    window-state.spec.ts     # resize → quit → relaunch → geometry restored
    menu.spec.ts             # Cmd+C copies a terminal selection
    security.spec.ts         # main-process assertions, see below
    session-pty.spec.ts      # the payoff — lands with 096
```

### `security.spec.ts` — what only `_electron` can assert

`app.evaluate()` runs in the **main process**, which is how the security posture from
[082](082-preload-ipc-security.md) becomes a test rather than a code review note:

```ts
const prefs = await hive.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
expect(prefs.contextIsolation).toBe(true);
expect(prefs.nodeIntegration).toBe(false);
expect(prefs.sandbox).toBe(true);
```

Plus, from the renderer side: `window.hive` exposes only the documented verbs, and
`ipcRenderer`, `require` and `process` are all unreachable.

### `session-pty.spec.ts` — the one that matters

Lands with [096](096-session-lifecycle-claude.md), specified here so the harness is
built to support it: open a session against the fixture repo, wait for a shell prompt,
type `echo hive-ok`, assert the output appears in the terminal, assert the working
directory is the fixture repo, close the app and assert no orphaned child process
survives.

That last clause needs the main process, so it is `app.evaluate()` again — and it is the
assertion that catches the failure mode where quitting the app leaves `claude` running
in the background forever.

## Reading the terminal in a spec

The gotchas from `docs/terminal-architecture.md` carry over and are worth restating,
because they cost time when rediscovered:

- xterm 6 uses the **DOM renderer**; there is no canvas to screenshot for content.
- `.xterm-viewport` does not scroll natively and reports `scrollHeight === clientHeight`
  at every position. Read the rendered `.xterm-rows > div` text — which lines are on
  screen is the only honest observable.
- With a real PTY, output is **asynchronous and chunked**. Every assertion is a
  Playwright `expect.poll` / web-first assertion against accumulated row text, never a
  single read after a fixed timeout. A `waitForTerminalText(page, /hive-ok/)` helper
  lives in the fixtures and is the only way specs read the terminal.

## Docs

Create `app/docs/desktop-architecture.md` — the deep-dive `AGENTS.md` routes to for
"the main process, IPC, PTYs, packaging", alongside the existing terminal/state/component
deep-dives. It carries: the process diagram, the IPC contract summary, the three-layer
test table above, and the two ABI facts from [084](084-native-modules-dev-workflow.md)
that produce unreadable errors when forgotten.

Add the row to `AGENTS.md`'s deep-dive table.

## Acceptance criteria

- [ ] `pnpm test:e2e --project=web` runs the six existing specs green, unmodified.
- [ ] `pnpm test:e2e --project=electron` launches the built app and runs the suite green.
- [ ] `globalSetup` builds the app when `out/` is missing or stale.
- [ ] `security.spec.ts` fails if any of the three `webPreferences` flags regresses.
- [ ] Each test gets its own `userData` and config path; running the suite twice in a
      row gives identical results and leaves the developer's `~/.hive/` untouched.
- [ ] `window-state.spec.ts` survives a real quit-and-relaunch cycle.
- [ ] Electron-specific API calls appear only in `fixtures/hive-app.ts`.
- [ ] Suite is deterministic across 5 consecutive runs — record them, per
      [070](070-e2e-harness.md)'s standard.
- [ ] `docs/desktop-architecture.md` exists and `AGENTS.md` routes to it.

## Out of scope

- Real-PTY semantics — [098](098-pty-conformance-suite.md).
- CI wiring, xvfb, runner matrix — [099](099-desktop-ci.md).
- Testing a packaged/signed artifact — a later epic.

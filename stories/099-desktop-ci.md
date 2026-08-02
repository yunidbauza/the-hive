# 099 — Desktop CI

| | |
|---|---|
| **ID** | HIVE-099 |
| **Epic** | Real terminals |
| **Depends on** | [071-ci-workflow.md](071-ci-workflow.md), [085-electron-test-harness.md](085-electron-test-harness.md), [098-pty-conformance-suite.md](098-pty-conformance-suite.md), [084-native-modules-dev-workflow.md](084-native-modules-dev-workflow.md) |
| **Blocks** | — |
| **Points** | 3 |
| **Location** | `app/.github/workflows/ci.yml` |

## Story

> As a developer, I want the desktop build, the PTY conformance suite and the Electron
> e2e specs to run on every pull request, so "the browser build is green" can never
> again be mistaken for "the app works."

## Extending, not replacing

[071](071-ci-workflow.md)'s three jobs — `quality`, `test`, `e2e` — keep their current
shape and stay blocking. Three jobs are added.

| Job | Runs | Runner | Blocking |
|---|---|---|---|
| `quality` | lint, type-check | ubuntu | yes |
| `test` | `test:coverage` (80% gate) | ubuntu | yes |
| `e2e` | Playwright `--project=web` | ubuntu | yes |
| **`desktop-build`** | `pnpm desktop:build` | macos + ubuntu | yes |
| **`pty`** | `pnpm test:pty` | macos + ubuntu | yes |
| **`desktop-e2e`** | Playwright `--project=electron` | macos | yes |

`e2e` gains `--project=web` because [085](085-electron-test-harness.md) split the
config into two projects. Without the flag it would try to launch Electron on a runner
that may have no display, and the failure would look like a Playwright bug.

## The runner matrix, and why it is not three platforms

**macOS is the primary target** — it is the platform the app is developed on and the
one `titleBarStyle: 'hiddenInset'` ([081](081-main-process-window.md)) is designed for.
`desktop-e2e` runs there and only there; it is the job that asserts window chrome.

**Linux runs `desktop-build` and `pty`** because they are cheap there and catch
portability regressions early — a missing `#include`, a hardcoded `/bin/zsh`, a path
separator assumption.

**Windows is not in the matrix.** [084](084-native-modules-dev-workflow.md) records it
as a known gap: `node-pty` needs the MSVC toolchain, ConPTY behaves differently from a
Unix pty, and the app has no Windows chrome story. Adding a red job that nobody is
scheduled to fix teaches the team to ignore red jobs. When Windows becomes a target it
gets its own story and its own conformance expectations.

## Native modules in CI

The expensive and fragile part, and the reason this story is not one line of YAML.

```yaml
- uses: actions/cache@v4
  with:
    path: |
      app/node_modules/node-pty/build
      ~/.electron-gyp
    key: pty-${{ runner.os }}-${{ hashFiles('app/pnpm-lock.yaml') }}-electron-${{ env.ELECTRON_VERSION }}
```

Three things the key has to contain, each learned the hard way:

- **The lockfile hash** — a `node-pty` bump must rebuild.
- **The Electron version** — the ABI is what the binary is compiled against
  ([084](084-native-modules-dev-workflow.md)). A cache that survives an Electron bump
  restores a binary that cannot load, and the error names neither package.
- **The runner OS** — a `.node` file is not portable.

`ELECTRON_VERSION` is read from the lockfile in a setup step rather than hardcoded, so
the key cannot drift from reality.

Linux needs `libxkbcommon`, `libgtk-3` and friends for Electron even in
`ELECTRON_RUN_AS_NODE` mode. Install them explicitly; do not rely on the runner image.

## Display

`desktop-e2e` runs on macOS, which has a real display session — no `xvfb` needed, which
is the main reason to put it there rather than on Linux.

`pty` needs no display at all: `ELECTRON_RUN_AS_NODE=1` starts no Chromium
([098](098-pty-conformance-suite.md)). If it ever appears to need one, something has
regressed into loading the app rather than the session manager.

## Guarding the process-leak assertion

CI runners are ephemeral, so a leaked process would normally vanish unnoticed — exactly
the wrong environment for the assertion that matters most
([098](098-pty-conformance-suite.md)).

Make it explicit: after `pty` and `desktop-e2e`, an `always()` step counts descendant
processes and fails the job if any survive. On a fresh runner the expected count is
zero, which makes this assertion *stronger* in CI than locally.

## Timing and cost

macOS runners are billed at a multiple of Linux. Mitigations, in order of value:

- Keep `quality`/`test`/`e2e` on Linux — unchanged from [071](071-ci-workflow.md).
- The native-module cache above, which removes the dominant cost of the macOS jobs.
- `concurrency` with `cancel-in-progress: true` extended to the new jobs.
- `desktop-e2e` runs the Electron project only; the web suite already ran on Linux.

Budget: the pipeline stays under **15 minutes** wall clock (up from 8 — the desktop
jobs are genuinely more work, and a target nobody can hit gets ignored).

## Acceptance criteria

- [ ] A pull request shows all six checks; all pass on a clean branch.
- [ ] Deleting the `TERM` option in [092](092-pty-session-manager.md) fails `pty` with
      the named conformance test. Record the failing run, then revert.
- [ ] Flipping `contextIsolation` to `false` fails `desktop-e2e` via
      [085](085-electron-test-harness.md)'s security spec. Record, then revert.
- [ ] A leaked child process fails the descendant-count step.
- [ ] A cold cache builds `node-pty`; a warm cache skips it and is measurably faster.
- [ ] Bumping Electron invalidates the cache and triggers a rebuild.
- [ ] `desktop-build` produces `out/main`, `out/preload`, `out/renderer` on both OSes.
- [ ] Full pipeline under 15 minutes.
- [ ] All three original [071](071-ci-workflow.md) jobs keep their behaviour.

## Out of scope

- Windows. Recorded as a known gap.
- Building, signing, notarising or publishing installers — the packaging epic.
- Release automation, auto-update feeds, crash reporting.
- Running the conformance suite against the real `claude` binary — CI has no
  authenticated session, and [098](098-pty-conformance-suite.md) uses a stub for that
  reason.

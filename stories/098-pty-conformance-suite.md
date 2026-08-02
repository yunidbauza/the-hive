# 098 — PTY Conformance Suite

| | |
|---|---|
| **ID** | HIVE-098 |
| **Epic** | Real terminals |
| **Depends on** | [092-pty-session-manager.md](092-pty-session-manager.md), [096-session-lifecycle-claude.md](096-session-lifecycle-claude.md), [085-electron-test-harness.md](085-electron-test-harness.md) |
| **Blocks** | [099](099-desktop-ci.md) |
| **Points** | 8 |
| **Location** | `app/tests/conformance/`, `app/scripts/run-pty-conformance.mjs` |

## Story

> As a developer, I want an executable answer to *"is this a real terminal?"*, so the
> product's central claim is a test that runs in CI rather than an impression someone
> formed by opening `vim` once.

## Why this layer exists

[085](085-electron-test-harness.md) establishes three test layers. This is the middle
one, and it is the layer a web project never needs.

The claim being tested is not "the UI renders output". It is that a process running
inside The Hive has a **controlling terminal with correct semantics** — signals arrive,
`SIGWINCH` fires, `isatty()` is true, the environment is clean. Those are kernel-level
properties of the pty, and the two neighbouring layers cannot prove them:

- **Vitest cannot** — `node-pty` is mocked there, and it must be, because the binary is
  built for Electron's ABI ([084](084-native-modules-dev-workflow.md)). A mock asserts
  that `resize()` was called; it cannot assert that a signal was delivered.
- **Playwright should not** — every assertion would round-trip through IPC, xterm's
  parser and the DOM, turning a signal-delivery question into a text-scraping question
  with a timeout attached. Slow, indirect, and flaky for reasons unrelated to what is
  being tested.

So: real PTYs, real child processes, no UI.

## The runner

```
ELECTRON_RUN_AS_NODE=1 electron scripts/run-pty-conformance.mjs
```

`ELECTRON_RUN_AS_NODE=1` runs the Electron binary as a plain Node process — Electron's
ABI, so the rebuilt `node-pty` loads, but no Chromium, no window, no display. This is
what makes the layer cheap enough to run on every push.

It drives the **real session manager** from [092](092-pty-session-manager.md), not a
reimplementation. A suite that talks to its own pty wrapper proves that wrapper works
and nothing about the product.

Wired as `pnpm test:pty`.

### Determinism

Real processes need real discipline:

- Every assertion is a **predicate polled to a deadline**, never a fixed sleep. Helper:
  `waitFor(() => output.includes('…'), { timeout: 5000 })`.
- Each test gets a scratch directory under the OS temp dir, created and removed per
  test — never the repo, never `$HOME`.
- Every test kills its session in teardown and asserts the pid is gone, so a leak fails
  the test that caused it rather than a later one.
- `sh`, not the user's `$SHELL`, wherever the shell's identity is not the subject —
  `zsh` and `bash` differ in prompt behaviour and startup output, and a suite that
  passes only on the author's machine is worthless.

## The matrix

Each row is a property that separates a real terminal from a text widget.

### Identity

| Assertion | Method |
|---|---|
| `isatty` is true | `sh -c 'test -t 0 && echo TTY'` → `TTY` |
| `TERM` is `xterm-256color` | `echo $TERM` |
| `COLORTERM` is `truecolor` | `echo $COLORTERM` |
| a real device is attached | `tty` prints a `/dev/ttys*` path |
| cwd is the requested directory | `pwd` matches the scratch dir |

### Environment hygiene

| Assertion | Method |
|---|---|
| `ELECTRON_RUN_AS_NODE` is not inherited | `sh -c 'echo "[$ELECTRON_RUN_AS_NODE]"'` → `[]` |
| no `ELECTRON_*` leaks | `env \| grep ^ELECTRON_` is empty |
| `NODE_OPTIONS` is not inherited | `echo "[$NODE_OPTIONS]"` → `[]` |
| the user's own variables survive | a variable set on the spawn env is visible |

The first row is the one that catches a whole class of confusing downstream bugs
([092](092-pty-session-manager.md)) and would otherwise be found in production.

### Signals and job control

| Assertion | Method |
|---|---|
| Ctrl-C interrupts the foreground job | start `sleep 100`, write `\x03`, prompt returns |
| `SIGINT` hits the job, not the shell | after the interrupt the shell still responds |
| Ctrl-D at a prompt exits the shell | write `\x04`, expect an exit event |
| Ctrl-Z suspends; `fg` resumes | `\x1a` then `fg` |
| the process group is killable | kill → no descendant pid survives |

Ctrl-C is the headline. It is the assertion most likely to silently regress — a change
in how bytes are forwarded turns `\x03` into three literal characters, and every other
test still passes.

### Resize

| Assertion | Method |
|---|---|
| resize changes the child's view | `resize(100, 30)` → `stty size` prints `30 100` |
| `SIGWINCH` is delivered | a `trap WINCH` handler fires on resize |
| zero-size resizes are dropped | `resize(0, 0)` → geometry unchanged, no crash |

### Rendering fidelity

| Assertion | Method |
|---|---|
| 8-colour SGR round-trips | `printf '\033[31mRED\033[0m'` → exact bytes out |
| 24-bit colour round-trips | `printf '\033[38;2;143;181;255m…'` — the app's palette |
| alternate screen enter/exit | `tput smcup` / `rmcup` emit `?1049h` / `?1049l` |
| cursor addressing survives | `tput cup 5 10` |
| UTF-8 across a chunk boundary | emit a large multi-byte payload; no `U+FFFD` |
| wide characters keep width | CJK and emoji round-trip |

The UTF-8 row is the direct test of the `StringDecoder` in
[092](092-pty-session-manager.md) — a defect invisible until someone's box-drawing
output shows replacement characters.

### Throughput and backpressure

| Assertion | Method |
|---|---|
| a firehose does not lose bytes | emit 5 MB with a checksum; compare |
| backpressure engages | with a slow consumer, `pause()` is observed |
| output is ordered | a monotonic counter arrives in order with no gaps |

### Lifecycle

| Assertion | Method |
|---|---|
| exit code propagates | `exit 42` → `exitCode: 42` |
| signal death is reported | `kill -TERM` → the signal is reported |
| output before exit is not truncated | print, then exit immediately; the print arrives |
| host crash marks sessions lost | kill the pty host; sessions report `crashed`, app survives |
| **no orphans on shutdown** | spawn 5, shut down, assert every descendant pid is gone |

The last row is the most important assertion in the epic. Its failure mode is a `claude`
process still running after the app is closed — invisible, consuming tokens, able to
write to the repository ([096](096-session-lifecycle-claude.md)).

### The integration assertion

One test spawns the **real bootstrap** — `$SHELL -l`, then `claudeCommand` — against a
scratch git repo, and asserts the shell survives the command exiting.

`claude` may not be installed or authenticated in every environment, so the test uses a
stub binary on `PATH` named per config, which prints a banner and exits 0. That keeps
the assertion about *the bootstrap sequence* — timing, echo, shell survival — rather
than about Claude Code, which is not this repo's software to test. The real binary is
exercised manually and in [085](085-electron-test-harness.md)'s desktop spec.

## Reporting

Plain TAP-ish output plus a summary table, so a CI failure names the property that broke
(`signals › ctrl-c interrupts foreground job`) rather than a line number. `--filter`
runs one group locally.

## Acceptance criteria

- [ ] `pnpm test:pty` runs the full matrix green on macOS and Linux.
- [ ] The suite drives the real [092](092-pty-session-manager.md) manager.
- [ ] No test uses a fixed sleep; all use polled predicates with deadlines.
- [ ] Every test cleans up its session and scratch directory; the suite leaves no
      processes and no temp files.
- [ ] Deliberately breaking `TERM`, dropping `\x03` forwarding, removing the
      `StringDecoder`, or skipping process-group kill each fails a **named** test.
- [ ] Total wall clock under 90 seconds.
- [ ] 5 consecutive runs, no flakes — recorded, per [070](070-e2e-harness.md)'s standard.
- [ ] Runs headless with no display server.

## Out of scope

- Windows / ConPTY.
- Testing Claude Code itself.
- Performance benchmarking beyond the throughput assertion.
- Terminal emulator quirks the app does not claim (sixel, kitty graphics).

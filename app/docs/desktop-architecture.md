# Desktop architecture

The main process, the IPC bridge, and how the desktop app is tested.
Load this when working on `electron/`, the preload bridge, native modules, or
the Electron e2e suite.

Terminals and transports: [`terminal-architecture.md`](terminal-architecture.md).

## Two targets, one renderer

```
                       ┌─────────────────────────────┐
                       │  src/  (UNCHANGED renderer)  │
                       └──────────────┬───────────────┘
                                      │
              ┌───────────────────────┴────────────────────────┐
              │                                                │
   vite.config.ts (browser)                    electron.vite.config.ts (desktop)
      base: '/'                                   base: './'  ← file:// needs it
      demo surface                                main + preload + renderer
              │                                                │
      pnpm dev / build                         pnpm desktop:dev / desktop:build
```

**Electron is the product.** The browser build survives as a fixtures-only demo
surface, and it must degrade visibly — the `demo` chip and the message-row
placeholder are how (story 083). It will never have real terminals.

`src/` is not moved, wrapped, or forked. `electron/` is a sibling, which is what
keeps every ESLint import zone, alias site and `tests/` mirror intact.

## Processes

| | Runs | May import | Never |
|---|---|---|---|
| `electron/main/**` | Node, full privilege | `electron/shared/**` | `src/**` |
| `electron/preload/**` | renderer, sandboxed | `electron/shared/**` | `src/**`, `electron/main/**` |
| `src/**` | renderer | `@shared` (**type-only**) | `electron/main/**`, `electron/preload/**` |

`electron/shared/**` is types and constants only — no runtime imports, no Node
APIs, no DOM APIs. It is the one module both sides may import, which makes the
IPC contract a compile-time artifact instead of a convention. All three zones are
ESLint-enforced and proved by `pnpm verify:boundaries`.

## The bridge

The renderer reaches main through one narrow, typed, allowlisted surface. Three
rules, each load-bearing:

1. **`ipcRenderer` is never exposed** — not bound to a channel argument, not
   behind a wrapper taking a channel name. The renderer gets *verbs*, and the set
   of verbs is the allowlist.
2. **Every subscription returns its own unsubscribe.** This mirrors
   `TerminalTransport.onData` exactly, which is what lets `PtyTransport` be a
   thin adapter.
3. **The raw `IpcRendererEvent` never crosses.** Passing it hands the renderer a
   `sender` handle and defeats the isolation.

Main-side, every handler runs `assertSender` (main frame of our own window only)
and then a hand-written payload guard. Guards **reject** rather than sanitise —
including extra fields, because an unexpected key means the two sides disagree
about the contract.

Posture, non-negotiable and asserted in `tests/e2e/electron/security.spec.ts`:
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, plus a
strict CSP applied on the session (not only as a `<meta>` tag).

## The workspace config

`~/.hive/config.json` — overridable by `HIVE_CONFIG_PATH` — maps a project id
shown in the left rail to a real directory on this machine. It is the only thing
that makes a PTY's `cwd` real; everything else about a project is still fixtures.

Read in main (`electron/main/config/`), never in the renderer. The file is
user-authored input arriving from disk, so it gets the same treatment as input
arriving from the renderer: hand-written guards, an explicit key allowlist, and
`__proto__` rejected outright. Paths are `~`-expanded, required absolute,
`realpath`'d once, and required to be directories — in that order, and up front,
so the path handed to `node-pty` is the one that was validated.

**Nothing here throws.** A failing entry disables that project; a malformed file
disables all of them. One mistyped path must not stop the app launching, but it
must be *visible* — every failure carries a `ProjectStatus` the renderer turns
into an `unmapped` badge and a tooltip naming the file to edit.

The renderer sees the verdict through `window.hive.config` (read-only — no verb
writes to disk) and consults it via `can.spawnSessionIn(projectId)`. That
predicate is **permissive with no snapshot loaded**: the browser demo has no
config to read and no process to protect, and gating it would break the web
specs. See `src/lib/project-config.ts` for the full reasoning.

Comments in the file are `"//"`-prefixed keys, the same convention
`package.json` already uses here — JSON has no comment syntax, and the first-run
template has to explain itself in the file the user opens.

## The pty host

**PTYs run in a dedicated `utilityProcess`, not in main.** `node-pty` is a
native addon and a segfault in a native addon is not catchable; in main that is
a hard crash of the whole application — every live session dies, and the UI that
would have reported the failure dies first. VS Code runs its terminals in a
separate pty host for exactly this reason, and the more concurrent sessions
there are, the worse "one bad PTY kills everything" gets.

```
renderer  ──contextBridge──►  main  ──MessagePort──►  pty host
                              (policy)                (processes)
```

Main stays the single policy point — it owns sender validation and session-id
ownership, and neither can be delegated to a process whose job is to run
whatever it is told. The renderer never talks to the host.

`utilityProcess`, not `child_process.fork`: the child is an **Electron** Node
process, so it has the ABI `node-pty` was built for; messaging is MessagePort
structured-clone rather than a hand-rolled stdio protocol; and Electron ties the
child's lifetime to the app so a hard quit cannot orphan it.

Split across three places: `electron/shared/pty-host-protocol.ts` (the wire
types, deliberately distinct from the renderer-facing `ipc-contract.ts` so the
two can diverge), `electron/main/pty-host/` (the supervisor), and
`electron/pty-host/` (the child). The child is a **second rollup input on the
`main` target**, so it lands at `out/main/pty-host.js` and inherits main's
module format, externals and output directory.

Supervisor behaviour worth knowing before changing it:

- **Lazy start.** Nothing forks until the first spawn — most launches land on
  the orchestrator console, which owns no PTY.
- **Heartbeat.** Main pings; three unanswered pings condemn the host. A host can
  hang without exiting, and a hang is indistinguishable from a dead terminal
  unless something is watching.
- **Crashes do not resurrect sessions.** A restarted host has no memory of the
  old one's children — re-running `claude` unasked could redo work. The user
  restarts a session explicitly.
- **Crash-loop guard.** Four crashes inside 60s stops restarts entirely.
- **Shutdown asks, then insists.** `shutdown` → wait → `kill()`. Killing first
  orphans every `claude` the sessions own, which is the bug story 098 asserts
  against.

Everything above is injected (`fork`, the clock, every timeout), so the whole
story is asserted with fake timers instead of by killing real processes.

### What makes a terminal real (story 092)

Not the renderer — xterm.js has been rendering fixtures since story 042. What
was missing is a kernel pty pair with a process whose controlling terminal it
is. `electron/pty-host/session-manager.ts` owns that. Four things there are load
bearing and easy to break:

- **`TERM=xterm-256color`.** How every program in the terminal decides what it
  may emit. Wrong, and colours silently vanish or garbage appears.
  `COLORTERM=truecolor` beside it, or tools quantise the 24-bit palette to 256.
- **Environment sanitisation.** The child must not inherit Electron's
  environment verbatim. `ELECTRON_*`, `NODE_OPTIONS`, `NODE_PATH`,
  `GDK_PIXBUF_*` and `CHROME_*` are stripped. This is the bug class behind "it
  works in my terminal but not in the app", and it stays invisible until
  something downstream behaves strangely.
- **`encoding: null` plus a per-session `StringDecoder`.** A multi-byte
  character can straddle a read boundary, and decoding chunks independently
  corrupts it *permanently* — the damage happens before the bytes reach xterm.
  A terminal running Claude Code renders box-drawing and emoji constantly.
- **`kill` targets the process group.** `process.kill(-pid, sig)`, then SIGKILL
  after a grace period. SIGTERM to the shell alone leaves `claude` and
  everything it spawned running with a dangling pty.

Resizes clamp to 1×1 and drop no-ops: xterm reports 0 transiently mid-layout,
and a pty resized to zero columns puts curses applications into states they do
not recover from.

Each session keeps a bounded ring buffer (256 KB) so a terminal that mounts late
still shows the transcript, prefixed with a dim truncation marker when output
was dropped. The buffer is **retained after exit** — a terminal that clears
itself when a process dies destroys the error the user needed to read.

### Batching and flow control (story 093)

`pty:data` is the only high-volume channel in the app — a single `pnpm build`
emits tens of thousands of small writes. Forwarding each as its own IPC message
produces **two distinct failures that need different fixes**:

| Failure | Fix |
|---|---|
| **Message storm.** Electron IPC has real per-message overhead, and thousands of tiny messages per second saturate the main process — which is also the thing drawing the window | **Batching.** At most one message per session per 8 ms (under a frame at 120 Hz, so no perceptible typing latency), flushed immediately past 64 KB |
| **Unbounded queueing.** A pty produces faster than xterm parses. The queue grows, memory climbs, and the terminal falls behind real time until Ctrl-C appears to do nothing | **Acknowledgement.** Only an ack can fix this — batching cannot |

Batching is **per session**: one noisy session must not delay another's echo.

The ack loop: main tracks unacked bytes per session, pauses the pty above 512 KB
and resumes below 128 KB. `pause()` stops the host reading the fd, so the kernel
pty buffer fills and the producing process blocks on `write` — real backpressure,
the same thing that happens piping to a slow consumer in a shell, not a queue
growing somewhere invisible.

**The critical detail: the ack is sent from xterm's `write` callback, not on
receipt.** `xterm.write` is asynchronous and its callback fires once the chunk is
parsed into the buffer. Acking on arrival measures the IPC channel and learns
nothing about whether the terminal is keeping up, which is the entire question.

Direction matters for the verbs. `write`, `resize` and `ack` use `send` —
awaiting a round trip per keystroke would put main in the typing-latency path,
and ordering is already guaranteed on a single channel. `spawn` and `kill` use
`invoke`; both need a result. Resizes are throttled to one per 50 ms per session
**with a trailing call**, because every resize is a `SIGWINCH` and a drag without
the trailing call ends on a stale size.

Each batch carries a monotonic `seq`. The renderer asserts monotonicity and, on a
gap, writes a dim marker rather than silently rendering a corrupted stream. `exit`
is held until the session's last data has flushed — delivering it early truncates
the final output, which is usually the error. Per-session counters (bytes in,
bytes acked, pauses, batches, drops) ride out on `app:info`; flow-control bugs are
otherwise diagnosed by staring at a slow terminal and guessing.

### Sessions: what actually runs (story 096)

`electron/main/sessions/` sits between "a pty exists" and "a session is running".
The PTY layers below it know nothing about projects, bootstraps or attention.

**A session is `$SHELL -l`, with `claude` written in as input.** Both halves are
deliberate:

- `-l` sources the user's profile, which is what puts `claude`, nvm-managed node
  and every shim on `PATH`. Without it the failure is `claude: command not found`
  in an app whose whole purpose is running `claude`.
- The command is **written into the pty**, not passed as `-c`. With `-c` the
  shell exits when `claude` does, leaving the user looking at a corpse in the
  middle of a repository they were working in. Written as input it is an ordinary
  interactive command and the shell survives it.

The write waits for the shell's first output plus a ~150 ms settle, because
characters written before the line discipline is installed land in a buffer the
shell may discard — the session then sits at a bare prompt having silently
swallowed the command. If nothing is heard for 5 s the bootstrap goes in anyway
and the fact is logged.

**Identity: `entityId → sessionId → pty`.** The renderer addresses sessions by
entity id and never sees a pty handle. Main mints a fresh session id per
generation, so a restart's stale in-flight output belongs to an id nothing maps
to and is dropped where it arrives — otherwise a restarted `claude` opens showing
the tail of the conversation the user restarted to be rid of.

| Action | Behaviour |
|---|---|
| Open, no pty | spawn, bootstrap, attach |
| Open, live pty | **attach only, never respawn** — a respawn would discard a running agent's context |
| Switch away | keeps running; the surface stays mounted |
| Restart | kill, **wait for the exit**, spawn fresh, bootstrap again — an ordering, not a set |
| Quit | the host SIGTERMs every process group, waits 3 s, force-kills the rest |

**Status is derived in main**, debounced: output → `working`, 2 s of silence →
`idle`, exit → `done`. In main rather than the renderer because a per-chunk store
write at firehose rates would re-render the shell continuously.

`waiting` is **not derived, and the type main sends cannot express it.** A TUI
that has asked a question and one that is thinking both produce no output;
distinguishing them by scraping rendered text would be a heuristic that fails
silently, and the entire inbox and attention model is built on this field.
Fixture sessions still show `waiting`; no real session enters it. The real
mechanism is a Claude Code notification hook — a first-class integration with its
own design, named here so the gap is recorded rather than discovered.

## Two ABI facts that produce unreadable errors when forgotten

**`node-pty@1.1.0` does NOT need rebuilding for Electron.** It ships **N-API**
prebuilds, which are ABI-stable across Node versions *and* Electron. The same
`prebuilds/darwin-arm64/pty.node` spawns a working PTY under plain Node (ABI 127)
and Electron 43 (ABI 148). Running `electron-rebuild` unconditionally would
*replace* that portable prebuild with an ABI-locked one. `pnpm rebuild:pty` exists
for the case that genuinely needs it: no prebuild for the platform, `node-pty`
falls back to `node-gyp rebuild`, and *that* build is Node-ABI-locked.

**The published `spawn-helper` has no executable bit.** It is mode `0644` in the
tarball itself, so every package manager reproduces it, and node-pty's own
`post-install.js` only chmods `build/Release/` — which a prebuild install never
populates. The symptom is `Error: posix_spawnp failed.` on the first spawn,
*after* `require` already succeeded, naming neither node-pty nor permissions.
`postinstall` repairs it; `pnpm check:abi --fix` repairs it by hand.

## Testing: three layers, split by what each can prove

| Layer | Runner | ABI / process | Proves |
|---|---|---|---|
| **Main-process unit** | Vitest, node env, `node-pty` mocked | plain Node | spawn arguments, cwd, IPC routing, guards, teardown |
| **PTY conformance** | `ELECTRON_RUN_AS_NODE=1 electron` | Electron ABI, no window | terminal *semantics*: signals, resize, alt-screen, exit codes (story 098) |
| **Electron e2e** | Playwright `_electron` | the full app | window chrome, menus, security posture, the UI wired to a live PTY |

The middle layer is the one that does not exist in a web project. Whether Ctrl-C
delivers `SIGINT` to the foreground process group is not a UI question, and
asserting it through a browser driver is slow, flaky and indirect.

`ELECTRON_RUN_AS_NODE=1` runs the Electron binary as a plain Node process — same
ABI, no window, no Chromium. It is what makes the middle layer possible.

### The conformance suite (story 098)

```sh
pnpm test:pty                    # the full matrix
pnpm test:pty --filter signals   # one property group
```

It drives the **real** session manager from story 092, not a reimplementation:
`electron.vite.config.ts` emits `electron/pty-host/session-manager.ts` as a third
input on the `main` target, so `out/main/session-manager.js` is an importable ESM
module built for Electron's ABI with `node-pty` left external. A suite that talked
to its own pty wrapper would prove that wrapper works and nothing about the
product.

Eight property groups — identity, environment, signals, resize, rendering,
throughput, lifecycle, bootstrap — and three rules the harness owns so no
individual assertion can forget them:

- every wait is a **polled predicate with a deadline**, never a fixed sleep;
- every test gets a scratch directory under the OS temp dir, removed afterwards;
- every test kills its sessions and **asserts the process group is gone**, so a
  leak fails the test that caused it rather than a later one.

Two traps that cost time when rediscovered, both handled by the harness:

- **A pty echoes its input.** `echo ALL-DONE` puts `ALL-DONE` in the transcript
  before the command has run, so a sentinel must not appear literally in the
  command that prints it — `emitSentinel()` splits it across a quote boundary.
- **`$!` needs job control**, which varies by shell and platform. Background
  helpers record their own `$$` to a file instead.

#### Two things it found

- `resize(0, 0)` **clamped to 1×1** rather than being dropped. A 1×1 pty emits
  nothing legible, and nothing resizes it back: the renderer's own geometry
  never changed, so it never sends anything new. Now dropped;
  `session-manager.ts` carries the reasoning.
- A process the user **explicitly backgrounds** (`pnpm dev &`) gets its own
  process group under an interactive shell's job control, so `kill(-shellPid)`
  does not reach it and it survives app shutdown. `claude` is unaffected — the
  bootstrap runs it in the foreground — but "no orphans on shutdown" is not
  absolute. Recorded on HIVE-49; closing it means signalling the pty's *session*
  rather than one process group.

### Running it

| Command | Runs |
|---|---|
| `pnpm test:e2e` | both projects |
| `pnpm test:e2e:web` | the six browser specs (story 070) |
| `pnpm test:e2e:electron` | the built desktop app |

`globalSetup` builds `out/` when it is missing or stale, so `--project=electron`
can never silently test yesterday's binary. It no-ops for a web-only run.

**`webServer` cannot be scoped to a project.** It is a top-level Playwright
option that starts before any project is selected, so an Electron-only run would
build and serve a browser bundle it never touches. `pnpm test:e2e:electron` sets
`PW_ELECTRON_ONLY=1`, which skips it.

### Gotchas the suite already paid for

- **Every Electron-specific call lives in `tests/e2e/electron/fixtures/hive-app.ts`.**
  Playwright's Electron support is experimental; `@playwright/test` is pinned
  exactly and the used surface kept to `launch`, `firstWindow`, `evaluate`,
  `close`, so a breaking change is a one-file fix.
- **Each test gets its own `--user-data-dir`.** Window state persists, so a
  shared profile makes test order change results — and moves the developer's
  real window.
- **`getLastWebPreferences()` exists at runtime but is missing from Electron 43's
  typings.** It needs a cast; it is the only way to read the flags the window was
  actually constructed with.
- **Electron lowercases menu roles.** `selectAll` comes back as `selectall`.
  Comparing against the camelCase spelling silently never matches.
- **xterm owns its own selection** and paints it into an overlay, so
  `window.getSelection()` can be empty while the terminal has a live selection.
  Drag with the mouse and accept either signal.
- **`.xterm-viewport` reports `scrollHeight === clientHeight`** at every scroll
  position. Which lines are on screen is the only honest observable — read
  `.xterm-rows > div` text via `waitForTerminalText`.
- **Assets must not use root-relative URLs.** A built app loads its renderer over
  `file://`, where `/hive-mark.png` resolves against the *filesystem* root and
  404s as a broken image. The renderer builds with `base: './'`; reference public
  assets through `import.meta.env.BASE_URL`.

## Out of scope here

Packaging, installers, code signing, notarisation, auto-update. Windows — a known
gap; ConPTY/`winpty` is its own body of work, and `titleBarStyle: 'hiddenInset'`
is not honoured there either.

When packaging lands, one constraint is already known: the `.node` binary must be
**unpacked from the asar** (`asarUnpack`), because `dlopen` cannot load from
inside an archive.

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

## The environment this process actually has (HIVE-84)

A macOS app launched from Finder, the Dock or Spotlight inherits **launchd's**
environment, not the one a login shell assembles. In a packaged build `PATH` is
therefore exactly `/usr/bin:/bin:/usr/sbin:/sbin` — four entries, none of which
is where anybody installs a developer tool. `gh` at `/opt/homebrew/bin/gh` is
genuinely invisible to this process while being obviously present in the user's
terminal.

`electron/main/config/login-env.ts` runs the configured login shell once at
startup and merges an allowlist — `PATH`, `GH_TOKEN`, `GITHUB_TOKEN` — back into
`process.env`. `main/index.ts` starts it before the handlers are registered and
never awaits it, so a slow rc file cannot delay the first window.

**`process.env` is the seam on purpose.** Every consumer already reads it lazily,
at call time — the `gh` probe, `resolveGit`, the command diagnostic, and the base
environment of every session — so repairing the one value they derive from fixes
all of them with no change at any call site.

**The pty host is the exception, and it is enforced.** `forkPtyHost` passes no
`env`, so the utility process snapshots `process.env` at fork time and keeps it
for the life of the app — a lazy read that happens exactly once. `ptySpawn` and
`ptyRestart` therefore `await loginEnvStatus()` before the host can come up.
Without that, a click inside the first second on a machine with a slow rc file
freezes launchd's `PATH` into every terminal the app ever opens, while Settings
correctly reports the import succeeded.

The rules the module holds to:

- an **allowlist**, never the whole environment — an rc file exporting
  `NODE_OPTIONS` or a proxy setting must not silently change how this app runs
- it never overwrites a variable the process already has; `PATH` is **merged**,
  login-shell order first, de-duplicated, so nothing the launching process
  supplied is lost and the value cannot grow by a duplicate each launch
- **presence, never value**, leaves the process: two of the three variables are
  credentials, so the renderer is told which *names* were imported
- bounded exactly as the env diagnostic is — `execFile`, a timeout, and an
  untrappable `SIGKILL` — because this runs on the main process at boot, where a
  `trap '' TERM` rc file would be a hang before the first window
- a failed probe is a failed *observation*: the inherited environment is kept and
  the reason is reported, never treated as a configuration error

`importLoginEnv` in the config file turns it off (Settings → Runtime), for the rc
file this app should not fight. Settings → Integrations reports which environment
is in force, because the difference is otherwise invisible and a user who cannot
see it cannot tell a broken import from a missing binary.

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

### The picker's choice becomes flags (109)

`sessionCommand` appends `--model <alias> --effort <level>` before the `&&`, so
they bind to `claude` and not to `exit`. Both are optional and **absent means say
nothing** — a session nobody picked a model for gets the bare command and keeps
whatever the user configured in `claude` itself.

These two values are the only thing the renderer contributes to a command line
main writes into a shell, so the IPC guard validates them against a **closed set**
(`SESSION_MODELS` / `SESSION_EFFORTS` in `shared/session-contract.ts`) rather than
as bounded text. `opus; rm -rf /` is perfectly well-formed printable text. An
enum is what lets `sessionCommand` interpolate them unquoted.

`src/types/entity.ts` aliases those two sets rather than declaring its own: a
picker offering a value the guard rejects is a session that fails to start for a
reason neither side can see.

`restart` forwards them and still drops the `task` — a task is an instruction the
previous generation may have acted on; a model is what the session *is*.

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
`idle`, exit → `terminated`. In main rather than the renderer because a per-chunk
store write at firehose rates would re-render the shell continuously.

`terminated`, not `done` (story 108), and the distinction is the same discipline
`waiting` gets below. An exit is an *observation* — the process is gone. "Done"
is a claim about the work, and main has no way to evaluate it: `/exit` after an
abandoned attempt and `/exit` after a merged PR produce byte-identical evidence.
`DerivedStatus` no longer contains `done` at all, so main cannot make that claim
by accident. A `terminated` session's tab is also closed to new visits — its pty
is gone — which is enforced once, in `hive-store`'s `openEntity`.

`waiting` is **not derived** — `DerivedStatus` cannot express it. A TUI that has
asked a question and one that is thinking both produce no output; distinguishing
them by scraping rendered text would be a heuristic that fails silently, and the
entire inbox and attention model is built on this field.

It is **reported** instead, by Claude Code's hooks (HIVE-62), which are a
different observer with a vantage point a pty does not have — hence
`ObservedStatus`, wider than `DerivedStatus` by exactly this member.

## The five statuses, and the two endings that are not statuses

The fleet view shows `working`, `waiting` (labelled "needs input"),
`idle (agents)`, `idle (script)`, and plain `idle`. `done` and `terminated` are
not in that list, on purpose: both are endings, and an ending is a claim about
a boundary, not a thing a session is doing moment to moment. `done` arrives
when the user runs `/clear` — Claude Code reports that as `SessionEnd` with
`reason: 'clear'`, the pty stays alive, and the fact travels its own channel,
`SessionClearedEvent`, rather than riding `ObservedStatus`; the row retires as
history and a successor opens on the same pty (`entity.ts`'s `terminalId`
keying is what lets the terminal survive that handoff without a remount).
`terminated` is the pty exit `activity.ts` observes directly, and it is the one
status forwarded even for a hook-driven session — `sessions/index.ts` otherwise
lets a session's own hooks own its status once any have arrived, and makes an
explicit exception for this one — because `SessionEnd` races the process exit
and loses: a hook POST from a process that is already gone is not a bet worth
making.

`idle (agents)` and `idle (script)` are not new members of `ObservedStatus`
either. They are plain `idle` with an `IdleDetail` attached, because the
underlying fact is the same either way — the main agent has nothing to say —
and only the reason differs: a subagent is still running (`SubagentStart` seen,
no matching `SubagentStop` yet), or a backgrounded shell is (`PostToolUse` with
`tool_input.run_in_background: true`, cleared only by the next
`UserPromptSubmit` because Claude Code emits no hook when a backgrounded
process itself dies). `status-dot.tsx` renders the difference as a hollow ring
instead of a solid dot rather than a new colour: it costs nothing and it is
this rename's entire point — free means free, and a subagent still working is
not free.

The hook table below reflects that: it now covers the hooks the tracker reads,
not only the ones that can raise `waiting`.

| Hook | Means |
| --- | --- |
| `PermissionRequest` | a tool wants a yes |
| `Elicitation` | an MCP server wants a sentence |
| `Notification` + `notification_type: permission_prompt` | the same tool-approval block, echoed six seconds later |
| `PreToolUse` | a tool is about to run — the tracker's only chance to record `tool_use_id` ↔ `tool_name` before a block can reference it |
| `SubagentStart` | a subagent is now running (`idle (agents)` once the main agent has nothing else to say) |
| `SubagentStop` | that subagent is done, or Claude Code's own internal helper is — the tracker only removes agents it saw start |

`Notification` also fires with `notification_type: idle_prompt` — the turn
ended and sixty seconds passed with nothing typed, the commonest way a session
blocks on a human and the last of these to arrive. It does **not** report
`waiting`: the turn is already over by the time it fires, nothing is blocked,
and calling it `waiting` is what used to make the fleet dot lie. It reports
`idle`, the same as the `Stop` a minute earlier, and still raises its inbox
row — the row is routed off the hook *event*, independently of the status, so
"you walked away and your agent wants you" still reaches the user without
painting the fleet view amber for a session nobody is waiting on. `Stop` itself
is not a substitute for either: it fires at the end of *every* turn, including
the ones the user is sitting and watching, so it maps to `idle` and raises
nothing.

## Leaving `waiting`: pairing, not a single deterministic hook

`PostToolUse` used to be described here as *the* deterministic way to leave
`waiting` — subscribe one more high-frequency hook, and a tool finishing clears
the block a `PermissionRequest` set. That was wrong in a way that only showed up
with more than one tool in flight: `PostToolUse` fires once per tool, `waiting`
was one flag per session, and a sibling tool's completion in a parallel batch
cleared it while the one the user actually had to approve was still blocked. The
notifier compensated (`status === 'waiting' || event === 'PostToolUse'`) rather
than fixing the status itself, which is the workaround this story removed.

The fix is `electron/main/hooks/tracker.ts`: status is now **derived from a
per-session tracker**, not looked up per event. The tracker pairs blocks to the
tool that caused them by `tool_use_id`, and clears exactly that pairing when its
`PostToolUse` arrives — a sibling's completion no longer touches it. Pairing
works because `PreToolUse` records `tool_use_id` ↔ `tool_name` (and `agent_id`,
so a subagent's block cannot resolve against the main agent's) as each tool
starts; `PermissionRequest` then resolves to an id by walking the outstanding
tools backward for a `tool_name` match, newest first — sound because its
matching `PreToolUse` fires roughly sixty milliseconds earlier, so it is always
the most recent entry with that name. A block that cannot be resolved this way
(`Elicitation`, or a `PermissionRequest` with no name match) is held under a
sentinel, `UNPAIRED`, rather than dropped — losing a block would read as the
session no longer needing the user, which is worse than holding one open a
little too long.

Measured against Claude Code **2.1.238**, real pty, outside the app:

- `PreToolUse` and `PostToolUse` both carry `tool_use_id` **and** `tool_name`.
- `PermissionRequest` carries `tool_name` but **no** `tool_use_id` — which is
  exactly why the id has to be recovered from its matching `PreToolUse` rather
  than read off the request itself.
- `Notification` carries no tool identity at all.
- Every event originating inside a subagent carries `agent_id`; every main-agent
  event omits it.
- Claude Code emits phantom `SubagentStop` events for its own internal helper
  agents, with an empty `agent_type` and no `SubagentStart` that preceded them —
  which is why the tracker only ever removes an agent it saw announced.

All of this is measured rather than assumed, and `pnpm test:hooks` is what
measures it: a real `claude` in a real pty, driven through the app's own
receiver, notifier and hub, against the vocabulary above. Run it again whenever
the targeted Claude Code version moves — a payload shape changing under this
tracker is exactly the kind of regression a fixture would not catch.

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
  `file://`, where `/hive-tile.png` resolves against the *filesystem* root and
  404s as a broken image. The renderer builds with `base: './'`; reference public
  assets through `import.meta.env.BASE_URL`.

## Out of scope here

Packaging, installers, code signing, notarisation, auto-update. Windows — a known
gap; ConPTY/`winpty` is its own body of work, and `titleBarStyle: 'hiddenInset'`
is not honoured there either.

When packaging lands, one constraint is already known: the `.node` binary must be
**unpacked from the asar** (`asarUnpack`), because `dlopen` cannot load from
inside an archive.

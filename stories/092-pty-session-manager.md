# 092 — PTY Session Manager (node-pty)

| | |
|---|---|
| **ID** | HIVE-092 |
| **Epic** | Real terminals |
| **Depends on** | [091-pty-host-process.md](091-pty-host-process.md), [084-native-modules-dev-workflow.md](084-native-modules-dev-workflow.md), [090-workspace-config.md](090-workspace-config.md) |
| **Blocks** | [093](093-pty-ipc-protocol.md), [096](096-session-lifecycle-claude.md), [098](098-pty-conformance-suite.md) |
| **Points** | 8 |
| **Location** | `app/electron/pty-host/session-manager.ts` |

## Story

> As a user, I want the terminal in The Hive to be a **real pseudo-terminal** — colours,
> resize, Ctrl-C, full-screen TUIs, job control — so that running Claude Code in it is
> indistinguishable from running it in iTerm.

This is the story the whole desktop epic exists for. Everything else is plumbing around
it.

## What makes a terminal real

Not the renderer. xterm.js is already the renderer VS Code ships, and it has been
rendering this app's fixtures since [042](042-terminal-surface.md). What has been
missing is a kernel-level pty pair behind it, with a process whose controlling terminal
it is.

That gives, for free and without a line of UI code: SGR colour, cursor addressing,
alternate screen, `SIGWINCH` on resize, `SIGINT` from Ctrl-C, job control, `isatty()`
returning true so tools enable their interactive paths — which is precisely why Claude
Code's TUI renders at all.

## Spawn

```ts
pty.spawn(shell, args, {
  name: 'xterm-256color',
  cwd,
  env,
  cols, rows,
  encoding: null,          // Buffers — see UTF-8 below
});
```

**`name: 'xterm-256color'`** sets `TERM` in the child. It is the single most
consequential option here: it is how every program in that terminal decides what it may
emit. Get it wrong and colours silently vanish or garbage appears.

`COLORTERM=truecolor` is added to `env` alongside it, so 24-bit colour is advertised —
the palette in `src/lib/terminal/ansi.ts` is truecolor SGR
([011](011-design-tokens-and-theming.md)), and without this some tools quantise to 256.

### Environment sanitisation — the non-obvious part

The child must **not** inherit Electron's process environment verbatim. Electron sets
variables that break or confuse child processes, and a shell spawned from a
`utilityProcess` inherits several that make no sense for it:

| Variable | Why it must be stripped |
|---|---|
| `ELECTRON_RUN_AS_NODE` | inherited by every child; a child that itself launches Electron silently becomes a Node process |
| `ELECTRON_*` (all) | internal wiring, never meaningful to a user shell |
| `NODE_OPTIONS` | applied to any `node` the user runs, changing its behaviour invisibly |
| `GDK_PIXBUF_*`, `CHROME_*` | Chromium sandbox/runtime leakage |

Start from a copy of `process.env`, delete the deny-list, then set `TERM`, `COLORTERM`,
and `PWD`. Anything else the app needs to inject is explicit.

This is the bug class that produces "it works in my terminal but not in the app", and it
is invisible until something downstream behaves strangely. It gets a dedicated
conformance assertion ([098](098-pty-conformance-suite.md)).

### UTF-8 across chunk boundaries

`encoding: null` yields `Buffer`s rather than strings, decoded through a **per-session
`StringDecoder`**.

The reason is a real defect, not fastidiousness: a multi-byte character can straddle a
read boundary. Decoding each chunk independently turns the split character into
replacement characters — permanently, since the damage happens before the bytes reach
xterm. A `StringDecoder` holds the partial sequence until the next chunk completes it.

A terminal running Claude Code renders box-drawing characters and emoji constantly, so
this is a *when*, not an *if*.

## Registry

```ts
Map<sessionId, {
  pty: IPty;
  pid: number;
  decoder: StringDecoder;
  buffer: RingBuffer;      // bounded scrollback, see below
  status: 'live' | 'exited';
}>
```

- `sessionId` is assigned by main, never by the renderer, and is validated on every
  message ([091](091-pty-host-process.md)).
- **Session cap** (default 24) — refuse beyond it with a clear error rather than letting
  the app fork-bomb a laptop. Thirteen entities is the fixture set's size
  ([042](042-terminal-surface.md)); the cap sits above realistic use and below harm.

### Bounded scrollback in the host

Each session keeps a ring buffer of recent output (default 256 KB), which exists for one
reason: a `TerminalSurface` that mounts late must still show the transcript.

`TerminalTransport.onData`'s contract already promises this — *"the transport is
expected to replay whatever scrollback it already holds before the first live chunk"*
([042](042-terminal-surface.md)). Terminals mount lazily on first visit
([`terminal-host.tsx`](../app/src/components/terminal/terminal-host.tsx)), so a session
that has been running while the user was elsewhere has output that predates its surface.

Bounded, because a session running a verbose build for an hour must not grow the host's
memory without limit. Truncation drops from the front and the replay is prefixed with a
dim `── earlier output truncated ──` marker, so a partial transcript never masquerades
as a complete one.

## Write, resize, kill

**`write`** passes bytes straight through. No interpretation, no line handling, no echo
— the pty and the shell own all of that. A transport that helpfully appended a newline
would break every interactive prompt.

**`resize(cols, rows)`** calls `pty.resize`, which triggers `SIGWINCH`. Guard against
zero or negative values: xterm reports `0` transiently while its container is hidden or
mid-layout, and resizing a pty to zero columns puts curses applications into states they
do not recover from. Clamp to a minimum of 1×1 and drop no-op resizes.

**`kill`** must kill the **process group**, not just the shell. `SIGTERM` to the shell
leaves `claude` — and anything it spawned — running with a dangling pty. Kill the group,
wait briefly, then `SIGKILL` any survivor. On macOS/Linux this is `process.kill(-pid,
signal)` against the pty's leader.

Orphan-freedom is the assertion that proves this ([098](098-pty-conformance-suite.md)),
and it is the difference between quitting the app and leaving a dozen agents running.

## Exit

On `onExit({ exitCode, signal })`: flush the decoder, mark `exited`, emit `exit`
upstream, and **retain the buffer** so the terminal keeps showing what happened. A
terminal that clears itself the instant a process dies destroys the error the user
needed to read.

Cleanup of exited entries happens when the session is closed by the user, not on exit.

## Tests

`tests/electron/pty-host/` (Vitest, `node-pty` mocked per
[084](084-native-modules-dev-workflow.md) — the real binary is Electron-ABI and cannot
load here):

- `TERM` is `xterm-256color` and `COLORTERM` is `truecolor` in the spawn env.
- Every deny-listed variable is absent; unrelated user variables survive.
- `cwd` is the resolved path from [090](090-workspace-config.md).
- A UTF-8 sequence split across two chunks decodes to one character.
- Ring buffer bounds at its cap and prefixes the truncation marker.
- Replay is emitted before the first live chunk.
- Resize to `0` cols is dropped; a duplicate resize is a no-op.
- `write` passes bytes verbatim, adding nothing.
- Kill targets the process group and escalates to `SIGKILL` after the grace period.
- Spawning past the cap is refused with a typed error.
- Exit retains the buffer and marks the entry `exited`.

Everything about *real terminal behaviour* — that `SIGINT` actually arrives, that
`SIGWINCH` actually reaches the child — is unprovable with a mock and belongs to
[098](098-pty-conformance-suite.md).

## Acceptance criteria

- [ ] A spawned session runs a real shell in the configured project directory.
- [ ] `echo $TERM` prints `xterm-256color`; `tty` prints a pty device.
- [ ] `env | grep ELECTRON` is empty inside the session.
- [ ] A 256-colour test script renders correct colours.
- [ ] Resizing the window changes `stty size` inside the session.
- [ ] Ctrl-C interrupts a running `sleep 100`.
- [ ] `vim` and `htop` render and exit cleanly.
- [ ] Killing a session leaves no surviving child process.
- [ ] Unit tests above pass with the mock.

## Out of scope

- Renderer wiring and flow control — [093](093-pty-ipc-protocol.md).
- Deciding *what* to run — [096](096-session-lifecycle-claude.md).
- Session persistence across app restarts; reattach to a pty that outlives the app.
- Windows / ConPTY.

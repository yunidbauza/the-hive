# 091 — PTY Host Process (`utilityProcess` supervisor)

| | |
|---|---|
| **ID** | HIVE-091 |
| **Epic** | Real terminals |
| **Depends on** | [081-main-process-window.md](081-main-process-window.md), [084-native-modules-dev-workflow.md](084-native-modules-dev-workflow.md) |
| **Blocks** | [092](092-pty-session-manager.md), [093](093-pty-ipc-protocol.md) |
| **Points** | 8 |
| **Location** | `app/electron/main/pty-host/`, `app/electron/pty-host/` |

## Story

> As a user, I want a terminal that misbehaves to cost me *that terminal*, not the whole
> application, so a native crash never takes down the window that was about to tell me
> what happened.

## The decision

**PTYs run in a dedicated `utilityProcess`, not in the main process.**

The simpler design — `node-pty` loaded directly in main — was considered and rejected.
`node-pty` is a native addon; a segfault in a native addon is not catchable. In the
main process that is a hard crash of the entire application: every other live session
dies with it, and the UI that would have reported the failure dies first.

This is exactly why VS Code runs its terminals in a separate pty host rather than in
its main process, and the reasoning transfers directly. The Hive's premise is *many*
concurrent sessions ([000](000-overview.md)); the more terminals there are, the worse
"one bad PTY kills everything" becomes.

Doing it now also avoids the real cost, which is not writing the supervisor but
retrofitting one: once [093](093-pty-ipc-protocol.md)'s handlers and
[094](094-pty-transport.md)'s transport are written against in-process calls, moving
them across a process boundary means re-doing the async shape of both.

## Topology

```
┌── renderer ──┐   contextBridge   ┌──── main ────┐   MessagePort   ┌── pty host ──┐
│ PtyTransport │ ◄───────────────► │  ipc router  │ ◄─────────────► │  node-pty    │
│   (094)      │      (082/093)    │  supervisor  │                 │    (092)     │
└──────────────┘                   └──────────────┘                 └──────────────┘
                                          │ restarts, health, quit
```

- The renderer never talks to the host directly. Main stays the single policy point —
  it owns sender validation ([082](082-preload-ipc-security.md)) and session-id
  ownership, and neither can be delegated to a process whose job is to run whatever it
  is told.
- `electron/pty-host/` is the child's entry (bundled as a third main-process-style
  target in `electron.vite.config.ts`); `electron/main/pty-host/` is the supervisor
  that owns it.

## Why `utilityProcess` and not `child_process.fork`

`utilityProcess` is Electron's own API for this and brings three things `fork` does not:

- The child is an **Electron Node** process, so it has the same ABI the `node-pty`
  binary was rebuilt for ([084](084-native-modules-dev-workflow.md)). Forking the
  system `node` reintroduces exactly the ABI mismatch that story exists to eliminate.
- **`MessagePort`-based messaging**, structured-clone typed, rather than a hand-rolled
  stdio protocol.
- Electron tracks the child's lifetime with the app, so a hard quit does not orphan it.

## Supervisor responsibilities

**Lazy start.** The host is spawned on the first `pty:spawn`, not at app launch. Most
launches land on the orchestrator console ([041](041-orchestrator-console.md)), which
owns no PTY — starting a process for it is waste.

**Health.** A heartbeat both ways. Missing N consecutive beats is treated as a crash;
the host is a process that can hang without exiting, and a hang is indistinguishable
from a dead terminal to the user unless something is watching.

**Crash handling.** On `exit` with the app still running:

1. Every session the host owned is marked `crashed` with its exit signal.
2. The renderer is notified per session — each affected terminal writes a dim
   `── session lost (pty host crashed) ──` line and stops accepting input.
3. The host restarts on the next spawn request, not eagerly.

**Sessions are not silently resurrected.** A restarted host has no memory of the
processes the old one owned — those child processes are gone, and re-spawning `claude`
in the same repo without asking could rerun work the user did not ask for. The user
restarts a session explicitly ([096](096-session-lifecycle-claude.md)).

**Crash-loop guard.** If the host dies more than 3 times inside 60 seconds, stop
restarting and surface a persistent error. An unbounded restart loop against a
reproducible segfault burns CPU and floods the feed.

**Shutdown.** The supervisor registers on [081](081-main-process-window.md)'s
`onShutdown` hook: ask the host to kill every session and exit, wait with a timeout,
then `kill()` it. This is what stops `claude` processes surviving app quit, and
[098](098-pty-conformance-suite.md) asserts it.

## Message protocol (main ↔ host)

Typed, in `electron/shared/pty-host-protocol.ts`, and distinct from the
renderer-facing contract in [082](082-preload-ipc-security.md) — the two must be free
to diverge.

| Direction | Message | Payload |
|---|---|---|
| → host | `spawn` | `{ sessionId, shell, args, cwd, env, cols, rows }` |
| → host | `write` | `{ sessionId, data }` |
| → host | `resize` | `{ sessionId, cols, rows }` |
| → host | `kill` | `{ sessionId, signal }` |
| → host | `shutdown` | — |
| ← host | `data` | `{ sessionId, chunk }` |
| ← host | `exit` | `{ sessionId, exitCode, signal }` |
| ← host | `spawned` | `{ sessionId, pid }` |
| ← host | `error` | `{ sessionId?, message }` |
| ↔ | `ping` / `pong` | `{ seq }` |

The host is deliberately dumb: it owns processes, not policy. It does not read config,
does not know what a project is, and does not decide what to run — `shell`, `args`,
`cwd` and `env` all arrive fully resolved from main ([090](090-workspace-config.md),
[096](096-session-lifecycle-claude.md)). Keeping it that way is what makes the
conformance suite able to drive it in isolation.

## Tests

`tests/electron/main/pty-host/` (Vitest, `utilityProcess` mocked):

- Not spawned at launch; spawned on the first request.
- Heartbeat timeout is treated as a crash.
- Crash marks every owned session `crashed` and notifies once per session.
- No automatic re-spawn of sessions after a host restart.
- Crash-loop guard trips at 4 crashes inside 60s and stops restarting.
- Shutdown waits for graceful exit, then force-kills after the timeout.
- Messages for an unknown `sessionId` are rejected, not forwarded.

Real supervision — an actual host process actually crashing — belongs to
[098](098-pty-conformance-suite.md), which can crash a real one on purpose.

## Acceptance criteria

- [ ] No extra process at launch; one appears on the first session and is visible in
      Activity Monitor as a child of the app.
- [ ] `kill -9` on the host process: affected terminals show the lost-session line, the
      window and every other part of the app stay responsive, and a new session
      afterwards works.
- [ ] Killing the host 4 times in a minute stops the restart loop and surfaces an error.
- [ ] Quitting the app leaves no orphaned host or shell process (`pgrep` check).
- [ ] The host never imports config or fixture code — enforced by a lint zone.
- [ ] Unit tests above pass.

## Out of scope

- Spawning actual PTYs — [092](092-pty-session-manager.md).
- Renderer-facing channels and flow control — [093](093-pty-ipc-protocol.md).
- More than one host process, or per-session isolation. One host, many PTYs.

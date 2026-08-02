# 096 — Session Lifecycle & `claude` Bootstrap

| | |
|---|---|
| **ID** | HIVE-096 |
| **Epic** | Real terminals |
| **Depends on** | [092-pty-session-manager.md](092-pty-session-manager.md), [094-pty-transport.md](094-pty-transport.md), [095-interactive-terminal-surface.md](095-interactive-terminal-surface.md), [090-workspace-config.md](090-workspace-config.md) |
| **Blocks** | [097](097-orchestrator-drives-ptys.md), [098](098-pty-conformance-suite.md) |
| **Points** | 8 |
| **Location** | `app/electron/main/sessions/`, `app/src/features/sessions/` |

## Story

> As a user, I want opening a session to start a **real Claude Code session in the right
> repository**, and closing the app to leave nothing running behind me, so The Hive is a
> place my agents live rather than a place I launch them from.

## What a session runs

```
spawn:  $SHELL -l          cwd: <resolved project path>
then:   write "claude\r"
```

**A login shell, then `claude` — not `claude` directly.**

Spawning the `claude` binary as the pty's leader is a tighter mapping, and it was
rejected for one reason: when Claude Code exits, the terminal is dead. The user is left
looking at a corpse in the middle of a repository they were working in, unable to run
`git diff`, rerun the tests, or start another turn without creating a new session.

With a login shell underneath, exit drops them into a live shell in the right directory
on the right branch — which is what a terminal is for.

**`-l` (login) is deliberate.** It sources the user's full profile, which is what puts
`claude`, `nvm`-managed node, `mise`/`asdf` shims and everything else on `PATH`. A
non-login shell finds none of that, and the failure is `claude: command not found` in an
app whose entire purpose is running `claude`.

**The bootstrap is written as input, not passed as an argument.** `$SHELL -l -c claude`
would run claude as the shell's only job and exit with it — the exact outcome being
avoided. Writing `claude\r` into the pty makes it an ordinary interactive command, and
the shell survives it.

The command is `claudeCommand` from [090](090-workspace-config.md), defaulting to
`claude`, so a user with a wrapper or an alternate binary is not stuck.

### Bootstrap timing

Write the bootstrap once the shell is ready, not immediately on spawn. Writing before
the shell has initialised means the characters land in a buffer the shell may discard,
and the session sits at a bare prompt having silently swallowed the command.

Wait for the first output chunk, then a short debounce (~150 ms) for the prompt to
settle, then write. If no output arrives within 5 seconds, write anyway and record it —
a shell with a genuinely silent startup is unusual but real.

The bootstrap is **echoed in the transcript** like any typed command. The user must be
able to see what was run; a hidden command in a terminal is a small lie that becomes a
support burden.

## Lifecycle

| Action | Behaviour |
|---|---|
| **Open** a session with no pty | spawn, bootstrap, attach |
| **Open** a session with a live pty | attach only — never respawn |
| **Switch away** | pty keeps running; surface stays mounted ([042](042-terminal-surface.md)) |
| **Restart** | kill the group, wait for exit, spawn fresh, bootstrap again |
| **Close / kill** | kill the group; keep the transcript readable |
| **Quit the app** | kill every session, wait, force-kill survivors, then exit |

**Open-attaches-never-respawns** is the invariant that makes the product work. The user
navigates between sessions constantly; a respawn on any of those would discard a running
agent's context. `ensureSpawned` ([094](094-pty-transport.md)) is idempotent for exactly
this.

### Quit

Registered on [081](081-main-process-window.md)'s `onShutdown` hook:

1. `SIGTERM` to every session's process group.
2. Wait up to 3 seconds for exits.
3. `SIGKILL` anything left.
4. Resolve, letting `will-quit` proceed.

A `claude` process that outlives the app is invisible, keeps consuming tokens, and can
still write to the repository. This is the single most important teardown in the
codebase, and [098](098-pty-conformance-suite.md) asserts orphan-freedom directly.

## Status: what is honestly derivable

The fixture status model ([000](000-overview.md)) is `working` / `waiting` / `idle` /
`done`, where **`waiting` means blocked on the user** — the state the whole inbox and
attention model is built around ([051](051-inbox-panel.md)).

With only a pty to observe, two of these are derivable and one is not:

| Status | Derivation | Confidence |
|---|---|---|
| `working` | output produced within the last 2 s | reliable |
| `idle` | no output for 2 s | reliable |
| `done` | pty exited | exact |
| `waiting` | **not derivable from pty output** | — |

A TUI that has asked a question and a TUI that is thinking both produce no output.
Distinguishing them by scraping rendered text for question marks would be a heuristic
that fails silently and constantly, and building the app's attention model on it would
be worse than not having it.

**Decision: this epic derives `working`/`idle`/`done` from the pty and does not derive
`waiting`.** Sessions still *show* `waiting` where a fixture says so, so the existing
inbox and payoff loop keep demonstrating ([051](051-inbox-panel.md),
[070](070-e2e-harness.md)) — but no real session enters `waiting` on its own, and the
epic does not claim otherwise.

The real mechanism is a **Claude Code hook** — a `Notification`/`Stop` hook writing a
structured event the app watches — which is a first-class integration with its own
design, not a corner of a PTY story. It is named here as the immediate follow-up epic so
the gap is recorded rather than discovered.

The activity debounce lives in main, not the renderer: a per-chunk store write at
firehose rates would re-render the shell continuously, which is precisely what the
store split exists to prevent (`AGENTS.md`, state management).

## Session identity

`sessionId` is minted in main and is **not** the fixture entity id. Mapping lives in
main: `entityId → sessionId → pty`. The renderer keeps passing entity ids
([094](094-pty-transport.md)) and never sees a pty handle.

Restarting a session mints a new `sessionId` against the same `entityId`, which is what
makes stale in-flight `data` from the old process droppable
([093](093-pty-ipc-protocol.md)) instead of appearing in the new terminal.

## Spawn preconditions

Refuse with a specific, actionable message — never a generic failure:

| Precondition | Message when unmet |
|---|---|
| desktop target | `sessions require the desktop app` |
| project mapped and valid | `apfm-web is not mapped — add it to ~/.hive/config.json` |
| under the session cap | `session limit reached (24)` |
| pty host healthy | `pty host unavailable — see the activity feed` |

## Tests

`tests/electron/main/sessions/` (node-pty mocked):

- Spawn args are `$SHELL -l`, cwd is the resolved project path.
- Bootstrap is written after first output + debounce, exactly once.
- No output within 5 s → bootstrap written anyway, and flagged.
- Opening a session with a live pty attaches and does not spawn.
- Restart kills, waits for exit, then spawns — asserted as an ordering, not a set.
- Quit terminates every session and force-kills after the grace period.
- Activity debounce: chunk → `working`; 2 s silence → `idle`; exit → `done`.
- `waiting` is never derived from output — the guard against someone adding a heuristic
  later.
- Each precondition produces its exact message.
- A restarted session gets a new `sessionId`; stale data for the old one is dropped.

## Acceptance criteria

- [ ] Opening a mapped session shows a shell prompt, then `claude` starting, in the
      project directory.
- [ ] `pwd` in the session prints the configured path; `git branch --show-current`
      works.
- [ ] Exiting `claude` leaves a usable shell in the same directory.
- [ ] Navigating away and back attaches to the same running process — verified by a
      stable pid.
- [ ] Restart produces a fresh process; the old one is gone.
- [ ] Quitting the app leaves zero descendant processes (`pgrep -P` check).
- [ ] Session status transitions `working` → `idle` → `done` against real activity.
- [ ] Every refusal path shows its specific message.

## Out of scope

- Detecting `waiting` — the follow-up Claude Code hooks epic.
- Resuming a Claude Code conversation (`--resume`), session persistence across app
  restarts, or reattaching to a pty that outlived the app.
- Creating branches or worktrees on spawn. `spawn` runs in the project root on whatever
  branch is checked out.
- Background agents as long-lived non-`claude` processes — they keep their fixture
  transcripts this epic.

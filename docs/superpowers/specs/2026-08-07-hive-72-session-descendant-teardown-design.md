# HIVE-72 — Session descendants in their own process group survive app quit

**Status:** approved 2026-08-07
**Ticket:** [HIVE-72](https://behiques.atlassian.net/browse/HIVE-72)

## The defect

`killProcessGroup` (`electron/pty-host/session-manager.ts:84`) tears a session
down with `process.kill(-shellPid, signal)` — SIGTERM, then SIGKILL after a
2s grace.

The session shell is `/bin/sh -l` (`LOGIN_SHELL_ARGS`,
`electron/main/sessions/index.ts:168`) on a real pty. No `-c`, stdin a tty:
the shell is **interactive**, so job control is on, and `&` puts the
backgrounded job in **its own process group**. `kill(-shellPid)` structurally
cannot reach it.

The consequence is the one the test's own header names: a `claude` process that
outlives the app is invisible, keeps consuming tokens, and can still write to
the repository.

## What measurement showed

Reproduced against a real pty under Electron's ABI, backgrounding a job with
`&` exactly as the e2e test does:

| teardown | plain `&` job | `trap '' HUP` | `nohup` |
| --- | --- | --- | --- |
| **today** — SIGTERM → SIGKILL to the shell's pgid | **leaked** | — | — |
| SIGHUP to the shell's pgid | reaped | **leaked** | — |
| SIGHUP **+** enumerated descendant kill | reaped | reaped | reaped |

Two findings drive this design.

**SIGHUP is the missing signal.** An interactive shell *ignores* SIGTERM. That
is why today's escalation always reaches SIGKILL — and a SIGKILLed shell cannot
hang up its own jobs, which is precisely why the orphan is left behind. SIGHUP
is what a closing terminal window sends; the shell responds by HUPing every job
it owns. That alone fixes the ordinary case.

**Cooperative shutdown is not a sufficient bar.** A descendant that ignores
hangup survives SIGHUP. The processes this teardown exists to contain are
long-running agents, so the design cannot rest on the shell's cooperation.

## Approach: SIGHUP, then insist

The existing "ask, wait, then insist" shape is kept. Three changes.

### 1. Snapshot descendants *before* signalling

Load-bearing ordering, not a preference: once the shell dies its children are
reparented to `launchd`/`init` and the parent linkage is gone permanently. The
tree must be read while the shell is still alive or it cannot be read at all.

One `ps` per teardown, not per session — `killAll` passes every live session's
pid in a single call.

### 2. SIGHUP the group instead of SIGTERM

Terminates the foreground job *and* makes the shell hang up its background
jobs. This is a behaviour change for the foreground process — `claude` now
receives SIGHUP where it previously received SIGTERM. Both are terminating by
default, and SIGHUP is what the process would receive from any real terminal
being closed.

### 3. Sweep the snapshot, always

After the shells are gone — whether they exited gracefully or were SIGKILLed —
anything still alive from the snapshot is killed **by its process group first,
then by pid**. Killing the group catches grandchildren the job spawned after
the snapshot was taken.

The sweep is unconditional. The tempting shortcut — resolve as soon as the
shells have exited — is exactly the hangup-proof leak above: the shell exits
promptly on SIGHUP while the hardened descendant lives on.

A bounded settle (`SWEEP_SETTLE_MS`, 250ms) runs before the sweep so a
cooperative job that is mid-exit from SIGHUP is not needlessly SIGKILLed. It is
a courtesy, not a correctness requirement.

### Rejected

**Kill by session id.** No syscall signals a session — `kill(-n)` addresses a
process *group* only — so it reduces to the same enumeration. macOS `ps -o
sess=` prints a pointer rather than a pid, so it is also less portable than
walking `ppid`. The ticket's original `tcgetsid` suggestion is unreachable from
Node in any case (see its `UPDATED SPECS`).

**Make the shell non-interactive** (`sh -lc`). Would keep `&` in one process
group and fix this in a line, but job control is a feature the pty exists to
provide (`session-manager.ts:28` names it explicitly). Trading this bug for a
terminal that cannot background a job is a worse outcome.

## Components

### `electron/pty-host/process-tree.ts` (new)

The only module that reads the process table.

```ts
export interface Descendant {
  pid: number;
  pgid: number;
}

export interface ProcessControl {
  /** Signal a process group. */
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
  /** Signal a single process. */
  signalPid(pid: number, signal: NodeJS.Signals): void;
  /** Every descendant of every root. Resolves empty when unreadable. */
  descendants(roots: readonly number[]): Promise<Descendant[]>;
}
```

`descendants` runs `ps -eo pid=,ppid=,pgid=`, parses it into a child map, and
walks breadth-first from each root, excluding the roots themselves. It **never
rejects**: a failed, timed-out, or unparseable `ps` resolves to `[]`, and
teardown falls through to the group kill it does today. Degrading to current
behaviour is acceptable; blocking the app's quit path is not.

- `PS_TIMEOUT_MS` = 2000, enforced by `execFile`'s own timeout. Async, not
  `execFileSync`: a wedged `ps` must not be able to stop the app from quitting.
- Cycle-safe. A `ppid` loop cannot be produced by a sane kernel, but a parser
  that can infinite-loop on malformed input has no business on the quit path.
- `win32` short-circuits to `[]` without exec'ing anything. No Windows build is
  packaged (`electron/main/config/probe.ts:21`); this is about not shelling out
  to a `ps` that does not exist.

### `electron/pty-host/session-manager.ts` (modified)

`SessionManagerOptions.killGroup` widens to `control?: ProcessControl`. It is
the same injection seam `tests/electron/pty-host/session-manager.test.ts`
already uses, so no test signals a real process and no new plumbing is needed.

Both `kill()` and `killAll()` route through one shared teardown:

1. `snapshot = await control.descendants(pids)` — before any signal.
2. `signalGroup(pid, 'SIGHUP')` for each session.
3. Wait on the existing `exitWatchers` for the shells, capped at
   `killGraceMs`.
4. `signalGroup(pid, 'SIGKILL')` for any shell still live.
5. Settle `SWEEP_SETTLE_MS`, then for each snapshot entry still alive:
   `signalGroup(pgid, 'SIGKILL')`, then `signalPid(pid, 'SIGKILL')`.

`kill()`'s default signal becomes SIGHUP.

**`kill()` is included deliberately, not only `killAll()`.** Closing a single
session leaks its background jobs by exactly the same mechanism; the ticket
frames the defect as app-quit because that is where it was found, not because
it is quit-specific.

Every signal stays wrapped in the existing ESRCH-tolerant `try/catch` — a
process dying between the decision and the signal is the expected case here,
not an error.

## Testing

**`tests/electron/pty-host/process-tree.test.ts` (new)** — parsing and walking
against fixture `ps` output: multi-level descent, several roots in one call,
roots excluded from their own results, malformed lines skipped, a `ppid` cycle
terminating, `win32` returning `[]` without exec, and a rejecting/timing-out
`ps` resolving `[]`.

**`tests/electron/pty-host/session-manager.test.ts` (modified)** — through the
injected `ProcessControl`, recording an ordered call log:

- `descendants` is called **before** the first signal. The ordering assertion is
  the one that protects the reparenting constraint; without it a later
  refactor can silently reintroduce the bug with every other test still green.
- SIGHUP, not SIGTERM, reaches the group.
- A descendant alive after the grace is SIGKILLed by pgid **and** pid.
- A descendant already dead is not signalled.
- The sweep runs even when every shell exited promptly — the hangup-proof case.
- `descendants` resolving `[]` still kills the session groups.
- `killAll` with no live sessions reads no process table.

**`tests/e2e/electron/session-lifecycle.spec.ts` (modified)** — the existing
descendant test stays and must pass under `--workers=1`. A second case covers a
descendant that ignores SIGHUP, which is the half unit tests cannot prove.

The `afterAll` `pkill -f 'sleep 300'` gets a **per-test unique sentinel** in the
backgrounded command, so the pattern can only ever match the process the test
itself started. Acceptance asks that it stop deciding another worker's outcome;
scoping the pattern achieves that while still cleaning up after a failed run,
where deleting the hook outright would strand `sleep`s.

## Acceptance

- A backgrounded descendant of a session shell is gone after the app quits,
  asserted by its own pid. — e2e, both the plain and hangup-proof shapes.
- The test passes serialized (`--workers=1`), not only under parallelism. —
  verified by running it that way.
- The `afterAll` `pkill` no longer decides another worker's test. — unique
  sentinel per test.

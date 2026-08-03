# HIVE-48 — Orchestrator & Inbox Drive Real PTYs (story 097)

**Goal:** the console's `send` and the session message row stop faking a
round-trip and put text into the actual Claude Code session. One primitive,
`pty.write(sessionId, text + '\r')`, reached from every call site that means
"say something to a session".

**Scope note (agreed before planning):** the inbox is **cut** from this story.
See Deviation 1.

## Reconciliation decisions

Confirmed with the reporter before any code was written. Each is a place where
the ticket describes a codebase that no longer exists, or a design that its own
architecture rules forbid.

### 1. The inbox has no answer action to route — cut

The ticket names three call sites and says each "fakes its round-trip on a
timer". The inbox does not: `src/features/inbox/components/notification-card.tsx`
is a single button that calls `openTab(notif.target)` and `markRead(index)`.
There is no text input, no send path, and no timer. Story 051's own spec defines
exactly that behaviour and nothing more, and the concept models answering as
`send <id> <answer>` typed into the console — never as an inbox affordance.

**Resolution: follow the code.** The inbox is untouched by this story. Its
"answer" is the jump to the terminal, which already works and is already covered
by `tests/e2e/web/waiting-session.spec.ts`. Building a quick-reply input would be
net-new UX that no story specifies. The ticket's inbox row and its Playwright
assertion are withdrawn rather than silently skipped.

### 2. The primitive lives in `lib/terminal/`, not `features/shared/`

The ticket puts `sendToSession` in `features/shared/` "because feature slices may
not import each other". But both call sites that need it — `runOrchCommand` and
`sendToEntity` — live in `src/stores/hive-store.ts`, and `eslint.config.mjs`
places `stores/` at the bottom of the dependency graph: it may not import
`features/**`, `shared` included. The ticket's placement is unreachable for its
own stated reason.

**Resolution: follow the code.** `src/lib/terminal/session-input.ts`. `stores/`
may import `lib/` (it already imports `@lib/fake-clock`), and "write text into a
pty" is a terminal concern rather than a cross-feature one. The module reads no
store — ids arrive as arguments, the same discipline `pty-transport.ts` already
documents for itself, and the same discipline that keeps this out of an import
cycle with `resolve-transport.ts`.

### 3. Liveness comes from the channel map, not `isLiveTerminal`

`isLiveTerminal(entityId)` answers "should a PTY back this surface?" — desktop,
a session, not the console. It does **not** answer "is there a process alive
right now", and the ticket's requirement is the latter: *refuse when the session
has no live pty, with the reason*. Writing into a dead session is a silent no-op
in main (`electron/main/sessions/index.ts` `write()` returns early when the
registry has no session id), which is precisely the outcome the ticket calls the
worst possible one.

**Resolution:** `pty-transport.ts` already tracks `spawnRequested` and `closed`
per entity in its module-level channel map. It exports `isChannelLive(entityId)`.
That map *is* the renderer's record of pty liveness, it already knows about
exits, and reading it introduces no store dependency.

### 4. `sendToEntity` gains a return type

The ticket says "implementation, not signature". It also requires that every
failure path prints its specific message, and the console is the only layer that
can place that line in the console transcript. The action must therefore report
what happened.

**Resolution: deviate deliberately.** `sendToEntity` returns a discriminated
outcome instead of a bare timer handle. The demo variant still carries the timer,
so the simulation and the existing tests keep their deterministic cancel.

```ts
type SendOutcome =
  | { kind: 'routed' }
  | { kind: 'refused'; reason: string }
  | { kind: 'demo'; timer: ReturnType<typeof setTimeout> };
```

### 5. The fake round-trip timer is gated, not deleted

The ticket asks for the timer and its tests to be deleted. It also requires that
the browser target's e2e suite still passes and that the payoff spec stays on the
browser target. Those cannot both hold: `tests/e2e/web/waiting-session.spec.ts`
and `tests/e2e/web/orchestrator.spec.ts` assert `● Acknowledged — working on it`,
which only the timer produces.

**Resolution: follow the code.** The timer is reached only when no live pty backs
the entity — the browser target and agents, which have no project and no process
this epic (story 096's own scope note). A live desktop session takes the pty path
and has no timer at all. The acceptance criterion becomes *no timer on the
desktop path*, which is what "session status stops being narrated by the UI"
actually requires.

### 6. `spawn` already reaches a real pty; the console cannot see the refusal

The ticket's table reads as though `spawn` currently pushes a fixture entity and
must be rewritten to spawn for real. It already spawns for real: `spawnSession`
opens the tab, `resolveTransport` hands the entity a `PtyTransport`, and
`ensureSpawned` requests the process on mount. What is genuinely missing is the
console *printing* main's refusal — today it is caught inside `ensureSpawned` and
written into the terminal, asynchronously, and only if a surface mounted.

**Resolution:** the store requests the spawn eagerly **through the channel**, so
the same `spawnRequested` flag is set and the transport will not re-request on
mount. The console prints main's exact string. This is safe in both orders: main's
`open()` is attach-never-respawn.

### 7. `spawn <task>` is delivered by main's bootstrap

The ticket sends the task from the renderer "once the TUI is ready". The renderer
has no such signal — `session:status` carries only `working | idle | done`, and
by design cannot carry more. Readiness already lives in main:
`BOOTSTRAP_DEBOUNCE_MS` and `BOOTSTRAP_FALLBACK_MS`.

**Resolution:** `bootstrap.arm(entityId, command, task?)` gains a second stage.
`fire()` writes `claude\r`; if a task is pending it re-arms with the task and
`settling: false`, so the TUI's first paint restarts the same debounce and the
task goes in after it. One mechanism applied twice rather than a second readiness
heuristic in a layer that cannot observe readiness. "Not again on reattach" is
free — `arm` is reached only from `spawn`, never from `open`'s attach path.

`SpawnRequest` gains an optional `task`, so the preload bridge allowlist test
moves deliberately, as it did in stories 093 and 096.

## Architecture

```
                    ┌─────────────────────────────┐
  console `send` ──►│                             │
                    │   stores/hive-store.ts      │
  message row ─────►│   sendToEntity / runOrch    │
                    └──────────┬──────────────────┘
                               │ live?          │ not live
                               ▼                ▼
              lib/terminal/session-input.ts   demo round-trip
                     sendToSession            (unchanged timer)
                               │
                               ▼
              lib/terminal/pty-transport.ts
                 isChannelLive / requestSpawn
                               │
                               ▼
                    window.hive.pty.write
```

The branch is in exactly one place. `session-input.ts` owns the wire format;
the store owns the UX per call site; `pty-transport.ts` owns liveness.

## Components

### `src/lib/terminal/session-input.ts` (new)

```ts
export type SendResult = { ok: true } | { ok: false; reason: string };
export function sendToSession(entityId: string, text: string): SendResult;
export function normalizeInput(text: string): string;   // exported for tests
```

- Newlines (`\n`, `\r`, `\r\n`) collapse to single spaces. A multi-line paste
  would otherwise submit its first line and leave the rest half-typed at the
  prompt.
- The submitted text is suffixed with `\r`. Not `\n` — a terminal's Enter key
  sends carriage return, and a line feed is not universally treated as submit.
  `bootstrap.ts` already documents and relies on the same fact.
- Refuses when no live channel backs the entity, naming the reason. It writes
  nothing on refusal.
- Reads no store. Touches no DOM.

### `src/lib/terminal/pty-transport.ts` (modified)

Two new exports over the existing channel map; no change to `TerminalTransport`.

- `isChannelLive(entityId): boolean` — a channel exists, a spawn was requested,
  and it has not closed.
- `requestSpawn(entityId, projectId): Promise<SendResult>` — the eager path for
  Deviation 6. Shares `ensureSpawned`'s idempotence flag so exactly one spawn
  request is ever made per entity, whoever asked first.

### `src/stores/hive-store.ts` (modified)

- `sendToEntity(id, msg, origin)` — routes to `sendToSession` for a live entity:
  a feed item, **no transcript echo** (echo is the pty's job — appending here
  would double-print every message) and no timer. Otherwise the existing demo
  round-trip, unchanged.
- `runOrchCommand`'s `send` case — prints `routed → <id>` or the refusal, in red,
  from the returned outcome.
- `runOrchCommand`'s `spawn` case — on a live target, awaits `requestSpawn` and
  prints main's exact refusal string on failure.
- `spawnSession` — carries the task through to the spawn request.

`parse-command.ts` is not touched. Shape errors stay in the parser, existence
errors stay in the executor; this story only changes the executor, which is what
the parser's own contract comment already says should happen.

### `electron/` (modified)

- `electron/shared/ipc-contract.ts` — `SpawnRequest.task?: string`, and its guard.
- `electron/main/ipc/pty.ts` — carries `task` through to the sessions layer.
- `electron/main/sessions/index.ts` — passes `request.task` to `bootstrap.arm`.
- `electron/main/sessions/bootstrap.ts` — the second stage described above.
- `electron/preload/index.ts` — no verb added; `SpawnRequest` widened only.

## Error handling

| Failure | Where it is decided | Where the user reads it |
| --- | --- | --- |
| no live pty for `send` | `session-input.ts` | console line (red) / activity feed |
| project not mapped | main, `spawnRefusal` | console line (red), verbatim |
| session cap reached | main, `spawnRefusal` | console line (red), verbatim |
| pty host unavailable | main, `spawnRefusal` | console line (red), verbatim |

Main's wording is printed verbatim. The console does not translate or soften it —
`<project> is not mapped — add it to <path>` names the file to edit, and that is
the entire actionable part.

**The browser target produces none of these.** `not-desktop` is not a refusal
here: with no bridge there is no live channel, so `send` and `spawn` both fall to
the demo round-trip, which is the browser build's whole purpose (Deviation 5).
`SESSIONS_REQUIRE_DESKTOP` stays where story 096 put it — reached by `restart`,
not by this story — and the store could not import it regardless, since it lives
in `features/sessions/`.

## Testing

**Vitest**

- `normalizeInput`: newlines collapse to spaces; the payload is `\r`-suffixed.
- A refusal writes nothing — the bridge's `write` is never called.
- The renderer appends no transcript line on the live path (the double-print
  guard).
- Each spawn refusal string reaches the console transcript exactly as main worded
  it.
- Agents and the browser target still take the demo round-trip and still
  acknowledge on the timer.
- `bootstrap`: the task is written once, after the second debounce, and a
  re-`arm` does not stack it.
- `parse-command.ts` has a zero-line diff and its existing tests pass untouched.

**Playwright — `tests/e2e/electron/`**

- `send <id> echo routed-ok` puts the text in that session's terminal.
- `spawn <project> <task>` reaches a prompt and the task is delivered once.
- An unmapped `spawn` prints main's refusal in the console.

**Playwright — `tests/e2e/web/`**

Unchanged, and green. That suite is the regression signal for Deviation 5: if the
demo round-trip breaks, those specs fail.

## Out of scope

- Detecting that a session is asking a question — the follow-up hooks epic. No
  real session enters `waiting` in this story; inbox items for real sessions
  remain fixture-seeded.
- Any inbox code change (Deviation 1).
- Orchestrator-to-session protocols beyond typed text.
- Making the console itself an agent. It stays a command surface.

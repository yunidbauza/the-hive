# 097 — Orchestrator & Inbox Drive Real PTYs

| | |
|---|---|
| **ID** | HIVE-097 |
| **Epic** | Real terminals |
| **Depends on** | [096-session-lifecycle-claude.md](096-session-lifecycle-claude.md), [085-electron-test-harness.md](085-electron-test-harness.md), [041-orchestrator-console.md](041-orchestrator-console.md), [043-session-view.md](043-session-view.md), [051-inbox-panel.md](051-inbox-panel.md) |
| **Blocks** | — |
| **Points** | 5 |
| **Location** | `app/src/features/orchestrator/`, `app/src/features/sessions/`, `app/src/features/inbox/` |

## Story

> As a user, I want the console's `send`, the message row and the inbox's answer button
> to all put text into the actual Claude Code session, so the coordination layer stops
> being a demo of routing and starts being routing.

## One primitive

The prototype has three separate paths that all mean "say something to a session":
`sendToEntity` from the message row ([043](043-session-view.md)), `send <id> <msg>` from
the console ([041](041-orchestrator-console.md)), and the answer action in the inbox
([051](051-inbox-panel.md)). Each fakes its round-trip on a timer.

All three collapse to one thing:

```ts
pty.write(sessionId, text + '\r')
```

That is the entire mechanism. Claude Code's TUI is at a prompt; text plus a carriage
return is what a person typing would produce, so it is what the orchestrator produces.
No message bus, no protocol, no injection format.

The three call sites keep their distinct UX and share one implementation
(`sendToSession` in `features/shared/`). Cross-feature reuse goes through `shared/`
because feature slices may not import each other — the existing rule
([014](014-architecture-boundaries.md)), and this is exactly the case it is for.

### Details that matter

- **`\r`, not `\n`.** A terminal's Enter key sends carriage return. Line feed is not the
  same key and TUIs do not universally treat it as submit.
- **Newlines inside the text are stripped**, replaced with spaces. A multi-line message
  pasted into the row would otherwise submit its first line and leave the rest as a
  half-typed second prompt.
- **Refuse when the session has no live pty**, with the reason. Writing into a dead
  session is a silent no-op — the worst possible outcome for a routing layer.
- **Echo is the pty's job.** Do not append the sent text to the transcript from the
  renderer; it will arrive as terminal echo. Doing both double-prints every message.

## Console verbs

`parseCommand` ([`parse-command.ts`](../app/src/features/orchestrator/utils/parse-command.ts))
is **unchanged**. It is pure by contract and its comment already draws the right line:
shape errors in the parser, existence errors in the executor. Only the executor changes.

| Verb | Before | After |
|---|---|---|
| `help`, `status`, `clear` | store | unchanged |
| `open <id>` | store | unchanged — view state, not a process |
| `send <id> <msg>` | fake ack on a timer | `sendToSession` |
| `spawn <repo> <task>` | pushes a fixture entity | real spawn ([096](096-session-lifecycle-claude.md)) |

`spawn` gains real failure modes, each printing the exact message from
[096](096-session-lifecycle-claude.md) — unmapped project, session cap, host
unavailable, wrong target. The console prints them; it does not translate or soften
them.

`spawn`'s `<task>` argument has nowhere real to go: the session starts `claude` at a
fresh prompt with no task. Rather than silently dropping it, the task is sent as the
first message once the TUI is ready — the same `sendToSession` primitive, applied once.
That keeps `spawn apfm-web "fix the hero"` meaning what it reads as.

## Inbox

The answer action ([051](051-inbox-panel.md)) routes to `sendToSession` for the
notification's entity, then marks it read. Behaviour is otherwise unchanged, including
the jump-to-terminal navigation.

The honest caveat from [096](096-session-lifecycle-claude.md) applies and must be
stated in the UI rather than papered over: **no real session enters `waiting` on its
own** in this epic. Inbox items for real sessions are fixture-seeded. The answer path is
real — it puts text into a live pty — but what put the item there was not. Detection is
the follow-up hooks epic.

This is why the payoff spec ([070](070-e2e-harness.md)'s `waiting-session.spec.ts`)
stays on the browser target for now, and a desktop variant asserts only the half that
is real: answering routes to the pty and the text arrives.

## Store shape

`hive-store` keeps its actions and selectors. `sendToEntity` changes implementation, not
signature — the fake ack timer is replaced by a pty write plus the activity-derived
status from [096](096-session-lifecycle-claude.md).

Removing the timer is the point: session status stops being narrated by the UI and
starts being observed. The tests that asserted the fake round-trip are rewritten to
assert routing, and the deletion of those timer tests is a deliverable, not a
regression.

## Tests

Vitest:

- All three call sites reach one `sendToSession`; the browser target reaches none of
  them and shows the demo refusal ([083](083-runtime-target-transport.md)).
- Text is suffixed with `\r`; embedded newlines become spaces.
- Sending to a session with no live pty refuses with the reason and writes nothing.
- The renderer does not append sent text to the transcript.
- `parse-command.ts` has a zero-line diff — asserted in review, and its existing tests
  pass untouched.
- Each `spawn` failure mode prints its exact message.
- `spawn` with a task sends it once, after readiness, and not again on reattach.

Playwright (`tests/e2e/electron/`):

- `spawn` a mapped project from the console → a real session appears and reaches a
  prompt.
- `send <id> echo routed-ok` → the text appears in that session's terminal.
- Answering an inbox item puts its text into the target session's terminal.

## Acceptance criteria

- [ ] Typing in the message row makes text appear at the Claude Code prompt and submit.
- [ ] `send <id> <msg>` from the console does the same for any live session.
- [ ] Answering an inbox item routes to the right session's pty.
- [ ] `spawn <repo> <task>` creates a real session and delivers the task as its first
      message.
- [ ] Every failure path prints its specific message; nothing fails silently.
- [ ] No message is double-printed.
- [ ] `parse-command.ts` is unchanged.
- [ ] The browser target still shows the demo refusals and its e2e suite passes.
- [ ] The fake-round-trip timer and its tests are deleted.

## Out of scope

- Detecting that a session is asking a question — the follow-up hooks epic.
- Orchestrator-to-session protocols beyond typed text.
- Making the orchestrator console itself an agent. It stays a command surface
  ([083](083-runtime-target-transport.md)).
- Background agents running real processes.

# `/clear` marks a session done — design

**Status:** built, with one gap — see *Coverage* at the end.

## The question this answers

`terminated` has a producer: the pty exits and `activity.ts` reports it. `done`
has none — the only sessions that ever had it were two fixtures, and removing
the seeded demo fleet left it a status with a label, a colour, and nothing that
can reach it.

The distinction the user wants:

| The user does | What happened | Status |
| --- | --- | --- |
| `/exit` | the process ended | `terminated` |
| `/clear` | the *conversation* ended; the terminal is still open and a new conversation begins in it | `done`, and a new active row |

## Why this was previously rejected, and what changed

`electron/shared/hook-contract.ts` documents why `SessionEnd` is not subscribed:

> Claude Code fires `SessionEnd` with a `reason` of
> `clear | logout | prompt_input_exit | other`, and only some of those mean the
> process ended — `/clear` fires it on a session that is alive and sitting at its
> prompt. Subscribing it and mapping it to `terminated` regardless … made
> `/clear` lock the user out of a working session. **Reading `reason` would fix
> that case and still leave a hook asserting a process death it cannot observe.**

That paragraph weighs two options and rejects both. The third — map
`reason: 'clear'` to something that is *not* a death — was unavailable because
`done` had no producer to map to. It does now, and the existing division gets
sharper rather than muddier:

- **the pty** answers *is the process there?* → `terminated`
- **the hooks** answer *what is the agent doing?* → `working`/`waiting`/`idle`,
  and *did this conversation end?* → `done`

A conversation boundary is precisely what a hook can observe and a pty cannot.

## The probe

Run against a real `claude` (2.1.225) in a real pty, outside the app, because
the question is about Claude Code's behaviour and not our plumbing. Project-local
`.claude/settings.json` logging `SessionStart` / `SessionEnd` payloads; the pty
driven by `node-pty`, `/clear` then `/exit`.

`/clear`, with the pty **alive before and after**:

```jsonc
{ "hook_event_name": "SessionEnd",   "reason": "clear", "session_id": "cfb05e92…" }
{ "hook_event_name": "SessionStart", "source": "clear", "session_id": "f6c7251f…" }
```

`/exit`, for contrast:

```jsonc
{ "hook_event_name": "SessionEnd", "reason": "prompt_input_exit", "session_id": "f6c7251f…" }
// pty exits, code 0
```

Three findings, all load-bearing:

1. **`/clear` is a boundary, not a death.** Measured, not assumed.
2. **`/exit` is distinguishable** — `prompt_input_exit`, not `clear`.
3. **Claude mints a new `session_id` across the clear.** This is the finding that
   makes the whole design cheap, and it was the obstacle expected to be hardest.

## Two ids, two jobs

`HIVE_SESSION_ID` is baked into the pty's environment at spawn
(`hooks/index.ts`), so it cannot name the conversation that *replaces* the one
that was cleared. Claude supplies that half itself:

| Id | Owner | Lifetime | Job |
| --- | --- | --- | --- |
| `x-hive-session` | ours, env-baked | the pty | **correlates** the event to a terminal |
| `session_id` | Claude's | one conversation | marks the **generation** inside it |

This does **not** reintroduce the complexity `hook-contract.ts` rejected. That
objection was to using `session_id` *for correlation* — "a second table that has
to be right at exactly the moment a session is starting". Here the header still
correlates and the mapping stays the identity function; `session_id` is only read
as a generation marker within an already-correlated terminal. Different job.

`SessionEnd{reason:'clear'}` is the primary signal because it is explicit. A
changed `session_id` on any subsequent event is the same fact and is worth
treating as a backstop, not as the trigger.

## The model: one terminal, many sessions

The registry is `entityId → sessionId → pty`, strictly 1:1. What `/clear`
produces is one pty outliving several fleet rows, so a row id and a terminal id
stop being the same thing.

```
Terminal  (pty, stable, what the hook and registry know)
  ├─ session A   done   ← cleared
  ├─ session B   done   ← cleared
  └─ session C   idle   ← live, owns the pty
```

**`Session.terminalId` is load-bearing, not a tidiness field.**
`center-stage.tsx:245` keys the xterm instance by `entity.id`. Minting a new
entity id without this indirection remounts the terminal — wiping and replaying
the user's scrollback at the exact moment they type `/clear`, which is the most
visible possible regression. The row identity changes; the terminal identity must
not. Transport resolution keys on `terminalId`; the first session's `terminalId`
is its own id, so nothing changes for a session that is never cleared.

## Decisions taken

- **A done row is inert.** Not clickable, no terminal, no transcript. Its pty
  belongs to the session that replaced it, and serving the *new* session's live
  output under the *old* session's name would be a worse lie than the seeded data
  this all started with. This also removes the need to snapshot scrollback onto a
  static transport — the expensive half of the original sketch.
- **Done rows are capped at 20**, oldest dropped, matching `NOTIF_CAP` and
  `FEED_CAP`. A terminal cleared all day must not grow the table without bound.
- **A done session cannot be restarted.** Restart is gated on `isTerminated`
  today; it needs to be gated on `isEnded` instead, or `done` becomes a row
  offering an action that would spawn into a terminal it no longer owns.
- **The new session gets a random name**, overwritten by Claude's terminal title
  when it arrives — the existing `renameSession` path (HIVE-61), unchanged.

## Work, in dependency order

1. `hook-contract.ts` — add `SessionEnd` to `HOOK_EVENTS`. It is a *lifecycle*
   event, not a status, so it must **not** join `HOOK_STATUS`; that record maps
   events to `ObservedStatus` and `SessionEnd` has no honest entry there.
2. `receiver.ts` — extract `reason` the way `hook_event_name` is already pulled
   from a capped body, with the same regex fallback.
3. `session-contract.ts` — a `SessionClearedEvent { entityId }`, separate from
   `SessionStatusEvent`.
4. `main/sessions/index.ts` + preload — emit it on `reason: 'clear'` only; every
   other reason stays ignored, because the pty still reports the death.
5. `types/entity.ts` — `Session.terminalId`.
6. `hive-store.ts` — `clearSession(entityId)`: mark done, mint the successor with
   the same `terminalId`/project/branch/model/effort, insert into `order`, move
   the active tab, apply the done cap.
7. `resolve-transport.ts` / `pty-transport.ts` — key on `terminalId`.
8. `center-stage.tsx` — key the xterm on `terminalId`, so the instance survives.
9. Tests: a store test per branch, and an electron e2e that spawns a session,
   sends `/clear`, and asserts one done row plus one live row on one pty.

## Risks

- **Step 7 touches the terminal seam**, the codebase's stated most important
  invariant. It stays within `lib/terminal/`, which is where the seam says such
  changes belong, but it deserves its own review pass.
- **`SessionEnd` also fires on `logout` and `other`.** Only `clear` may produce
  `done`; anything else must fall through to the pty's verdict. The first version
  of this feature shipped by mapping the event regardless, and that is the bug
  the contract doc was written about.
- **An unhooked session never emits this.** Sessions whose hooks are disabled or
  could not bind still fall back to pty inference, so `/clear` there is invisible
  and the row simply keeps running — degraded, not wrong.

## Coverage, and the one gap

Covered, each against the real thing rather than a mock of it:

| Seam | Where |
| --- | --- |
| Claude really emits `SessionEnd{reason:'clear'}`, pty alive | the probe above, real `claude` in a real pty |
| The `reason` gate — `clear` acts, everything else is ignored | `tests/electron/main/hooks/receiver.test.ts`, real HTTP server and headers |
| `SessionEnd` is subscribed but can never be a status | `tests/electron/main/hooks/settings.test.ts` |
| Retire, mint, inherit the terminal, ordering, the cap, every refusal | `tests/stores/hive-store.clear-session.test.ts` (17 cases) |
| One surface per terminal, and no xterm rebuild across the swap | `tests/components/terminal/terminal-host.test.tsx` |
| A cleared row cannot be opened or typed into | `hive-store.test.ts`, `resolve-transport.test.ts` |

**The gap: no end-to-end spec drives a real `/clear` through the built app.**

One was written and withdrawn rather than shipped half-working. The approach was
sound — have the session's own stub command POST the hook using
`$HIVE_SESSION_ID` and `$HIVE_HOOK_TOKEN` from its environment, which is exactly
what Claude's `http` handler does and exercises the correlation path rather than
mocking past it. It got as far as the receiver binding and the settings file
being found, but the POST never landed: most likely the stub is delivered as
typed shell input and the quoting does not survive it.

What is unproven is therefore narrow: main's `publishCleared` → `session:cleared`
→ the renderer's subscription. Every hop is typed end to end and each side is
tested, so the risk is a wiring mistake rather than a design one — but it is
unproven, and worth closing with a spec that has room to debug the stub quoting.

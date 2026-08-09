# Syncing a session's real branch — design note

Not implemented. This records what the problem actually is and the shape a fix
should take, so the next person does not have to re-derive it.

## The defect

`spawnSession` assigns `branch: \`feat/${id}\`` (`src/stores/hive-store.ts`).
Nothing creates that branch. No git command runs anywhere in the spawn path —
main shells out to git only for `clone` and for the `isRepo` check in
`electron/main/config/resolve.ts`.

So the string is a **fiction**. The session meta bar and the orchestrator's
BRANCH column display `feat/sess-01` while the terminal is sitting on `main`,
and the label stays wrong after the user creates a branch or a worktree inside
the session. It is not a stale value — it was never true.

This matters more than a cosmetic mislabel, because the intended workflow is
that all development happens in worktrees. The branch a session is really on is
decided *inside* the session, minutes after it opens, by the user or the agent.
The app should not guess it up front; it should observe it.

## Why "just don't show it" is not the fix

Removing the field would delete a column the fleet table exists to carry — when
ten terminals are open, "which branch is this one on" is one of the two things
that distinguishes them (the other is the repo). The answer is to make it true,
not to drop it.

An honest interim step is to make `Session.branch` optional and render an em
dash until something reports one. That is small, and it is strictly better than
a confident wrong answer.

## The shape of the fix

There is an exact precedent: **`session:name`**. Claude writes its display name
into the terminal title, main observes it, and pushes it over a dedicated
renderer channel (`CH.sessionName`, `electron/shared/ipc-contract.ts`).
`src/features/sessions/hooks/use-session-status.ts` is the entire renderer half
— one listener, mounted once at the composition root, calling one store action.

A `session:branch` channel is the same shape:

| Piece | Where |
| --- | --- |
| `CH.sessionBranch: 'session:branch'` | `electron/shared/ipc-contract.ts` |
| `SessionBranchEvent { entityId, branch }` | `electron/shared/session-contract.ts` |
| Observation + push | `electron/main/sessions/` |
| `setSessionBranch(id, branch)` | `src/stores/hive-store.ts` |
| `bridge.session.onBranch(...)` | `src/features/sessions/hooks/use-session-status.ts` |

Keep it a separate channel from `session:status`, for the reason the contract
already gives for the name: status is frequent and machine-driven, a branch
change is rare and user-driven, and folding them together makes every status
tick carry a branch main did not observe on that tick.

## The part that has no precedent

`session:name` is free because the agent *reports* the name — main reads a
terminal title it is already receiving. A branch is not reported by anybody, so
main has to go and look, and that needs two things it does not currently have:

1. **The session's live working directory.** The pty is spawned with a `cwd`
   (`electron/pty-host/session-manager.ts`), but the user can `cd` into a
   worktree, which is precisely the case this feature exists to catch. The spawn
   cwd is therefore the wrong answer most of the time. Resolving the *current*
   cwd means inspecting the shell process — on macOS, something in the shape of
   `lsof -a -p <pid> -d cwd` against the right pid in the pty's process tree.
2. **A cadence.** `git -C <cwd> rev-parse --abbrev-ref HEAD` is cheap, but "per
   session, forever" is not. `integrations-section.tsx` already writes down the
   argument against polling for the `gh` status, and it applies here. Better
   triggers exist: the session going `idle` (main already derives that), the
   window regaining focus, or the WORK/PROJECTS panel mounting.

An alternative worth weighing before building the above: have the **agent**
report it, the way it reports its name. A Claude Code hook that echoes the
branch after any command that could change it would make this cost nothing in
main — at the price of only working for sessions with hooks enabled, which is
the same trade `session:status` already makes for `waiting`.

## Also missing: a way to test it

Neither e2e target can currently render a real ticket or exercise a Jira-backed
surface end-to-end. The browser target has no bridge. The electron target has
one, but the suite has no Jira stub, and `electron/main/integrations/jira/
client.ts` builds every request as `https://${site}` — so a stub means an HTTPS
server with a certificate the app accepts. Worth solving once; several stories
would use it.

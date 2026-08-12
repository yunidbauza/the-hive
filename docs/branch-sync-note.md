# A session's real branch, name and ticket

Implemented in HIVE-78. This file was the design note written when the defect
was diagnosed but not fixed; it now records what shipped, and — more usefully —
which of its own predictions turned out to be wrong.

## The defect it described

`spawnSession` assigned ``branch: `feat/${id}` `` (`src/stores/hive-store.ts`).
Nothing created that branch. No git command ran anywhere in the spawn path.

So the string was a **fiction**. The session meta bar and the orchestrator's
BRANCH column displayed `feat/sess-01` while the terminal sat on `main`, and the
label stayed wrong after the user created a branch or a worktree inside the
session. It was not a stale value — it was never true.

That mattered more than a cosmetic mislabel, because the intended workflow is
that development happens in worktrees. The branch a session is really on is
decided *inside* the session, minutes after it opens, by the user or the agent.
The app should not guess it up front; it should observe it.

## What shipped

`Session.branch` is **optional**, and only ever holds what main observed.
`branchLabel()` in `src/types/entity.ts` renders an em dash for the rest, at all
three surfaces.

| Piece | Where |
| --- | --- |
| `CH.sessionBranch: 'session:branch'` | `electron/shared/ipc-contract.ts` |
| `SessionBranchEvent { entityId, branch, cwd }` | `electron/shared/session-contract.ts` |
| `git rev-parse` reader, cached and rate-limited | `electron/main/sessions/git.ts` |
| Observation + push | `electron/main/sessions/index.ts` (`publishBranch`) |
| `setSessionBranch(id, branch, cwd)` | `src/stores/hive-store.ts` |
| `bridge.session.onBranch(...)` | `src/features/sessions/hooks/use-session-status.ts` |

A separate channel from `session:status`, for the reason this note originally
gave and which still holds: status is frequent and machine-driven, a branch
change is rare and user-driven, and folding them together would make every
status tick carry a branch main did not observe on that tick.

## The prediction that was wrong

This note said main needed two things it did not have, and proposed solving the
first with `lsof -a -p <pid> -d cwd` against the pty's process tree.

**That was unnecessary.** Every Claude Code hook payload already carries `cwd`,
and it is better than the shell's: it is the *agent's* working directory, so it
follows a session into a worktree even when the login shell never moves. The
hook receiver added by HIVE-62 was already receiving it and throwing it away.

The second thing — a cadence — was real, and the answer was the one this note
guessed at. Hook events *are* the trigger: they fire when the agent does
something, which is exactly when a branch can have changed, and they stop when
it does not. `sessions/git.ts` adds a 2-second floor per directory and a shared
in-flight promise, so a burst of hook events in one turn costs one `git` spawn;
`publishBranch` then drops anything that did not change, so a quiet fleet
produces no IPC at all.

There is also a **spawn-time read**, which this note did not consider. Without
it a session shows an em dash until its first hook lands — the whole time a user
who opens a session and reads it before typing is looking at it. It also means
sessions with no hooks (the receiver could not bind, the user disabled them, the
agent is not Claude) still show the branch they started on rather than nothing.
That is the honest floor: the branch the session opened on, never one nobody
created.

The alternative this note floated — having the agent report the branch the way
it reports its name — was not needed, since the payload already says where the
agent is.

## Two things that rode along

The same payload answers two more questions the app was previously guessing at.

**Names.** A session started from a ticket card is now called `HIVE-73` rather
than `sess-07`, de-duplicated across the whole fleet — ended rows included,
since `DONE_CAP` keeps them visible — as `HIVE-73-2`, `HIVE-73-3`. The name goes
out as `--name` too, so the agent's own prompt box agrees with the rail. The
**id** is untouched: it is the entities-map key, and rekeying it on a label
change would turn a cosmetic event into a graph rewrite.

**Ticket intent.** `UserPromptSubmit` carries the user's prompt, so "work on
ABC-123" typed at an agent now associates that session with the issue and pins
its name to the key. Three constraints shape it:

1. **The prompt never leaves main.** `hooks/ticket-intent.ts` matches inside the
   receiver and emits only the key. A channel that forwarded prompts to the
   renderer would be a materially different thing from a status side-channel.
2. **Main matches a shape; the renderer confirms it.** `HTTP-404` is
   key-shaped. The renderer puts the candidate to `jira:issue` and acts only on
   an issue that exists.
3. **Intent, not mention.** "work on ABC-123" associates; "the PR for ABC-123
   broke CI" does not. The verb list and the filler grammar are enumerated
   rather than fuzzy, because the cost of a wrong answer is work silently filed
   under someone else's ticket with nothing on screen to explain it.

The rename is defended by `Session.namePinned`, which makes the store ignore
agent-reported titles. It has to be defended: Claude repaints its title several
times a second, so an undefended name survives about one frame. Writing
`/rename` into the pty was the alternative and was rejected — it types into a
live input box at a moment the app chose.

## The explorer follows too

A session in a worktree made the PROJECTS tree a second lie: it kept showing the
mapped project while the agent edited somewhere else.
`lib/explorer/session-root.ts` resolves a project-relative prefix from the
observed `cwd`, and the panel roots the tree there.

This does **not** widen `electron/main/fs/paths.ts`. A worktree at
`<project>/.claude/worktrees/<name>` is already inside the project root, so the
retarget is a prefix and every read goes through the same guard. A cwd outside
the mapped project resolves to `''` and the tree stays put — the guard would
refuse those paths anyway, so showing the project root is better than an error
about a path the panel should not have asked for.

Paths stay project-relative (`.claude/worktrees/x/src/a.ts`), which settles the
editor question for free: the same file in two worktrees is two keys in
`editor-store`, so opening one cannot mark the other stale.

## Still missing: a way to test the hook-driven half end to end

This part of the original note stands. `tests/e2e/electron/session-branch.spec.ts`
covers the spawn-time read against a real repository on a real branch, which is
the connection the unit suite cannot make. It does **not** cover a worktree move,
because `claudeCommand` is stubbed suite-wide and no hook ever fires — driving
that end to end needs a real agent in the loop.

The Jira gap is also unchanged: neither e2e target can render a real ticket. The
browser target has no bridge; the electron target has one but no Jira stub, and
`integrations/jira/client.ts` builds every request as `https://${site}`, so a
stub means an HTTPS server with a certificate the app accepts. Worth solving
once — the ticket-intent path is now a third story that would use it.

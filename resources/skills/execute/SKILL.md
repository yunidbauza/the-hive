---
name: execute
description: Use when a written plan exists and it is time to build it. Runs the plan task by task with a commit each, inline by default, and escalates to subagents only when the plan spans two or more subsystems with no shared test harness and touches a risk surface. Used by the builder agent and by work-on --inline and goal-on.
---

# Execute a plan

One skill, two modes, one set of prompts. The rules come from two audits of
real sessions (AGENTS.md, "Working a ticket"): the hours went to a serial
implement-review-re-review chain, and the whole-branch review at ship still
found what fifteen per-task reviews missed. So: inline by default, review only
where risk lives, two fix rounds, no re-review agent, and the seams belong to
ship's self review (the `pr-review` skill, run by the shipper's reviewer agent
once it ships, or by the person until then).

## Setup

1. Read the plan and its spec once. One todo per task. Read the plan
   critically first: a gap that stops you is raised now, not at task six.
2. `ledger_claim <ticket or plan slug>`, unless the caller already holds it
   (the builder claims before it invokes this skill). Progress lines go to
   `<repo>/.hive/sdd/<plan-basename>/progress.md`, one line per task and one
   per ruling: `Ruling: <what>; <why>; <cost if wrong>`. Make sure
   `<repo>/.hive/.gitignore` exists with the single line `*` before the first
   commit; `brainstorm` writes it, but not every path runs brainstorm, and a
   per-task `git add` would otherwise sweep the progress file into the PR.
3. Pre-flight conflict scan: one row per pair of tasks that share a file or
   an interface, and one per task's own consistency. Rulings, never questions.

## Mode: inline (default)

You are the implementer. For each task, in order:

1. Failing test, run it, read the failure.
2. Minimal code, run it, read the pass.
3. Scoped lint and type-check on the touched paths.
4. Commit with the task's name.
5. `risk: yes` → one reviewer subagent on that task's diff
   (`prompts/task-reviewer.md`), read-only, most capable model. Fix Critical
   and Important yourself, prove each fix with the test that fails without
   it, and stop after two rounds: park what is left with a ruling. Minor goes
   to `progress.md`.
6. `risk: no` → read the diff yourself against the task block and move on.

## Mode: subagent

Only when **both** hold, decided before the first dispatch and not revisited:

- The plan spans two or more subsystems with **no shared test harness** (main
  process plus renderer plus a live suite; a migration plus an API plus a UI),
  so no one context holds the change and its tests without a compaction.
- The change touches a **risk surface**: auth, credentials, concurrency,
  money, a wire protocol, a security predicate.

Task count is not a criterion. Tightly coupled tasks force inline. An explicit
request wins over the rule.

Per task: `prompts/implementer.md` with the task block, the worktree path and
the branch; never paste prior tasks' history; batch small same-shape tasks
into one dispatch. Handle `DONE`, `DONE_WITH_CONCERNS` (read the concerns,
rule), `NEEDS_CONTEXT` (answer it, re-dispatch the same implementer),
`BLOCKED` (rule or stop). Then the same review rule as inline, with the fix
round dispatched to the **same** implementer, who returns the failing test as
proof. Two rounds, then park with a ruling.

**One writer per worktree.** Two implementers in one checkout share one git
index, and that couples them even when their files are disjoint. Parallel
writing happens only at the PR grain: separate worktree, separate branch,
separate builder run. Parallel **reading** is free: reconciliation, finding
assessments, research, all dispatched in one response.

Every dispatched prompt opens with the absolute worktree path and the
branch, and requires `git -C "$WT"` on every command and a branch assertion
before every commit. A commit that landed anywhere else is a failed task:
reset it and re-dispatch.

## Drift check (builder mode only)

After every task, one cheap, non-blocking call with `prompts/drift-check.md`
(sonnet): does the diff do what the task block says, and does anything in it
contradict the spec? A spec ❌ stops the run for one fix round; a task-2 misread
is what tasks 3 to 8 build on, and one short call is what it costs to know.
Notes go to `progress.md`; `ship` hands those lines to the whole-branch
review. Inline mode skips
the drift check: a person is reading the diffs.

## Re-split rule

Estimates are made before any task has run; the first two runs are the
measurement. **Two consecutive tasks over twenty minutes means every remaining
estimate is wrong.** Stop, re-split what is left, then continue. The one time
mid-run re-sizing is right.

## What stops you

An irreversible operation, a security-sensitive action you were not told to
take, a side effect outside the worktree (push, publish, merge), or a plan so
broken every path is a guess. In a session: ask, one batched call. As the
builder: `ledger_ask` the job's `reply-to` party with `options` and
`meta.intent` naming the task, then end the turn. Everything else is a ruling,
logged.

## Never

- Sleep-poll a dispatched subagent. Its notification is the wake-up.
- Dispatch a scoped re-review agent. The implementer proves its fix; you
  adjudicate the proof.
- Fan reviewers out by category on one task's diff.
- Run a final whole-branch review here. That is ship's self review.
- Fix a reviewer's finding in the controller when an implementer holds the
  task.

## Exit

All tasks committed on the branch, `hive:verify` green on the tree as it
stands, rulings collected under "Rulings I made" in `progress.md`. Return to
the caller, which pushes and opens the draft PR.

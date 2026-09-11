---
name: plan
description: Use when a spec or an approved design exists and the work is more than one step, before touching code. Writes the plan a builder run or an inline execute run follows task by task. Tasks are twenty implementer-minutes, each marked risk-bearing or not, and a ticket over thirteen points becomes more than one PR.
---

# Plan

Write for an engineer with zero context on this codebase and questionable
taste: skilled, but new to the toolset and the domain, and not to be trusted
with "add appropriate error handling". Every task carries what they need:
which files, what code, what test, how to run it. DRY. YAGNI. TDD. A commit per
task.

Save to `<repo>/.hive/plans/YYYY-MM-DD-<slug>.md`. `.hive/` is a working
folder: write `<repo>/.hive/.gitignore` with the single line `*` if it is not
there, whichever skill gets there first.

## Scope check first

A spec that covers independent subsystems should have been split in
`brainstorm`. If it was not, split here: one plan per subsystem, each producing
working software on its own.

**A ticket over thirteen points is more than one PR.** Name each PR and which
tasks belong to it in the header. Independent PRs may be built in parallel,
each by its own builder run in its own worktree; dependent ones are ordered.

## File structure before tasks

Map which files are created or modified and what each is responsible for. One
responsibility per file; files that change together live together; follow the
patterns the codebase already has, and split a file you are modifying only when
it has grown past what a reader holds at once.

## Header (required)

```markdown
# <Feature> plan

Goal: <one sentence>
Spec: .hive/specs/<file>            (or: none, bounded change)
Ticket: HIVE-123                    (or: none)
PRs: 1 | N (name each PR's tasks)
Global constraints:
  - <copied verbatim from AGENTS.md and the spec: version floors, naming,
     import zones, the test mirror, the 80% gate, no coverage-ignore>
Architecture: <two or three sentences>
```

Every task's requirements include the global constraints.

## Task block (required shape)

````markdown
## Task N: <name>                     risk: yes | no       est: 20m

Files:
- Create: exact/path
- Modify: exact/path:120-160
- Test:   tests/exact/path (mirrors src)

Interfaces:
- Consumes: <exact names and types from earlier tasks>
- Produces: <exact names and types later tasks rely on>

Steps:
- [ ] Write the failing test         (the test code, in a fence)
- [ ] Run it, see it fail            (the command and the expected failure)
- [ ] Minimal implementation         (the code, in a fence)
- [ ] Run it, see it pass            (the command)
- [ ] Scoped lint and type-check     (`pnpm exec eslint <paths>`, `pnpm type-check`)
- [ ] Commit                         (`git add …; git commit -m "…"`)

Done when: <command> prints <output>
````

`risk: yes` when the task touches auth, a credential, a token, a wire format,
concurrency, money or a security predicate, or when the spec calls it the
riskiest thing in the plan. Only those tasks get a reviewer subagent in
`execute`; the rest are read by the controller.

`est: 20m` is a promise. A task an implementer cannot finish in that span is
two tasks. Split here, not mid-run; `execute` re-splits only when the first
two runs prove the estimates wrong.

## No placeholders

Plan failures, never written: "TBD", "TODO", "later", "add validation",
"handle edge cases", "write tests for the above" without the test, "similar to
Task N" (repeat the code; tasks are read out of order), a step that says what
without showing how, a type or function no task defines.

## Self-review, inline

1. Spec coverage: every requirement points at a task. Add the missing ones.
2. Placeholder scan, against the list above.
3. Type consistency: names and signatures in later tasks match earlier ones.

Fix in place. No re-review.

## Handoff

Return to the caller. `work-on` decides builder versus inline; `goal-on` runs
the plan itself. This skill never asks which; the "subagent-driven or inline"
menu is gone on purpose.

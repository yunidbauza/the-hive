---
name: work-on
description: Use when a Hive session starts work on a Jira ticket. "work on HIVE-123", "start ABC-42", the next story in an Epic, or a session opened from the Work tab. Reads the ticket, reconciles it against the code as it is today, gets the go-ahead once, brainstorms and plans in the terminal, then hands the plan to the builder agent or executes it inline. Use goal-on when there is no ticket.
---

# Work on a ticket

Ticket specs go stale. The codebase moves after the ticket was written: earlier
stories in the Epic, merged PRs, renamed modules. So the first thing this skill
does is reconcile the ticket against the code as it exists **today**, and the
codebase is the source of truth. Then it plans. Then the work leaves the
terminal.

The lifecycle: reconcile → gate → brainstorm → plan → build (builder agent, or
inline) → draft PR → shipper agent → merged, ticket Done.

**Two stops, and no others.** The reconciliation report, and the design
approval inside `brainstorm` (the in-chat design for a bounded change, the
spec for an architectural one). Nothing else ends the turn to ask "shall I
continue?": brainstorm's questions go out in one batch, the draft PR opens
with no menu, and the shipper is asked in the same turn the PR exists.

## Inputs

`<KEY>` (required, `[A-Za-z]+-[0-9]+`, uppercased; missing → ask once).
`--inline`: execute the plan in this session instead of handing it to the
builder. `--detach`: hand off and close this session now; the builder asks the
overmind instead of this session.

## Steps

**1. Fetch the ticket.** `mcp__hive__jira_get { key }` when this session has
the Hive's tools: the description, the parent, every comment and link in one
call, through the token the Work tab holds. Otherwise `jira-writer get_issue
<KEY>` (the `jira-writer` skill; the Atlassian MCP tools if it is not
installed; never raw REST). Keep the fetch lean:

- Full body and every comment of the target ticket.
- The Epic's summary, not its body.
- Sibling stories as key, title and status, plus a scan of their comments for
  anything that amends scope or acceptance criteria.
- Full body and comments of issues directly linked to the target.

A comment that amends scope, a decision or an acceptance criterion is
**authoritative over the description**. Carry every such amendment, and every
description-versus-comment contradiction, into the reconciliation as a
candidate deviation.

**2. Reconcile against the code.** Dispatch one to three `Explore` subagents in
one response, one per subsystem the ticket names, a cheaper model is fine.
Each gets the ticket excerpt that concerns it and returns a short verdict with
`file:line` evidence per mismatch, never file dumps:

- Does anything the ticket asks for already exist, wholly or in part?
- Do the paths, modules, schemas and interfaces it names still match reality?
- Did the linked prior work change an assumption the ticket relies on?
- Does the code already reflect a comment that amended the description?

**3. Report, then STOP.** What the ticket says, what the code says, each
mismatch with a recommended resolution (follow ticket / follow code / needs a
decision), and whether the ticket text should be updated. Then END YOUR TURN.
Even with zero deviations: "no deviations found, ready to plan. Proceed?" is the
whole message. Never continue into step 4 in the same turn as the report. A
confirmed deviation is propagated later by `spec-deviation`.

**4. Claim and design.** `ledger_claim <KEY>` so the fleet knows the ticket is
held. Then `hive:brainstorm` with the reconciliation findings as its input, then
`hive:plan`. Every question the design needs goes out in **one**
`AskUserQuestion` call, four questions at most, recommended option first. A
lone follow-up is allowed only when an answer changes what the next question
is.

**A UI surface** gets one browser-rendered HTML mockup of the recommended
design (the Artifact tool), and two or three variants only when the surface is
new to the app or the user asks. Show variants before writing any code.

**5. Dispatch.** The plan is approved; the terminal's job is done.

Call `mcp__hive__agents` first. The builder path below needs `builder`
listed, and the shipper handoff needs `shipper`; a machine without them
(they ship in later stories) runs inline, and an ask to a party that does
not exist wakes nothing.

*Default when `builder` exists: the builder agent.* Release the claim first
(`ledger_release <KEY>`; the builder re-claims), then post one ask and stay
on the line. The ask ends your turn, so nothing after it runs until you are
woken:

```
ledger_ask
  to: builder
  body: |
    Build <KEY>: <ticket title>
    repo: /abs/path/to/checkout
    ticket: <KEY>
    branch: feat/<key>-<slug>
    plan: .hive/plans/YYYY-MM-DD-<slug>.md
    spec: .hive/specs/YYYY-MM-DD-<slug>.md   (or: none)
    ship: yes
    key-confirmed: yes                       (the key came from this invocation)
    reply-to: <this session's id>            (overmind with --detach)
  meta: { ticket: "<KEY>", repo: "...", plan: "...", stage: "build",
          intent: "wait for the builder; answer its questions from the spec" }
```

**Preflight, before the first ask.** `mcp__hive__projects`: find the project
whose `path` is this repo. `autoMerge: false` → tell the person in the
dispatch message: "this project merges only on your inbox card: each clean PR
will raise one." If `mcp__hive__project_auto_merge` is listed, offer to turn
it on in the same batch as brainstorm's questions; never call it without
their yes.

A plan split into PRs is one ask per PR, **in order**. The builder takes one
ledger ask at a time (its asks resume one standing session; `limits.parallel`
only fans out scheduled jobs), so asks posted together run one after another.
Never offer the person "parallel" builds. Post the next PR's ask when the one
it depends on has merged.

*Attached (default).* Stay open. A `📒` marker from the builder is a question.
Answer it with `ledger_answer` when the spec, the plan or this conversation
already holds the answer, and say so in the answer ("per spec §3"). Otherwise
`AskUserQuestion`; the Hive flags the session input-needed, and you relay the
answer. Never invent a decision the spec did not make. When the shipper's
final ask arrives ("PR merged, close?"), answer it and run `/done`.
Closing the terminal earlier is fine: an ask to a session that is gone falls
back to the overmind.

*Detached (`--detach`).* `reply-to: overmind`, then `/done` now.

*Inline (`--inline`, no `builder` on this machine, or a plan of one task).*
`hive:worktree` on `feat/<key>-<slug>`, Jira → In Progress
(`mcp__hive__jira_transition { key, status: "In Progress", from: "To Do" }`,
where `from` leaves a ticket already past To Do alone; without the Hive's tools, read the status with
`jira-writer get_issue <KEY> status` and, if it is still To Do, take the In
Progress id from `jira-writer get_transitions <KEY>` and call `jira-writer
transition_issue <KEY> <id>`), `hive:execute`, `hive:verify`, then:

1. The full gate on the exact tree you will push: lint, type-check, the unit
   suite, and e2e or a browser drive when the change has a UI surface.
2. `git push -u origin <branch>`.
3. `gh pr create --draft` with what changed and how it was verified.
4. `shipper` listed by `mcp__hive__agents`: `ledger_ask to: shipper` (see
   `ship` for the intake shape) with `reply-to: <this session>` and
   `key-confirmed: yes` (the key came from this invocation), then stay for
   the shipper's final ask, or `/done`. No shipper on this machine: say the
   draft PR is ready and stop.

Never open the PR ready. Never present a merge menu. The tail is the
shipper's, or the person's.

## The branch carries the key, the ask carries the truth

`feat/<key>-<slug>` is the convention, and it is the cheapest injection there
is: the author writes it. The shipper and `merge-pr` transition a ticket only
on a key handed to them with `key-confirmed: yes`, which this skill sets
because the key came from its own arguments. Never from a branch name.

## Red flags

- A plan written from the ticket text alone. Reconcile first.
- Continuing past the report in the same turn, "no deviations, so I'll go".
- Reconciling against the description while a comment already changed it.
- Brainstorm questions one per turn.
- Three mockup variants for a pattern the app already has.
- Opening the PR ready for review. Draft, always; the shipper marks it ready.
- Ending the turn on "draft PR created". Ask the shipper in the same turn.
- Answering a builder question the spec does not answer. That one is the
  person's.
- A plugin skill from outside the Hive as a step of the process. This skill
  and its siblings are the whole process; the Jira CLI fallbacks are tools,
  not steps.

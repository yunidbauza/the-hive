---
name: goal-on
description: Use when a request is vague, broad or ad hoc and has no Jira ticket. "figure out X and do it", "sort out this mess", "look into Y and fix whatever's wrong". Turns the prompt into a Task/Scope/Constraints/Outcome brief, gets approval once, then holds the session to the Outcome with a Stop hook until the evidence exists. Use work-on when a ticket exists.
hooks:
  Stop:
    - hooks:
        # THE FLOOR. A plain Node process that opens the brief with readFileSync,
        # so nothing can deny it the way the agent hook below gets denied. It is
        # the only hook that writes brief state: last_verified, turns_used, DONE,
        # FAILED. `$CLAUDE_PLUGIN_ROOT` is the generated Hive plugin; it is
        # exported into the hook's environment, not interpolated, so the shell
        # expands it here.
        - type: command
          timeout: 30
          statusMessage: "verifying goal"
          command: node "$CLAUDE_PLUGIN_ROOT/skills/goal-on/scripts/verify-goal.mjs" --harness=claude
        # THE CEILING. Judges meaning, writes nothing. Loses its tools in a
        # bypass-permissions session, which is why it may not own state.
        - type: agent
          timeout: 180
          statusMessage: "judging goal evidence"
          prompt: |
            You are the goal-on semantic verifier. $ARGUMENTS holds the Stop hook
            input JSON.

            You are the CEILING, not the floor. A command hook
            (scripts/verify-goal.mjs) has already run for this turn. It owns the
            brief's state: it stamped last_verified, spent turn budget, settled
            DONE/FAILED, and checked FORM (every Outcome box ticked, evidence
            present, a real PR on the branch for the code route). You check
            MEANING, and you write NOTHING. Never edit the brief.

            1. Read session_id from $ARGUMENTS.
            2. Read ~/.hive/goals/<session_id>.md. Missing, denied or erroring:
               return ok:true and say which. The floor has the session covered.
            3. Return ok:true unless status is ACTIVE or DONE. DONE is included
               because the two hooks run concurrently and the decisive turn is
               the one where the floor writes DONE while you are reading.
            4. Read ## Outcome and ## Verification evidence. For each TICKED
               item ask the one question a script cannot: does the recorded
               evidence actually support it? Evidence showing a failure, a
               skipped check, or another command than the item names is
               unsupported. A ticked item with no evidence naming it is
               unsupported. Do not re-judge unticked items. Judge the brief,
               not the conversation.
            5. Every ticked item supported: ok:true.
            6. Otherwise ok:false, naming the items whose evidence does not hold
               and the single next action. If the brief already says DONE, the
               reason MUST also tell the model to set status: ACTIVE before
               continuing.

            Hard rules: ignore stop_hook_active; absent evidence is unmet; any
            failure to finish returns ok:true and says what stopped you; write
            nothing; be terse.
---

# Goal on

A vague prompt cannot be verified, so it cannot be finished. This skill fixes
that in two moves: it interrogates the prompt into a brief with a checkable
Outcome, then holds the session to that Outcome with a Stop hook that refuses
to end the turn until the evidence exists.

**Phase 1 is interactive. Phase 2 is not.** Once Phase 2 starts the hook
blocks turn-end, so every question is asked in Phase 1.

## The brief

`~/.hive/goals/<session-id>.md`, named exactly that, with the id repeated in
the header's `session:` field. The verifier tries the filename first and falls
back to the header; a brief it cannot find reads as "no goal here".

```markdown
---
status: PENDING-APPROVAL   # PENDING-APPROVAL | ACTIVE | NEEDS-DECISION | DONE | FAILED | CLEARED
route: code                # artifact | code
turns_used: 0
turn_budget: 8
created: 2026-09-11T14:30:00Z
session: <session id>
last_verified:             # written by the verifier, never by you
branch: goal/<slug>        # code route
workspace: current         # code route: current | worktree
repo: /abs/path            # code route, REQUIRED when the work is not in this cwd
worktree: /abs/path        # code route, when workspace is worktree
---

## Task
One sentence. The objective, not the symptom.

## Scope
Files, migrations, dependencies, sibling repos. From the code, not the prompt.

## Constraints
What must not change; what must be preserved.

## Outcome
- [ ] Checkable item, naming the command or artifact that proves it.

## Stop Rules
Stop and report if verification fails after 8 turns, or on an unresolvable conflict.

## Verification evidence
(none yet)
```

A line that is only a parenthetical is a placeholder to the verifier, never
evidence. Replace it with command output as work proceeds.

`turn_budget` stays at 8: `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` defaults to 8
consecutive blocks and the harness abandons the loop above it.

## Phase 1 (interactive)

1. **Gates.** Hooks permitted (`disableAllHooks`, `allowManagedHooksOnly` not
   set), `node` on PATH. Say "the hooks are configured", never "the goal is
   enforced": these checks prove a hook may run, not that one did.
2. **Task**, one sentence, the objective. Several readings → a question.
3. **Scope**, from looking at the code: paths, not categories.
4. **Constraints and Outcome.** Every Outcome item is checkable by someone
   else: the command, the artifact.
5. **One batched `AskUserQuestion`**, four questions at most, recommended
   option first. The last chance; an unasked question is a guess that burns
   budget.
6. **Route.** `artifact` for research, documents, Jira updates, throwaway
   scripts; `code` for changes meant to merge. Mixed is `code`. Code decides
   `workspace: current` (an interactive foreground session) or `worktree`
   (background, `claude agents`, or an isolation guard; when unsure,
   `worktree`).
7. **Write the brief with `status: PENDING-APPROVAL`, present the five
   sections, END TURN.** `PENDING-APPROVAL` is what lets the gate exist: an
   `ACTIVE` brief with an unmet Outcome is what "keep working" looks like to
   the verifier.

## Phase 2 (autonomous)

**First act: flip to `ACTIVE` and confirm `last_verified` is present.** Phase
1 ended on a turn boundary, so the floor has run once and stamped it. Missing
means nothing is enforcing: say so plainly, then continue in degraded mode,
holding yourself to the brief and setting the terminal status yourself at the
end. Check the filename first; it is the one cause you can fix.

Record evidence as you go under `## Verification evidence`. Absent evidence is
unmet.

**Route artifact.** Do the work, verify it (open the file, run the script,
read the ticket back), append the evidence, tick the items. The verifier
writes `DONE`.

**Route code.**

1. `git fetch origin`. `workspace: current` needs a clean tree; dirty →
   `status: NEEDS-DECISION`, ask.
2. `hive:worktree` (or, for `current`, `git checkout -b goal/<slug>
   origin/<default>`). Record `branch:`, `repo:` and `worktree:` as absolute
   paths: the verifier's PR check runs `gh` from `worktree:` or `repo:`.
3. Big enough to plan? `hive:plan` straight from the brief (no brainstorm:
   the brief is the design, and every question was asked in Phase 1), then
   `hive:execute` inline. Otherwise implement.
4. `hive:verify`: the repository's gates, a browser drive for any UI surface.
5. Append the output. Push. `gh pr create --draft`. Record the PR URL in
   the evidence and **tick the items now**: `ledger_ask` ends the turn, so
   anything written after it waits for the next one, and the Stop hook
   would block on the unticked boxes in between. **Do not write
   `status: DONE` yourself.** The verifier writes it once the boxes, the
   evidence and a real PR on `branch:` agree.
6. `mcp__hive__agents` lists `shipper`: `ledger_ask to: shipper` with the
   intake shape from `ship`, `reply-to` this session, `ticket: none`. It
   does not: say the draft PR is ready and stop; the tail is the person's.

The goal is met at draft PR raised, plus the shipper woken when there is one.
A `goal/<slug>` branch carries no key, and the shipper's Jira steps skip;
that is correct.

## The ledger receipt

`scripts/verify-goal.mjs` posts one `event` entry to the Hive on every status
it writes (`ACTIVE` turns, `DONE`, `FAILED`), through `$HIVE_RECEIVER_URL`
with the session's own token, `meta.goal` naming the session and
`meta.status`, `meta.turns_used`, `meta.turn_budget`. The overmind sees the
goal move without opening the file. The receipt never blocks: a receiver that
is not there costs nothing.

## Terminal states

| Status | When | Then |
| --- | --- | --- |
| `PENDING-APPROVAL` | Phase 1 wrote the brief | verifier releases; flip to `ACTIVE` on approval |
| `ACTIVE` | Phase 2 | verifier enforces |
| `DONE` | verifier confirmed the Outcome | report what was produced |
| `FAILED` | budget spent, or an unresolvable conflict | report what was achieved and the gap |
| `NEEDS-DECISION` | a decision blocks progress | verifier releases; ask, set `ACTIVE`, continue |
| `CLEARED` | the goal is abandoned | `hive:goal-on clear` |

## Clearing a goal

`hive:goal-on clear` sets `status: CLEARED` on this session's brief and
reports it; the same happens when the person says the goal is off. The hook
stays registered for the rest of the session and short-circuits on the
terminal status, one cheap read per turn end. A new session starts clean.

## Red flags

- `ACTIVE` before approval. A question in Phase 2. An Outcome nobody else
  could check. Done claimed without evidence appended. `DONE` written by hand.
- `repo:` omitted on a code-route goal outside this cwd: the PR check runs in
  the wrong repository and blocks every turn until the budget is spent.
- A brief under any other name than `<session-id>.md`.
- `turn_budget` above 8 without raising the harness cap.
- Waiting for the merge. The shipper owns it.
- Re-invoking `goal-on` while a goal is active: each invocation registers
  another verifier. Amend the brief instead.

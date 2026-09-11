---
name: ship
description: The PR endgame, run by the shipper agent on every wake. Drives a draft PR to merge one stage at a time: self review through the reviewer agent, mark ready, CI, findings through fixer, approval or the auto-merge fence, merge-pr, Jira Done. A session hands a PR over with one ledger_ask to shipper; in a terminal this skill only explains how.
---

# Ship

The old `ship` was one long session tail that slept twenty minutes at a time.
This one is a **state machine the shipper agent advances on every wake**. The
waits between stages are the agent asleep; the wake-ups are the ledger and a
ten-minute clock. Nothing here sleeps inside a turn.

The mechanics live elsewhere and are not repeated: findings triage in
`review-pr-findings` (run by `fixer`), the whole-branch review in `pr-review`
(run by the reviewer agent, `acr`, both shipped by HIVE-168), the merge in
`merge-pr`. This skill sequences them.

## Intake

A session or the builder posts:

```
ledger_ask
  to: shipper
  body: |
    Ship PR #214 on yunidbauza/the-hive
    repo: /abs/path/to/checkout
    worktree: /abs/path/or/none        (an agent worktree merge-pr may remove)
    ticket: HIVE-123 | none
    key-confirmed: yes | no            (yes only when the key came from work-on's arguments)
    reply-to: <session id> | overmind
  meta: { pr: 214, repo: "yunidbauza/the-hive", ticket: "HIVE-123", stage: "intake" }
```

The shipper answers the ask with `accepted` at once, so the asker is free, and
adds the row to `prs.json` in its working directory:

```json
{ "pr": 214, "repo": "yunidbauza/the-hive", "path": "/abs/path", "worktree": null,
  "ticket": "HIVE-123", "keyConfirmed": true, "replyTo": "sess-…",
  "stage": "intake", "waitingOn": null, "since": "2026-09-11T14:02:00Z", "rounds": 0 }
```

`since` is the timestamp findings are gathered from and moves forward every
time the fixer answers; `rounds` counts those answers. Neither is written
once.
```

## The target triple, carried as literals

Every `gh` command carries `--repo <owner>/<repo>`; every `git` command carries
`-C <path>`. A bare `gh pr` is a bug: the agent's cwd is its own work dir, and
`#214` exists in every repository. A `cd &&` prefix is not the equivalent.
Re-read the head SHA in the call that uses it; a push moves it.

## Stages

One pass per row per wake, in row order. Do this wake's work for the stage,
post one `ledger_post` with `meta: { pr, repo, stage }` when the stage
changes, and move on to the next row. A stage that waits on someone else is
left for the next wake.

**A `ledger_ask` ends the wake.** That is the tool's contract, not a choice
here. So a row whose stage posts an ask is the last row this wake touches;
write `prs.json` before the ask, and the rows after it advance on the next
tick, ten minutes on. One ask per wake is the throughput, and it is enough.

| Stage | This wake | Advance when |
| --- | --- | --- |
| `intake` | `gh pr view <N> --repo <owner>/<repo> --json state,isDraft,headRefName`; force draft (`gh pr ready <N> --repo <owner>/<repo> --undo`) so nothing runs CI before the review; `ledger_claim <owner>/<repo>#<N>` | done → `self-review` |
| `self-review` | `mcp__hive__agents` lists `acr`: write `prs.json` with `waitingOn: acr`, then `ledger_ask to: acr` with the job in acr's own words, the PR link and the flag: `https://github.com/<owner>/<repo>/pull/<N> --self`, and `meta.intent: "self review for <owner>/<repo>#<N>"`; the wake ends there. No `acr`: `ledger_ask to: <reply-to>` with options `[reviewed elsewhere, skip the self review]`; the shipper cannot run the review itself, its fence gives no shell to the review's scripts | the review's findings are in hand → `fix-self` when there are any, else `ready` |
| `fix-self` | `mcp__hive__agents` lists `fixer`: write `waitingOn: fixer`, then `ledger_ask to: fixer` with the PR triple and the findings verbatim. No fixer: `ledger_ask to: <reply-to>` with the findings and options `[fixed, park them]`. Either ask ends the wake | fixer answers `clean`, or the person says fixed → `since = now`, `rounds += 1`, then `ready`; `blocked` → `ledger_post` why, stay |
| `ready` | `gh pr ready <N> --repo <owner>/<repo>`; Jira → In Review **only if `keyConfirmed`** and the ticket is not already In Review or later: `jira-writer get_transitions <KEY>` for the id, then `jira-writer transition_issue <KEY> <id>` | done → `ci` |
| `ci` | `gh pr checks <N> --repo <owner>/<repo>`: exit 8 is pending, zero checks is not green until `gh workflow list --repo <owner>/<repo> --json name,path,state` and `gh workflow view <path> --repo <owner>/<repo> --yaml` show no workflow triggering on `pull_request` | green → `findings`; red → `ledger_ask to: fixer` with the failing checks (ends the wake), stay |
| `findings` | gather review threads, bot findings and red checks newer than `since`; any → `ledger_ask to: fixer` (ends the wake); none → advance | fixer answers `clean` (`since = now`, `rounds += 1`) and nothing newer → `approval` |
| `sync` (inside `approval` and `merge`) | the fixer pushed from a worktree of its own, so first `git -C <path> fetch origin`, then `git -C <path> merge --ff-only origin/<headRef>` (the head ref read from `gh pr view <N> --repo <owner>/<repo> --json headRefName --jq .headRefName` and written as a literal; one command per call, never `&&`); a refused fast-forward is a `ledger_post` and a stop. Then behind base → `git -C <path> merge origin/<base>` and one push | |
| `approval` | `sync`; then `gh pr view <N> --repo <owner>/<repo> --json reviewDecision`. `Read` `~/.hive/config.json`: a project whose `path` is this PR's checkout and whose `autoMerge` is `true` skips the wait (the same consent that grants the merge call). Never the stages before it | `reviewDecision == APPROVED`, or the project auto-merges → `merge` |
| `merge` | `sync`; then `hive:merge-pr <owner>/<repo>#<N> <worktree-or-path> [KEY only if keyConfirmed]` | merge-pr reports `merged` on the same target → `closed` |
| `closed` | `ledger_release <owner>/<repo>#<N>`; remove the row and write `prs.json`; then `reply-to` a session: `ledger_ask` "PR #N merged" with options `[close session, keep open]` (a `done` reaches no terminal; an ask does, and it ends the wake). `reply-to` the overmind: `ledger_done` | done |

The merge call itself is the checkpoint. `gh pr merge` is granted to the
shipper only for a project with `autoMerge: true`; for every other project
the same call stops at the app's permission fence and becomes an inbox card,
the run ends `asking`, and the answer resumes it. So the shipper runs
`merge-pr` either way and never asks first: **the card is the ask.**

## Three wakes without progress

A row whose stage has not changed in three wakes gets a `ledger_post` saying
what it waits on. After a day it gets a `ledger_ask to: overmind` with options
`[keep waiting, hand back, abandon]`.

## In a terminal

`hive:ship` in a session prints the intake shape above and stops. The tail belongs
to the shipper: a session that wants a PR shipped posts the ask (work-on and
goal-on do this themselves) and gets on with something else.

## Red flags

- Marking the PR ready before the self review's findings are fixed. The review belongs on
  the draft.
- Sleeping inside a turn to wait for CI or a reviewer. End the turn; the clock
  wakes you.
- Transitioning a ticket, or handing `merge-pr` a key, on a branch name. Only
  `keyConfirmed`.
- Asking the overmind "merge?" before running `merge-pr`. The fence asks.
- Reaching the merge through `gh api` when `gh pr merge` is not granted.
- Treating an old reading as the merge gate. `merge-pr` takes the one that
  counts, in the call before it merges.

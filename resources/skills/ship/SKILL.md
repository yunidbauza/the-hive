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
(run by the reviewer agent, `acr`, or by this run when no reviewer agent
is listed), the merge in `merge-pr`. This skill sequences them.

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

## The target triple, carried as literals

Every `gh` command carries `--repo <owner>/<repo>`; every `git` command carries
`-C <path>`. A bare `gh pr` is a bug: the agent's cwd is its own work dir, and
`#214` exists in every repository. A `cd &&` prefix is not the equivalent.
Re-read the head SHA in the call that uses it; a push moves it.

## Stages

One pass per row per wake. Do this wake's work for the stage, post one
`ledger_post` with `meta: { pr, repo, stage }` when the stage changes, and
move on to the next row. A stage that waits on someone else is left for the
next wake.

| Stage | This wake | Advance when |
| --- | --- | --- |
| `intake` | `gh pr view --json state,isDraft,headRefName`; force draft (`gh pr ready --undo`) so nothing runs CI before the review; `ledger_claim PR#N` | done → `self-review` |
| `self-review` | `mcp__hive__agents` lists `acr`: `ledger_ask to: acr` with `run reviewer <project> <pr> --self`, `meta.intent: "self review for PR N"`; record `waitingOn: acr`; END TURN for this row. No reviewer agent: run `hive:pr-review --self <pr>` in this run and treat its findings the same way | the review's findings are in hand → `fix-self` when there are any, else `ready` |
| `fix-self` | `mcp__hive__agents` lists `fixer`: `ledger_ask to: fixer` with the PR triple and the findings verbatim; `waitingOn: fixer`. No fixer: `ledger_ask to: <reply-to>` with the findings and options `[fixed, park them]`, and wait | fixer answers `clean`, or the person says fixed → `ready`; `blocked` → `ledger_post` why, stay |
| `ready` | `gh pr ready <N>`; Jira → In Review through `jira-writer transition_issue` **only if `keyConfirmed`** and the ticket is not already In Review or later | done → `ci` |
| `ci` | `gh pr checks <N>`: exit 8 is pending, zero checks is not green until `gh api repos/<o>/<r>/actions/workflows` says the repo has none | green → `findings`; red → `ledger_ask to: fixer` with the failing checks, stay |
| `findings` | gather new review threads, bot findings, red checks since `since`; any → `ledger_ask to: fixer`; none → advance | fixer answers `clean` and nothing new → `approval` |
| `approval` | behind base → `git -C <path> fetch origin && git -C <path> merge origin/<base>` then one push (re-read base in-call, quoted); `reviewDecision == APPROVED` → advance. **Auto-merge repos skip the wait, never the stages before it** | approved, or the repo auto-merges → `merge` |
| `merge` | `hive:merge-pr <owner>/<repo>#<N> <worktree-or-path> [KEY only if keyConfirmed]` | merge-pr reports `merged` on the same target → `closed` |
| `closed` | `reply-to` a session: `ledger_ask` "PR #N merged" with options `[close session, keep open]` (a `done` reaches no terminal; an ask does). `reply-to` the overmind: `ledger_done`. Remove the row | answered or expired |

Auto-merge is not a flag this skill reads. It is `autoMerge: true` on the
project in `~/.hive/config.json`, and the app's permission fence grants the
merge call for that project; for every other project the same call stops at
the fence and becomes an inbox card. So the shipper runs `merge-pr` either
way and never asks first: **the card is the ask.**

## Three wakes without progress

A row whose stage has not changed in three wakes gets a `ledger_post` saying
what it waits on. After a day it gets a `ledger_ask to: overmind` with options
`[keep waiting, hand back, abandon]`.

## In a terminal

`/ship` in a session prints the intake shape above and stops. The tail belongs
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

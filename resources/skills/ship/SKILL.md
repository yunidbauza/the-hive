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
    reply-to: <$HIVE_SESSION_ID, sess-…> | overmind
  meta: { pr: 214, repo: "yunidbauza/the-hive", ticket: "HIVE-123", stage: "intake" }
```

`reply-to` is a party name: the asker's `$HIVE_SESSION_ID`, never a Claude
session UUID. A write to a name no party answers to is refused `unknown
party`; on that refusal the row's `replyTo` becomes the intake ask's `from`
and the write is sent again.

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

## Lanes

The shipper lanes by repository (`lane: repo`, up to three at once). Every
`meta.repo` of the same `owner/name` reaches one conversation, and each
conversation has its own working directory. Two repositories ship at once;
two PRs on one repository queue, which is what keeps their syncs and merges in
one checkout from colliding.

- **Intake needs `meta.repo` as `owner/name`.** Without it the app answers the
  ask with the reason and nothing wakes.
- **`prs.json` is this lane's.** It lives in the lane's working directory and
  only ever holds this repository's PRs. "One ask per wake" is per lane.
- **The standing lane never takes a PR, syncs, merges or advances a row.** It
  wakes for what reaches no repo lane: the overmind's question about a PR the
  app could not match to a claim, and your ten-minute clock. For the first,
  answer with the open claims (`ledger_read`, `claims`) and ask which
  repository, or, when the ask names one, hand it over with a self-addressed
  `ledger_ask to: shipper` carrying `meta.repo` and the original words, and
  answer the original ask "handed to <owner>/<repo>". If the standing
  directory's `prs.json` still holds rows from before lanes, hand each one over
  the same way, with its row in the body, then remove it and write the file.

## The target triple, carried as literals

Every `gh` command carries `--repo <owner>/<repo>`; every `git` command carries
`-C <path>`. A bare `gh pr` is a bug: the agent's cwd is its own work dir, and
`#214` exists in every repository. A `cd &&` prefix is not the equivalent.
Re-read the head SHA in the call that uses it; a push moves it.

## Stages

Rows go in this lane's `prs.json` order. Do the stage's work, post one
`ledger_post` with `meta: { pr, repo, stage }` when the stage changes, and
**fall through into the new stage in the same wake**: `intake` → `self-review`,
`fix-self` → `ready` → `ci`, `findings` → `approval` → `merge` → `closed`
never cost a wake between them. A row stops only at a stage that waits on
someone else (an ask sent, CI pending, a review wait, the merge fence), and
the next row starts. A `sync` already run on a row this wake is not repeated.

**Before any row's stage work**, except at `merge` and `closed`,
`gh pr view <N> --repo <owner>/<repo> --json state`. Those two stages handle a
merged PR themselves: `merge-pr` recovers one (teardown, Jira Done) and
`closed` sends the notice. At any earlier stage, `MERGED` → stage `merge`, so
`merge-pr` does that recovery. `CLOSED` without a merge →
`ledger_release <owner>/<repo>#<N>`, remove the row, write `prs.json`, one
`ledger_post to: <reply-to>` saying so, and no further work for that row.

**A `ledger_ask` ends the wake.** That is the tool's contract, not a choice
here. So a row whose stage posts an ask is the last row this wake touches;
write `prs.json` before the ask, and the rows after it advance on the next
tick, ten minutes on. One ask per wake is the throughput, and it is enough.

**A post from the overmind with `meta.kind: auto-merge` means a project's
consent changed.** The app writes one whenever a project's `autoMerge` flips,
through Settings or a hand edit and reload. Re-run `approval` in this wake for
every row whose `path` is that post's `meta.path`. With `autoMerge: false`, a
row about to merge no longer has consent: it goes back to `approval` and waits.

| Stage | This wake | Advance when |
| --- | --- | --- |
| `intake` | `gh pr view <N> --repo <owner>/<repo> --json state,isDraft,headRefName`; force draft (`gh pr ready <N> --repo <owner>/<repo> --undo`) so nothing runs CI before the review; `ledger_claim <owner>/<repo>#<N>` | done → `self-review` |
| `self-review` | `mcp__hive__agents` lists `acr`: write `prs.json` with `waitingOn: acr`, then `ledger_ask to: acr` with the job in acr's own words, the PR link and the flag: `https://github.com/<owner>/<repo>/pull/<N> --self`, and `meta.intent: "self review for <owner>/<repo>#<N>"`; the wake ends there. No `acr`: `ledger_ask to: <reply-to>` with options `[reviewed elsewhere, skip the self review]`; the shipper cannot run the review itself, its fence gives no shell to the review's scripts | the review's findings are in hand → `fix-self` when there are any, else `ready` |
| `fix-self` | `mcp__hive__agents` lists `fixer`: write `waitingOn: fixer`, then `ledger_ask to: fixer` with the PR triple (`<owner>/<repo>#<N>`, the checkout `path`), the row's `reply-to`, and the findings verbatim. No fixer: `ledger_ask to: <reply-to>` with the findings and options `[fixed, park them]`. Either ask ends the wake | fixer answers `clean`, or the person says fixed → `since = now`, `rounds += 1`, then `ready`; `blocked` → a stuck row, stay |
| `ready` | `gh pr ready <N> --repo <owner>/<repo>`; Jira → In Review **only if `keyConfirmed`** and the ticket is not already In Review or later: `mcp__hive__jira_get { key }` for the status, then `mcp__hive__jira_transition { key, status: "In Review" }` (without the Hive's tools: `jira-writer get_transitions <KEY>` for the id, then `jira-writer transition_issue <KEY> <id>`) | done → `ci` |
| `ci` | `gh pr checks <N> --repo <owner>/<repo>`: exit 8 is pending, zero checks is not green until `gh workflow list --repo <owner>/<repo> --json name,path,state` and `gh workflow view <path> --repo <owner>/<repo> --yaml` show no workflow triggering on `pull_request` | green → `findings`; red → `ledger_ask to: fixer` with the triple, `reply-to` and the failing checks (ends the wake), stay |
| `findings` | `mcp__hive__pr { repo: "<owner>/<repo>", number: <N> }` for its checks and its `findings`, the unresolved review threads: a count above zero is a finding for the fixer, who reads the threads. A count is never the whole gather. **The gather** is one call, `gh pr view <N> --repo <owner>/<repo> --json reviews,comments,latestReviews,statusCheckRollup`, everything newer than `since` (`submittedAt` on a review, `createdAt` on a comment): every review with a body in **any** state, `APPROVED` and `COMMENTED` included; every PR-level comment; red checks. Leave out the fixer's own comments (they open with `<!-- hive-fixer`; a review or comment whose `id` a marker names is already answered) and a body that only says LGTM or summarises the reviewer's own inline comments. An approval that asks for a change is a finding. Any → `ledger_ask to: fixer` with the triple, `reply-to` and the findings verbatim, each with its author and `id` (ends the wake); none → advance | fixer answers `clean` (`since = now`, `rounds += 1`) and nothing newer → `approval` |
| `sync` (inside `approval` and `merge`) | The **workspace** is the row's `worktree` when it has one, else `<path>`. Read the head ref (`gh pr view <N> --repo <owner>/<repo> --json headRefName --jq .headRefName`, written as a literal), then `git -C <workspace> branch --show-current` and `git -C <workspace> status --porcelain`. On the head ref with an empty status: sync there. Otherwise, when the workspace is `<path>`, it is the person's own checkout and a merge there lands in their work, so take a worktree of your own instead of stopping: `git -C <path> worktree list --porcelain`, and a later block whose `branch` is `refs/heads/<headRef>` is a tree already on it; none, then `git -C <path> fetch origin` and `git -C <path> worktree add <your working directory>/pr<N> <headRef>` (git makes the local branch from `origin/<headRef>` when there is none). Write that path as the row's `worktree`, write `prs.json`, and it is the workspace from here on, for `merge-pr` too. A refused `worktree add` (the person's checkout holds the branch with uncommitted files), or a row `worktree` that is dirty or off the branch, is a stuck row. Then `git -C <workspace> fetch origin` and `git -C <workspace> merge --ff-only origin/<headRef>`, one command per call, never `&&`: the fixer pushed from a tree of its own. A refused fast-forward is a stuck row. Then behind base → `git -C <workspace> merge origin/<base>` and one push | |
| `approval` | `sync`; then `findings`' gather again (the same `gh pr view` call and `mcp__hive__pr`), since `since`: a review can land while the row waits here, and an approval can carry its requests in its body. Anything → stage `findings`, write `prs.json`, and fall through (the one stage before this one a row goes back to). Nothing → `gh pr view <N> --repo <owner>/<repo> --json reviewDecision,reviewRequests,latestReviews`. Three readings; check (c) first, since it holds even where (a) or (b) would pass. **(a)** `reviewDecision` is `APPROVED`, or `mcp__hive__projects` shows the project whose `path` is this PR's checkout has `autoMerge: true` (the same consent that grants the merge call) → `merge`. **(b)** `reviewDecision` is empty (no branch rule requires a review) and `reviewRequests` is empty: no review is coming → `merge`. With `autoMerge` off, `merge-pr`'s `gh pr merge` stops at the permission fence and becomes the person's inbox card, which is the ask. **(c)** `REVIEW_REQUIRED` or `CHANGES_REQUESTED`, any `latestReviews` entry with `state: CHANGES_REQUESTED`, or a review is requested: on the first wake at this stage only (`waitingOn` is not yet `reply-to`), write `waitingOn: "reply-to"` and `prs.json`, then `ledger_ask to: <reply-to>` "PR #N waits on a review" (ends the wake). Options `[merge now, wait for review, hand back]` when the review is only requested; `[wait for review, hand back]` when `reviewDecision` is `REVIEW_REQUIRED` or `CHANGES_REQUESTED`, because `merge-pr`'s gate holds on those and a `merge now` would loop. `merge now` → `merge`; `wait for review` → stay, no further asks; `hand back` → `ledger_release`, remove the row, write `prs.json`, and stop without merging. Never the stages before it, save `findings` from the re-gather | `APPROVED`, auto-merge, no review coming, or `merge now` → `merge` |
| `merge` | `sync`; then `hive:merge-pr <owner>/<repo>#<N> <worktree-or-path> [KEY only if keyConfirmed]` | merge-pr reports `merged` on the same target → `closed` |
| `closed` | `ledger_release <owner>/<repo>#<N>`; remove the row and write `prs.json`; then `reply-to` a session: `ledger_post to: <reply-to>` "PR #N merged" with `meta: { pr, repo, stage: "closed" }` (a directed post reaches the terminal without opening a thread; the session closes itself when its own work is done). `reply-to` the overmind: `ledger_done` with the same `meta`. Either entry releases any ask held with `meta.after` on this PR, so neither may drop the `meta` | done |

The merge call itself is the checkpoint. `gh pr merge` is granted to the
shipper only for a project with `autoMerge: true`; for every other project
the same call stops at the app's permission fence and becomes an inbox card,
the run ends `asking`, and the answer resumes it. Reading (b) of `approval` is
the path that reaches the fence: no review is coming, so the shipper runs
`merge-pr` and the fence asks the person. It never asks first: **the card is
the ask.**

## A row that waits

A row at a stage that waits on a person has exactly one open ask to its
`reply-to`, sent on the first wake at this stage. Later wakes do not post
"still waiting". `approval` reading (c) is gated that way; `self-review` with
no `acr` and `fix-self` with no fixer are not yet, and still ask every wake.

A row stuck on anything else (CI red with no fixer, a refused sync, a fixer's
`blocked`) asks its `reply-to` once, on the wake it gets stuck: write
`waitingOn: "reply-to"` and `prs.json`, then `ledger_ask` with what is stuck
and what you read, options `[keep waiting, hand back, abandon]`. `keep waiting`
→ stay, no further asks; `hand back` or `abandon` → `ledger_release`, remove
the row, write `prs.json`. Never a `ledger_post` in its place, and never a
question as the turn's closing text: a post to the overmind raises no card, and
nothing you write as text reaches anyone, so either one is a PR nobody hears
about.

Never broadcast a wait: a `ledger_post` to `*` reaches no terminal.

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
- Asking "merge?" when no review is possible. Reading (b) goes to
  `merge-pr`; the fence asks.
- A wait posted to `*`: it reaches nobody.
- Reaching the merge through `gh api` when `gh pr merge` is not granted.
- Reading an approval's state and not its body. "Approved, with two fixes"
  merged without the fixes once; the re-gather at `approval` is what stops it.
- Treating an old reading as the merge gate. `merge-pr` takes the one that
  counts, in the call before it merges.

---
name: merge-pr
description: Use when a PR is approved and green and it is time to merge it, "merge the PR", "squash and merge", or the shipper's merge stage. Re-checks every merge blocker in one reading immediately before merging, squash merges against that exact head, tears down the worktree and the branch, pulls the default branch, and moves the Jira ticket to Done only when the key is confirmed.
---

# Merge a PR

Whoever runs this reads nothing from the conversation: the arguments are the
whole input. `hive:merge-pr <owner>/<repo>#<N> [<workspace>] [KEY]`. No
arguments at all means cwd is a candidate to verify (below), never an answer.

## Step 0: the target

1. **Repository** from the argument (`<owner>/<repo>#<N>` or a PR URL). Never
   from cwd when an argument names it. `[ -n "$REPO" ]` before any `--repo`:
   empty falls back to cwd without an error.
2. **Already merged?** `gh pr view <N> --repo <owner>/<repo> --json
   state,mergedAt`. `MERGED` → skip to Step 4 (teardown when a workspace was
   given or can be found, else straight to Step 5). `CLOSED` with no
   `mergedAt` → stop; transition nothing. This comes before the workspace on
   purpose: the recovery path in Step 5 re-runs this skill after the branch
   is gone, and a workspace demand here would refuse it.
3. **Workspace** from the second argument when given. Otherwise the worktree
   whose branch is the PR's `headRefName` (`git -C <candidate> worktree list
   --porcelain`), otherwise the checkout on that branch. Neither, and the PR
   is still open: a missing input; stop and say so. `[ -n "$WT" ]` before
   any `-C`.
4. **The supplied key.** Tokenise the arguments; consume the PR target, then
   the workspace if it is a path; every remaining token matching
   `^[A-Za-z]+-[0-9]+$` is a supplied key. Two or more distinct keys is P0
   (below). Record the literal for the report.

Record repo, number, workspace and key as literals and substitute them
textually from here on.

## Step 1: checks

`gh pr checks <N> --repo <owner>/<repo>`. Zero checks is not green until the
repository is known to have no workflows.

## One plain command per call

The shipper runs this skill through a permission fence whose Bash rules refuse
any command carrying a shell control character: `|`, `;`, `&`, `<`, `>`, a
backtick, `$(`. So nothing below is a script. Every command is one plain
invocation, its output is read by you, and the branching is yours. Values a
script would keep in a variable are read once and then written into the next
command as **literals**: a branch, a SHA, a path. `gh`'s own `--jq` does the
reducing a pipe used to.

## Step 2: sync the workspace, then the base

The workspace may be behind its own branch: a fixer pushed from a worktree of
its own, and the shipper's checkout still sits where the builder left it.
Bring it level first, or the gate reports `head moved` for ever.

1. `gh pr view <N> --repo <owner>/<repo> --json headRefName,baseRefName --jq '[.headRefName, .baseRefName]'`
   Read both. Empty is a stop, not a default.
2. `git -C <workspace> fetch origin`
3. `git -C <workspace> merge --ff-only origin/<headRefName>`
   A refused fast-forward means local commits nobody pushed. Stop and report;
   do not force either side.
4. `git -C <workspace> rev-list --count HEAD..origin/<baseRefName>`
   Zero: go to Step 3. More: `git -C <workspace> log --oneline HEAD..origin/<baseRefName>`
   and `git -C <workspace> diff --stat HEAD...origin/<baseRefName>` say what
   landed. No overlap with this PR's files: `git -C <workspace> merge origin/<baseRefName>`,
   then `git -C <workspace> push origin <headRefName>`, and wait for green
   before the gate. Overlap: the same merge, then the repository's targeted
   verification on the affected paths.
5. A conflict: `git -C <workspace> log -p origin/<baseRefName> -- <file>` for
   both intents, resolve preserving both, never blanket `--ours` or
   `--theirs`. **A resolution that would change what this PR was reviewed as
   doing, or break a merged PR's behaviour, is a hard stop:** report both
   intents and the proposed resolution. In a shipper wake that report is a
   `ledger_ask` to the PR's `reply-to`.

Anything pushed here moves the head, restarts CI and can wake a review agent.
The gate reads after it, never before.

## Step 3: the gate, then the merge

Two readings, by who is running this.

**As the shipper.** The shipper holds no `gh api`: that command reaches the
merge by REST or by a GraphQL mutation, and no glob over it could keep the
merge consent narrow. Its reading is

```
gh pr view <N> --repo <owner>/<repo> --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup
```

then `gh pr checks <N> --repo <owner>/<repo>`, then `git -C <workspace> rev-parse HEAD`.
`mergeStateStatus` other than `CLEAN` or `HAS_HOOKS` is a HOLD line
(`BLOCKED`, `BEHIND`, `DIRTY`, `UNSTABLE`, `UNKNOWN`), `reviewDecision` of
`CHANGES_REQUESTED` or `REVIEW_REQUIRED` is one, and the checks rows below
apply. Unresolved review threads are not in this reading: the fixer's last
`clean` answer, which `review-pr-findings` gives only with zero unresolved
threads, stands for them, and `ship` never reaches this stage without it.
The shipper also reads `mcp__hive__pr { repo, number }` in the same round.
Its `findings` is the Hive's badge count: unresolved threads, outdated ones
included, capped at a hundred. A non-zero count is not a HOLD on its own (a
fixed thread nobody clicked Resolve on stays outdated, not resolved); it is
the cue to look at the threads, and the fixer's `clean` still stands for them.

**In a session.** One GraphQL reading of every blocker, raw, plus the
workspace head read in the call right after. No `--jq` here: a jq program is
full of `|`, and a fenced session refuses any command carrying one, however
it is quoted. The response is small and bounded, and the reduction is a
checklist you run over it.

```
gh api graphql -F owner=<owner> -F repo=<repo> -F n=<N> -f query='query($owner:String!, $repo:String!, $n:Int!) { repository(owner:$owner, name:$repo) { pullRequest(number:$n) { headRefOid state mergeable reviewDecision reviewRequests(first:50){ nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } } } } latestReviews(first:50){ nodes { author { login } state } } reviewThreads(first:100){ pageInfo { hasNextPage } nodes { isResolved isOutdated } } commits(last:1){ nodes { commit { statusCheckRollup { state contexts(first:100){ pageInfo { hasNextPage } nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } } } } }'
```

Then `git -C <workspace> rev-parse HEAD`.

Write the verdict yourself, from the JSON, as `GATE: CLEAR at <headRefOid>`
or `GATE: HOLD at <headRefOid>` followed by every line below that applies.
The reading is one call, so every fact on it is from one instant; that is
what makes it a gate rather than a collection of readings.

| Check, in this order | HOLD line |
| --- | --- |
| `headRefOid` is not the string `rev-parse` printed | `head moved: PR <oid> != workspace <sha>` |
| `state` is not `OPEN` | `PR state is <state>` |
| any `reviewThreads.nodes[]` with `isResolved: false` | `<n> unresolved review thread(s), <m> of them outdated` |
| `reviewThreads.pageInfo.hasNextPage` is true | `more than 100 review threads: paginate` |
| any `CheckRun` whose `status` is not `COMPLETED`, or any `StatusContext` whose `state` is `PENDING` or `EXPECTED` | `checks still running: <names>` |
| `contexts.nodes` is empty | `zero checks reported: establish whether this repo has CI` |
| `contexts.pageInfo.hasNextPage` is true | `more than 100 checks: paginate` |
| any `CheckRun` whose `conclusion` is `FAILURE`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, `STARTUP_FAILURE` or `STALE`, or any `StatusContext` whose `state` is `FAILURE` or `ERROR` | `checks failed: <names>` |
| any `reviewRequests.nodes[]` | `review still requested from: <login> [<typename>], …; reviewDecision=<decision>` |
| any `latestReviews.nodes[]` with `state: CHANGES_REQUESTED` | `CHANGES_REQUESTED standing from: <logins>` |
| `mergeable` is `CONFLICTING` | `mergeable=CONFLICTING` |
| `mergeable` is `UNKNOWN` | `mergeable=UNKNOWN: re-query` |

No line applies: CLEAR. Empty output from either command is a stop; empty is
not a pass, and neither is a JSON you did not read to the end.

| HOLD line | Action |
| --- | --- |
| unresolved thread(s) | stop; the findings belong to `review-pr-findings`; never resolve a thread to clear the gate |
| checks still running, or a `[Bot]` reviewer pending | in a session: wait, then re-run the **whole** gate, bounded at about ten minutes. In a shipper wake: end the wake; the clock re-runs this stage, and nothing sleeps inside a turn |
| a `[User]` reviewer pending, or CHANGES_REQUESTED | stop and report; nothing here approves for a person |
| head moved | stop: a wrong repository, or a push mid-run |
| zero checks | establish whether the repo has CI: `gh workflow list --repo <owner>/<repo> --json name,path,state`, then `gh workflow view <path> --repo <owner>/<repo> --yaml` for each and read whether it triggers on `pull_request` |
| more than 100 … | paginate; truncated is never CLEAR |
| empty reading | stop; empty is not a pass |

**A CLEAR is valid for exactly one call**, the merge, issued next, with
nothing in between. Anything in between, including a wait, voids it: re-run
the gate verbatim.

```
gh pr merge <N> --squash --match-head-commit <the SHA the CLEAR line printed> --repo <owner>/<repo>
```

The SHA is copied from the CLEAR line; carrying it is the check. `--repo` is
**last** and stays last: the shipper's auto-merge grant pins the slug at the
end of the line, because `gh` reads the last `--repo` it is given and a grant
that allowed anything after it would allow another repository. Never
`--delete-branch`: from inside a worktree it tries to switch the checkout and
fails half way. Step 4 owns teardown. Then confirm:

```
gh pr view <N> --repo <owner>/<repo> --json state,mergedAt,mergeCommit --jq '[.state, .mergedAt, .mergeCommit.oid]'
```

**The fence.** Run by the shipper, `gh pr merge` is granted only for projects
whose `autoMerge` is on (HIVE-166). For any other project the call stops at
the Hive's permission fence and becomes an inbox card; the run ends `asking`,
and the answer wakes a fresh run. That card is the checkpoint, and the wait
behind it voids the CLEAR like any other wait: **the resumed run re-runs the
gate** and merges on the new CLEAR, which the one-shot grant now lets through.
The shipper holds no `gh api` at all, because a merge by REST or by GraphQL
mutation is the same act without the consent; a session that does hold it
does not use it for that either.

## Step 4: teardown

1. `gh pr view <N> --repo <owner>/<repo> --json headRefName --jq '.headRefName'`
   and `gh repo view <owner>/<repo> --json defaultBranchRef --jq '.defaultBranchRef.name'`.
   Both are literals from here on; a ref may hold characters a shell reads,
   which is one more reason no shell reads them.
2. `git -C <workspace> worktree list --porcelain`. The first `worktree` line is
   the main working tree. A later block whose `branch` is `refs/heads/<headRefName>`
   names the linked worktree on the branch, if any.
3. A linked worktree: `git -C <main working tree> worktree remove <that path>`.
   No `--force`: a refusal means uncommitted files in it, and those are
   somebody's; stop and report. Then `git -C <main working tree> worktree prune`.
   An agent worktree under `~/.hive/work/<agent>/` is a linked worktree of the
   project and goes the same way.
4. `git -C <main working tree> checkout <defaultBranchName>`. The main working
   tree is the person's own checkout and is often dirty; a checkout that fails
   is a stop, because a pull into whatever branch is still checked out would
   merge the default branch into their work.
5. `git -C <main working tree> branch -D <headRefName>` (`-D`: a squashed branch
   is never "fully merged" locally; "not found" is fine).
6. `git -C <main working tree> push origin --delete <headRefName>` ("remote ref
   does not exist" is fine).
7. `git -C <main working tree> pull --ff-only origin <defaultBranchName>`.
8. Report `main working tree: <path>`.

The project's own checkout is never touched beyond the checkout and pull of
its default branch. When the branch was never checked out anywhere, nothing
is removed and the report says so. The fixer's findings ledger is the fixer's
to remove; it does so when it answers `clean`.

## Step 5: Jira, only on a confirmed key

Collect every key in the branch name: every token matching
`[A-Za-z]+-[0-9]+`, uppercased, unique, read off the `headRefName` from Step 4
by eye rather than through a pipe; an empty branch name here is a bug, stop.
Then exactly one rule:

| | Branch keys | Supplied key | Action |
| --- | --- | --- | --- |
| P0 | any | two or more distinct | transition nothing; report all |
| P1 | any | one, matching one of them or the branch has none | transition it |
| P2 | one or more | one, matching none | transition nothing; report both |
| P3 | none | none | skip; note it |
| P4 | one | none | remote-link check on that key through `jira-writer get_remote_links`: a link naming this PR or branch confirms; otherwise transition nothing, report the candidate |
| P5 | two or more | none | transition nothing; report all |

Transition to **Done**: `jira-writer get_transitions <KEY>` gives the id of
the Done transition, then `jira-writer transition_issue <KEY> <id>`, then read
the status back with `jira-writer get_issue <KEY> status`. Print, and repeat
in the report:

```
step 5: rule <P#>: supplied key: <KEY|none>, branch keys: [<K1>, …|none], action: <…>
```

An unconfirmed key never blocks the merge. The recovery is `hive:merge-pr
<owner>/<repo>#<N> <KEY>`, which finds the PR already merged in Step 0 and
goes straight to the Jira write.

## Report

```
merged <owner>/<repo>#<N>: squash <sha>, branch <branch> torn down, <KEY> → Done | no ticket
gate: CLEAR at <head SHA> (threads 0 unresolved, checks <green|none: repo has no CI>, no reviewer pending)
step 5: rule <P#>: supplied key: …, branch keys: […], action: …
main working tree: <path>
```

Name the target in full; "merged PR 58" is unfalsifiable.

## Red flags

- A bare `gh` or `git` after Step 0.
- Merging on a reading taken before a wait, a push, or a question.
- Resolving a thread to clear the gate.
- `--delete-branch`.
- Transitioning on a branch-name key.
- Reporting "no key supplied" without quoting the arguments line.

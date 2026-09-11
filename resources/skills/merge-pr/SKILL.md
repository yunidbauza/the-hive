---
name: merge-pr
description: Use when a PR is approved and green and it is time to merge it, "merge the PR", "squash and merge", or the shipper's merge stage. Re-checks every merge blocker in one reading immediately before merging, squash merges against that exact head, tears down the worktree and the branch, pulls the default branch, and moves the Jira ticket to Done only when the key is confirmed.
context: fork
agent: general-purpose
---

# Merge a PR

This runs forked, with no conversation. `$ARGUMENTS` is the only input:

```
arguments: $ARGUMENTS
```

Form: `merge-pr <owner>/<repo>#<N> [<workspace>] [KEY]`. An empty line, or the
literal token `$ARGUMENTS` left uninterpolated, means no arguments: resolve
from cwd as a candidate and verify it (below). Never parse the token itself.

## Step 0: the target

1. **Repository** from the argument (`<owner>/<repo>#<N>` or a PR URL). Never
   from cwd when an argument names it.
2. **Workspace** from the second argument when given. Otherwise the worktree
   whose branch is the PR's `headRefName` (`git -C <candidate> worktree list
   --porcelain`), otherwise the checkout on that branch. No such checkout is a
   missing input: stop and say so.
3. `[ -n "$REPO" ]` and `[ -n "$WT" ]` before any `--repo` or `-C`. Empty
   falls back to cwd without an error, and cwd is the thing this skill must
   not trust.
4. **Already merged?** `gh pr view <N> --repo <owner>/<repo> --json
   state,mergedAt`. `MERGED` → skip to Step 4. `CLOSED` with no `mergedAt` →
   stop; transition nothing.
5. **The supplied key.** Tokenise the arguments; consume the PR target, then
   the workspace if it is a path; every remaining token matching
   `^[A-Za-z]+-[0-9]+$` is a supplied key. Two or more distinct keys is P0
   (below). Record the literal for the report.

Record repo, number, workspace and key as literals and substitute them
textually from here on.

## Step 1: checks

`gh pr checks <N> --repo <owner>/<repo>`. Zero checks is not green until the
repository is known to have no workflows.

## Step 2: sync with the base

Re-read `BASE` inside every block; it does not survive a call and must never
be inlined as bare text:

```bash
BASE=$(gh pr view <N> --repo <owner>/<repo> --json baseRefName --jq '.baseRefName')
[ -n "$BASE" ] || { echo "ABORT: base branch not resolved"; exit 1; }
git -C "<workspace>" fetch origin
git -C "<workspace>" rev-list --count "HEAD..origin/$BASE"
```

Behind with no conflict: read what landed (`git log HEAD..origin/$BASE`, the
diff stat), merge `origin/$BASE`, run the targeted verification when the
upstream touched files this PR touches, push, wait for green. Conflicting:
read both intents (`git log -p origin/$BASE -- <file>`), merge preserving
both, never blanket `--ours`/`--theirs`. **A resolution that would change what
this PR was reviewed as doing, or break a merged PR's behaviour, is a hard
stop:** report both intents and the proposed resolution; this fork cannot
ask.

## Step 3: the gate, then the merge

One GraphQL reading of every blocker, plus the workspace head, reduced to one
verdict:

```bash
GATE=$(gh api graphql -f query='
query($owner:String!, $repo:String!, $n:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$n) {
      headRefOid state mergeable reviewDecision
      reviewRequests(first:50){ nodes { requestedReviewer {
        __typename ... on User { login } ... on Bot { login } } } }
      latestReviews(first:50){ nodes { author { login } state } }
      reviewThreads(first:100){ pageInfo { hasNextPage } nodes { isResolved isOutdated } }
      commits(last:1){ nodes { commit { statusCheckRollup { state contexts(first:100){
        pageInfo { hasNextPage }
        nodes { __typename ... on CheckRun { name status conclusion }
                ... on StatusContext { context state } } } } } } }
    }
  }
}' -F owner=<owner> -F repo=<repo> -F n=<N>)
LOCAL_HEAD=$(git -C "<workspace>" rev-parse HEAD)
[ -n "$GATE" ] && [ -n "$LOCAL_HEAD" ] || { echo "GATE: HOLD: empty reading"; exit 1; }
printf '%s' "$GATE" | jq -r --arg local "$LOCAL_HEAD" '
  .data.repository.pullRequest as $p
  | ($p.reviewThreads.nodes | map(select(.isResolved | not))) as $open
  | ($p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes // []) as $ctx
  | ($ctx | map(select(
      (.__typename=="CheckRun"      and (.status != "COMPLETED")) or
      (.__typename=="StatusContext" and (.state=="PENDING" or .state=="EXPECTED"))))) as $running
  | ($ctx | map(select(
      (.__typename=="CheckRun"      and ([.conclusion] | inside(["FAILURE","TIMED_OUT","CANCELLED","ACTION_REQUIRED","STARTUP_FAILURE","STALE"]))) or
      (.__typename=="StatusContext" and (.state=="FAILURE" or .state=="ERROR"))))) as $failed
  | ($p.reviewRequests.nodes | map("\(.requestedReviewer.login // "?") [\(.requestedReviewer.__typename)]")) as $pending
  | ($p.latestReviews.nodes | map(select(.state=="CHANGES_REQUESTED") | .author.login)) as $cr
  | [ (if $p.headRefOid != $local then "head moved: PR \($p.headRefOid) != workspace \($local)" else empty end),
      (if $p.state != "OPEN" then "PR state is \($p.state)" else empty end),
      (if ($open|length) > 0 then "\($open|length) unresolved review thread(s)" else empty end),
      (if $p.reviewThreads.pageInfo.hasNextPage then "more than 100 review threads: paginate" else empty end),
      (if ($running|length) > 0 then "checks still running: \($running|map(.name // .context)|join(", "))" else empty end),
      (if ($ctx|length) == 0 then "zero checks reported: establish whether this repo has CI" else empty end),
      (if ($failed|length) > 0 then "checks failed: \($failed|map(.name // .context)|join(", "))" else empty end),
      (if ($pending|length) > 0 then "review still requested from: \($pending|join(", ")); reviewDecision=\($p.reviewDecision // "none")" else empty end),
      (if ($cr|length) > 0 then "CHANGES_REQUESTED standing from: \($cr|join(", "))" else empty end),
      (if $p.mergeable == "CONFLICTING" then "mergeable=CONFLICTING" else empty end),
      (if $p.mergeable == "UNKNOWN" then "mergeable=UNKNOWN: re-query" else empty end)
    ] as $blocks
  | if ($blocks|length) == 0
    then "GATE: CLEAR: merge \($p.headRefOid) in the very next call"
    else "GATE: HOLD\n" + ($blocks | map("  - " + .) | join("\n")) end'
```

| HOLD line | Action |
| --- | --- |
| unresolved thread(s) | stop; the findings belong to `review-pr-findings`; never resolve a thread to clear the gate |
| checks still running, or a `[Bot]` reviewer pending | wait, re-run the **whole** gate; bound it at about ten minutes, then report |
| a `[User]` reviewer pending, or CHANGES_REQUESTED | stop and report; nothing here approves for a person |
| head moved | stop: a wrong repository, or a push mid-run |
| zero checks | establish whether the repo has CI (`gh api repos/<o>/<r>/actions/workflows`) |
| more than 100 … | paginate; truncated is never CLEAR |
| empty reading | stop; empty is not a pass |

**A CLEAR is valid for exactly one call**, the merge, issued next, with
nothing in between. Anything in between, including a wait, voids it: re-run
the block verbatim.

```bash
gh pr merge <N> --repo <owner>/<repo> --squash --match-head-commit <the SHA the CLEAR line printed>
```

The SHA is copied from the CLEAR line; carrying it is the check. Never
`--delete-branch`: from inside a worktree it tries to switch the checkout and
fails half way. Step 4 owns teardown. Then confirm:

```bash
gh pr view <N> --repo <owner>/<repo> --json state,mergedAt,mergeCommit --jq '{state, mergedAt, mergeCommit: .mergeCommit.oid}'
```

**The fence.** Run by the shipper, `gh pr merge` is granted only for projects
whose `autoMerge` is on. For any other project the call stops at the Hive's
permission fence and becomes an inbox card; the run ends `asking`, and the
answer resumes it here. That card is the checkpoint. Do not route around it
through `gh api`.

## Step 4: teardown

Re-read the branch and the default in-call, quoted; a ref may hold shell
metacharacters:

```bash
BRANCH=$(gh pr view <N> --repo <owner>/<repo> --json headRefName --jq '.headRefName')
DEFAULT=$(gh repo view <owner>/<repo> --json defaultBranchRef --jq '.defaultBranchRef.name')
[ -n "$BRANCH" ] && [ -n "$DEFAULT" ] || { echo "ABORT: branch/default not resolved"; exit 1; }
WT_LIST=$(git -C "<workspace>" worktree list --porcelain)
MAIN_WT=""; WT_PATH=""; cur=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*)                cur=${line#worktree }; [ -n "$MAIN_WT" ] || MAIN_WT=$cur ;;
    "branch refs/heads/$BRANCH") WT_PATH=$cur ;;
  esac
done <<< "$WT_LIST"
[ -n "$MAIN_WT" ] || { echo "ABORT: main working tree not resolved"; exit 1; }
if [ -n "$WT_PATH" ] && [ "$WT_PATH" != "$MAIN_WT" ]; then
  git -C "$MAIN_WT" worktree remove "$WT_PATH" --force   # a squashed branch is never "fully merged" locally
  git -C "$MAIN_WT" worktree prune
  git -C "$MAIN_WT" branch -D "$BRANCH"
else
  git -C "$MAIN_WT" checkout "$DEFAULT"
  git -C "$MAIN_WT" branch -D "$BRANCH" 2>/dev/null || true
fi
git -C "$MAIN_WT" push origin --delete "$BRANCH" 2>/dev/null || true
git -C "$MAIN_WT" checkout "$DEFAULT"
git -C "$MAIN_WT" pull origin "$DEFAULT"
echo "main working tree: $MAIN_WT"
```

An agent worktree under `~/.hive/work/<agent>/…` is a linked worktree of the
project and is removed by the same branch. The project's own checkout is
never touched beyond the checkout and pull of its default branch. Neither
case is "the branch was never checked out here": then nothing is removed and
the report says so.

## Step 5: Jira, only on a confirmed key

Collect every key in the branch name (`grep -oiE '[a-z]+-[0-9]+'`, uppercased,
unique); an empty branch name here is a bug, stop. Then exactly one rule:

| | Branch keys | Supplied key | Action |
| --- | --- | --- | --- |
| P0 | any | two or more distinct | transition nothing; report all |
| P1 | any | one, matching one of them or the branch has none | transition it |
| P2 | one or more | one, matching none | transition nothing; report both |
| P3 | none | none | skip; note it |
| P4 | one | none | remote-link check on that key through `jira-writer get_remote_links`: a link naming this PR or branch confirms; otherwise transition nothing, report the candidate |
| P5 | two or more | none | transition nothing; report all |

Transition through `jira-writer transition_issue` to **Done**. Print, and
repeat in the report:

```
step 5: rule <P#>: supplied key: <KEY|none>, branch keys: [<K1>, …|none], action: <…>
```

An unconfirmed key never blocks the merge. The recovery is `merge-pr
<owner>/<repo>#<N> <KEY>`, which finds the PR already merged and goes straight
to the Jira write.

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

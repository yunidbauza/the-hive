---
name: review-pr-findings
description: Use when a PR has feedback to work through: reviewer comments, bot findings, a red check, or the self review's findings. Assesses every finding adversarially, fixes the valid ones behind a test, replies to the rest, pushes once per round, and repeats until green with every thread resolved. Run by the fixer agent; also runs in a session on request.
---

# Review PR findings

A finding is a claim, not an instruction. Fix it when it is valid; when it is
not, reply with the reason and resolve it. Bots and reviewers are wrong
regularly, and fixing an invalid finding creates the next one. Loop until CI
is green and no thread is open.

This skill does not announce, watch or merge. That is `ship`.

## Step 0: the target, as literals

`ship` (through the fixer's ask) passes the repository, the PR number and the
findings. The workspace is yours to make:

- **As the fixer:** first `git -C <repo> worktree list --porcelain`. Git
  allows one worktree per branch, and the builder's may still exist until
  `merge-pr` removes it: if the PR branch is checked out anywhere, work
  **there** (`git -C <that path> pull --ff-only`). Otherwise `hive:worktree`,
  agent path, into `~/.hive/work/fixer/<repo-name>-pr<N>` tracking the PR
  branch.
- **In a session:** the PR's own checkout, on its branch.

Confirm `gh pr view <N> --repo <owner>/<repo> --json headRefName` matches
`git -C <workspace> branch --show-current`. A mismatch is a stop, not a guess.

| Command | Carries the repo as |
| --- | --- |
| `gh pr *` | `--repo <owner>/<repo>` |
| `gh api` REST | the slug in the path |
| `gh api graphql` | `-F owner=<owner> -F name=<repo>` |
| `git` | `-C <workspace>` |

Record all three as literals and substitute them textually. Shell state does
not survive a call; `--repo ""` resolves from cwd without erroring.

## Step 1: gather everything in one pass

```bash
gh pr view <N> --repo <owner>/<repo> --json state,statusCheckRollup,reviews
gh api "repos/<owner>/<repo>/pulls/<N>/comments" --paginate
gh api "repos/<owner>/<repo>/issues/<N>/comments" --paginate
gh pr checks <N> --repo <owner>/<repo>
```

Thread resolution is GraphQL only: `pullRequest.reviewThreads { isResolved }`
to read, `resolveReviewThread` to resolve. Findings handed in the ask body
count as this round's input too.

## Step 2: the ledger file

`~/.hive/work/fixer/ledgers/<owner>-<repo>-pr<N>.md`, the same path from a
session, so there is one place per PR. One row per finding: `finding → round
first seen → verdict → action → resolution`. Read it before assessing
anything. A finding already assessed in an earlier round is not re-fixed:
reply pointing at the prior resolution. Update after every verdict and every
push. It is removed by the run that answers `clean`, and by nobody else; a
`blocked` answer keeps it for the next round.

## Step 3: adversarial assessment

For each new finding, one subagent, the session's model, never downgraded:
steelman the finding with a concrete failure scenario, then try to refute it
against the code. Verdict `VALID | INVALID | NEEDS-USER-DECISION`. Batch small
related findings; run independent ones in parallel, in one response.

`NEEDS-USER-DECISION` (an architecture trade-off, a scope question): in a
session, present it with a recommendation. As the fixer, `ledger_ask` the
overmind with the finding quoted, `options` when the choice is closed, and
`meta.intent` naming the PR and the finding; END TURN. The answer wakes you
here.

## Step 4: act

- **VALID:** fix it. A behaviour change goes through `hive:tdd`: the test
  first. Then only the tests covering the touched modules, never the bare full
  suite.
- **INVALID:** reply on the thread with the technical reason, short, no
  softening into agreement, and resolve it.

## Step 5: reply safely

Top-level comments: `gh pr comment <N> --repo <owner>/<repo> --body-file -
<<'EOF'`; backticks stay plain. Inline replies go through the API, which has
no `--body-file`: write the reply to a file, then
`jq -n --rawfile body reply.md '{body: $body}' | gh api
"repos/<owner>/<repo>/pulls/<N>/comments/<id>/replies" --input -`. On HTTP
422 fall back to one top-level comment naming `file:line`. "One pending
review per pull request": submit or delete the pending review first.

## Step 6: verify, push once, loop

`hive:verify`: scoped lint, targeted tests, type-check, build only when the
change makes build-only errors likely, and a real browser drive for any UI
surface. Commit every fix of the round, then **one push**. Re-run Step 1. When
CI is green and no thread is open, post one short summary comment (what was
fixed, what was rejected and why) and report.

## Step 7: report

- **As the fixer:** `ledger_answer` the asker: `clean, <rounds> round(s)`, or
  `blocked: <what waits on whom>`. Release the claim the fixer took on
  arrival; when clean, remove the ledger file and the worktree if it was the
  fixer's own.
- **In a session:** the same two lines, in chat.

"All resolved" describes the moment this skill finished. `merge-pr` reads the
state again in the call before it merges.

## Red flags

- A fix without a recorded verdict.
- Re-fixing a finding the ledger already holds.
- "The bot is probably right."
- The whole suite instead of the touched paths.
- A UI fix "verified" on green tests alone.
- One push per finding.
- Reporting "all resolved" as if it authorised a merge.

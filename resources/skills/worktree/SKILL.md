---
name: worktree
description: Use when starting feature work that must not touch the shared checkout, before any edit. A builder or fixer run, an isolation-guarded session, or any work that needs its own branch off a fresh default branch. Creates an isolated git worktree, verifies the baseline, and says where it is.
---

# Worktree

One checkout per piece of work. The shared checkout stays on whatever the
person left it on, and the branch you create comes off the default branch as
it is on `origin` right now, not off whatever `HEAD` happens to be.

Two callers, two paths. Find out which you are first: an agent run carries
`HIVE_RUN_ID` in its environment; a terminal session does not.

## Before either path

```bash
REPO=<absolute path of the project checkout>
git -C "$REPO" fetch origin --prune
DEFAULT=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || echo main)
```

Refuse to continue if the shared checkout has uncommitted changes on the branch
you were going to base on. That is a question for the person, not a thing to
branch over.

## In a session

1. Prefer the native `EnterWorktree` tool. It creates the worktree and switches
   the session into it. It also names the branch `worktree-<slug>`, which is
   not the branch the plan asked for, so rename it at once:

   ```bash
   git branch -m "<branch>"
   ```

   The shipper finds the PR by branch name; a branch named `worktree-…` is one
   nobody will look for.
2. Without the tool, fall back to git. `.worktrees/` must be ignored before
   anything lands in it:

   ```bash
   git -C "$REPO" check-ignore -q .worktrees || echo '.worktrees/' >> "$REPO/.git/info/exclude"
   git -C "$REPO" worktree add "$REPO/.worktrees/<slug>" -b "<branch>" "origin/$DEFAULT"
   ```

3. Install dependencies the way the repository does (`pnpm install`,
   `npm ci`, whichever its lockfile says), then run the cheapest static check
   it has and confirm it is green. A red baseline is not yours to fix and not
   yours to build on; report it.

## As an agent (builder, fixer)

Agents have no `EnterWorktree` and must never write inside the project's
tree. The worktree lives in your own working directory:

```bash
WT="$HOME/.hive/work/<agent>/<repo-name>-<slug>"
git -C "$REPO" worktree add "$WT" -b "<branch>" "origin/$DEFAULT"
```

For a fixer on an existing PR branch, track it instead of creating one:

```bash
git -C "$REPO" worktree add "$WT" "<branch>"
git -C "$WT" pull --ff-only
```

Then install and baseline as above. Put the path in every `ledger_post` you
write for the job, as `meta.worktree`, so the shipper can tear it down after
the merge and a person can open a terminal on it.

Every command from here on is `cd "$WT" && …` or `git -C "$WT" …`, and every
commit is preceded by `git -C "$WT" branch --show-current` reading the branch
you were given. A subagent you dispatch gets `WT` in its prompt and the same
rule.

## Tearing down

Not yours, unless you are the one who made it and the work is abandoned.
`merge-pr` removes the worktree and the branch after the merge. If you must:

```bash
git -C "$REPO" worktree remove "$WT"
```

A refusal means uncommitted files. Stop and say so. Never `--force`.

## Red flags

- Branching off the current branch instead of `origin/<default>`.
- A `worktree-<slug>` branch left unrenamed.
- Working in the project's own checkout from an agent run.
- `git worktree remove --force` to make a refusal go away.

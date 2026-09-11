#!/bin/sh
# review-worktree.sh — one isolated, throwaway git worktree per review run.
#
#   review-worktree.sh open  <repo> <work_dir> <pr> [<owner/name>]   review mode: the PR head
#   review-worktree.sh open  <repo> <work_dir> --self [<base>]        self mode: a snapshot of the working tree
#   review-worktree.sh close <run_dir>
#
# Reviews run in parallel (two of the same PR included) beside whatever else is
# working in <repo>. So every run gets its own folder, its own detached
# worktree and its own refs under refs/hive-review/<run>/: no two runs share a
# path, a ref or a scratch file. Nothing is checked out in <repo>'s own
# worktree and no branch is created. The refs also pin the fetched commits
# against gc until close.
#
# Self mode reviews uncommitted and untracked work too. It stages the working
# tree into a private copy of the index, writes that as a commit on the run's
# ref and checks the commit out. The user's index and files are never touched,
# and the review reads a frozen copy while work goes on in <repo>.
#
# open prints one JSON line:
#   {"run","tree","base","baseSha","head","workspaceHead","changedFiles",
#    "uncommittedFiles","diff","numstat","files","lines"}
# The diff always runs from the merge base with the base branch just fetched
# from origin, so a self review covers the whole branch plus uncommitted work.
# `head` is what the worktree holds (the PR head, or the snapshot);
# `workspaceHead` is the commit the checkout sits on. `files` and `lines` leave
# lockfiles out, so a dependency bump doesn't tip the size tier.
set -eu

die() { echo "review-worktree: $*" >&2; exit 2; }

close_run() {
  run=$1
  [ -f "$run/repo" ] || return 0
  repo=$(cat "$run/repo")
  ns="refs/hive-review/$(basename "$run")"
  git -C "$repo" worktree remove --force "$run/tree" 2>/dev/null || true
  for ref in head base; do git -C "$repo" update-ref -d "$ns/$ref" 2>/dev/null || true; done
  git -C "$repo" worktree prune 2>/dev/null || true
  rm -rf "$run"
}

# A run that crashed before `close` is swept by the next `open` after a day.
sweep() {
  [ -d "$1/runs" ] || return 0
  find "$1/runs" -mindepth 1 -maxdepth 1 -type d -mtime +0 | while read -r stale; do
    close_run "$stale"
  done
}

case "${1:-}" in
  close)
    run=${2:-}
    case "$run" in */runs/*) ;; *) die "refusing $run — not a run folder under runs/" ;; esac
    [ -f "$run/repo" ] || die "$run is not a review run"
    close_run "$run"
    exit 0
    ;;
  open) ;;
  *) die "usage: open <repo> <work_dir> <pr> [<owner/name>] | open <repo> <work_dir> --self [<base>] | close <run_dir>" ;;
esac

repo=$(cd "$2" && git rev-parse --show-toplevel) || die "$2 is not a git repository"
work=$3
mode=$4
mkdir -p "$work/runs"
sweep "$work"

if [ "$mode" = --self ]; then label=self; else label="pr-$mode"; fi
run=$(mktemp -d "$work/runs/$label.XXXXXX")
ns="refs/hive-review/$(basename "$run")"
printf '%s\n' "$repo" > "$run/repo"
# Any failure from here on removes whatever this run had created.
trap 'status=$?; [ "$status" -eq 0 ] || close_run "$run"' EXIT

if [ "$mode" = --self ]; then
  base=${5:-}
  [ -n "$base" ] || base=$( (cd "$repo" && gh pr view --json baseRefName --jq .baseRefName) 2>/dev/null || true)
  [ -n "$base" ] || base=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
  [ -n "$base" ] || base=main
  git -C "$repo" fetch --quiet --no-tags origin "+refs/heads/$base:$ns/base"

  workspace_head=$(git -C "$repo" rev-parse HEAD)
  index="$run/index"
  cp "$(cd "$repo" && git rev-parse --path-format=absolute --git-path index)" "$index" 2>/dev/null || true
  GIT_INDEX_FILE="$index" git -C "$repo" add -A
  tree=$(GIT_INDEX_FILE="$index" git -C "$repo" write-tree)
  snapshot=$(git -C "$repo" commit-tree "$tree" -p HEAD -m "pr-review snapshot $(basename "$run")")
  git -C "$repo" update-ref "$ns/head" "$snapshot"
  rm -f "$index"
else
  pr=$mode
  slug=${5:-}
  base=$(cd "$repo" && gh pr view "$pr" ${slug:+--repo "$slug"} --json baseRefName --jq .baseRefName)
  git -C "$repo" fetch --quiet --no-tags origin \
    "+refs/heads/$base:$ns/base" \
    "+refs/pull/$pr/head:$ns/head"
fi

# Hooks off: a review has no business running the repository's checkout hooks.
git -C "$repo" -c core.hooksPath=/dev/null worktree add --quiet --detach "$run/tree" "$ns/head"

tree="$run/tree"
workspace_head=${workspace_head:-$(git -C "$tree" rev-parse HEAD)}
base_sha=$(git -C "$tree" merge-base "$ns/base" HEAD)
git -C "$tree" -c core.quotePath=false diff --find-renames "$base_sha" HEAD > "$run/review.diff"
git -C "$tree" -c core.quotePath=false diff --find-renames --numstat "$base_sha" HEAD > "$run/numstat"

set -- $(awk -F '\t' '
  $3 ~ /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/ { next }
  { files++; if ($1 != "-") lines += $1 + $2 }
  END { print files + 0, lines + 0 }' "$run/numstat")

# changedFiles counts base..workspaceHead with nothing left out, so it equals
# the PR's own changedFiles; uncommittedFiles is what a self snapshot adds.
changed=$(git -C "$tree" diff --name-only "$base_sha" "$workspace_head" | wc -l | tr -d ' ')
uncommitted=$(git -C "$tree" diff --name-only "$workspace_head" HEAD | wc -l | tr -d ' ')

printf '{"run":"%s","tree":"%s","base":"%s","baseSha":"%s","head":"%s","workspaceHead":"%s","changedFiles":%s,"uncommittedFiles":%s,"diff":"%s","numstat":"%s","files":%s,"lines":%s}\n' \
  "$run" "$tree" "$base" "$base_sha" "$(git -C "$tree" rev-parse HEAD)" "$workspace_head" "$changed" "$uncommitted" \
  "$run/review.diff" "$run/numstat" "$1" "$2"

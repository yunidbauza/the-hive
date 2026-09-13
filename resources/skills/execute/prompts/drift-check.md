# Drift check (cheap, non-blocking)

Task block and spec excerpt below; the diff is
`git -C "[WT]" diff [BASE]..[HEAD]`. Read-only. The only git commands you run
are `git -C <wt> diff|log|show|status|rev-parse|ls-files`. Never `stash`,
`checkout`, `switch`, `reset`, `restore`, `clean`, `commit`, `push`,
`worktree`, or any `--force`; never edit a file. If you need the tree in
another state to answer, say so in your answer instead. No subagents. Answer
two questions and nothing else.

## Task block

[TASK BLOCK]

## Spec excerpt

[SPEC EXCERPT]

1. `Spec: ✅ | ❌` Does the diff do what the task block says, and nothing the
   spec forbids? ❌ only when the diff skips something the task requires or
   does something the spec rules out. Name the line and the sentence of the
   spec.
2. `Notes:` up to five one-line quality observations, `file:line: what`.
   They are recorded for the whole-branch review, not acted on now.

A ❌ costs the builder a fix round; be sure. A note costs nothing; be generous.

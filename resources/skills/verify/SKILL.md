---
name: verify
description: Use before claiming any work complete, fixed or passing, and before pushing, opening a PR or reporting done to the ledger. Runs the repository's own gates, drives a UI change in a real browser, and records the output as evidence. No claim without fresh output in the same message.
---

# Verify

```
NO COMPLETION CLAIM WITHOUT FRESH EVIDENCE
```

If the command did not run in this message, its result is not known.

## The gate

1. **Identify** the command that proves the claim. Here: `pnpm lint`,
   `pnpm type-check`, `pnpm test` (or `pnpm exec vitest run <spec>` for one),
   `pnpm test:e2e` when behaviour moved or several files did, a live suite
   when its subject moved. Discover another repository's from its AGENTS.md,
   `package.json` or `Makefile`.
2. **Run** it, whole, on the exact tree you will push. `git status` clean of
   stray files first.
3. **Read** the output. Exit code, failure count, the runner's own totals. A
   background wrapper's exit code can be the echo's; a background vitest off a
   TTY prints totals only.
4. **Judge.** Output confirms the claim → make the claim, with the output.
   Output does not → state what actually happened, with the output.
5. **UI surface** (a component, a style, a layout, a role): drive it. The
   Playwright spec for the touched surface, or open the built app
   (`pnpm desktop:build` first; the electron e2e runs against `out/`). Green
   unit tests do not prove a render.

## Where the evidence goes

- A goal brief: appended under `## Verification evidence`. The verifier reads
  that section, not the conversation.
- A PR body: a "Verification" section with the commands and their last lines.
- A ledger job: the `ledger_post` or `ledger_answer` that reports the stage,
  in its body.
- A subagent's report: the command and its last line. A subagent that says
  "all green" with no output has not verified; check the VCS diff yourself.

## Claims and what they need

| Claim | Needs | Is not |
| --- | --- | --- |
| tests pass | the run, 0 failures | an earlier run, "should pass" |
| lint clean | the run, 0 errors | a partial path |
| build passes | exit 0 from the build | lint passing |
| bug fixed | the reproducing test, red then green | code changed |
| regression test works | pass → revert fix → fail → restore → pass | passes once |
| agent completed | the diff | the agent's report |
| requirements met | the plan re-read as a checklist | tests passing |

## Red flags

"should", "probably", "seems to", "Great!" before the output, "just this
once", a claim in a different wording so the rule does not apply.

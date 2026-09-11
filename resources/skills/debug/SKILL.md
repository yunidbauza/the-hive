---
name: debug
description: Use on any bug, failing test, build failure or unexpected behaviour, before proposing a fix. Root cause first, one hypothesis at a time, and the fix lands behind the test that reproduces the bug. Especially when a quick fix seems obvious or the last fix did not work.
---

# Debug

```
NO FIX WITHOUT A ROOT CAUSE FIRST
```

A symptom fix is a failure with a delay. Under time pressure, when "one quick
fix" looks obvious, when the previous fix did not take: those are the moments
this process is for, not the moments to skip it.

## Phase 1: root cause

1. **Read the error whole.** The stack trace, the line numbers, the codes.
   It often contains the answer.
2. **Reproduce.** Reliably, with exact steps. Not reproducible means gather
   more data, not guess.
3. **What changed.** `git diff`, recent commits, new dependencies, the
   environment.
4. **Instrument the boundaries** in a multi-component path (CI → build →
   sign; main → pty-host → renderer; hook → receiver → ledger): log what
   enters and leaves each component, run once, and read where it breaks.
   Then investigate that component and nothing else.
5. **Trace the data backwards.** Where does the bad value originate? What
   called this with it? Keep going up until the source. Fix at the source.

## Phase 2: pattern

Find the working sibling. What is different between the working case and the
broken one, every difference, including the ones that "can't matter". Read a
reference implementation completely before applying its pattern.

**Grep every caller before editing the callee.** A report names one path; the
fix goes where all callers route through, or every sibling stays broken.

## Phase 3: one hypothesis

State it in a sentence. Test it with the smallest change that would falsify
it. A hypothesis you cannot falsify is a story.

## Phase 4: fix

`hive:tdd`: the test that reproduces the bug first, red; then one fix; then
green; then the surrounding suite.

**Three failed fixes means the architecture is wrong,** not the fourth fix.
Stop and say so. In a session, ask. As an agent, `ledger_ask` the job's
`reply-to` party with what you know.

## In this repository

- A subagent's account of its own behaviour is a claim to check against the
  source, not a finding to repeat.
- A live suite run off a TTY prints totals only. Write a finding file beside
  the pty dump and read that.
- A failing e2e spec is re-run alone before it counts as red; a timeout that
  passes alone is a flake to note. An assertion failure is real either way.
- A background command's exit code can be the wrapper's. Read the runner's own
  totals.
- `pkill -f vite` kills vitest. Stop the dev server by port.

## Red flags

"Let me just try…", a second fix before the first was understood, editing the
callee without reading its callers, a fix with no reproducing test, "it works
now" without knowing why.

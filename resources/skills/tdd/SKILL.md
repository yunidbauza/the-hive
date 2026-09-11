---
name: tdd
description: Use when implementing any feature or bug fix, before writing production code, and when a PR finding asks for a behaviour change. No production code without a failing test first; code written before its test is deleted, not adapted.
---

# TDD

Write the test first. Watch it fail. Write the least code that passes. If you
did not watch the test fail, you do not know it tests the right thing.

## The law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Wrote the code first? Delete it. Not "keep as reference", not "adapt while
writing the test". Delete, then implement fresh from the test. Exceptions
need the person's word: a throwaway spike, generated code, configuration.

## The loop

**RED.** One test, one behaviour, a name that says what should happen, real
code rather than a mock wherever the real thing can be constructed. Run it.
Read the failure: it must fail because the behaviour is missing, not because
of a typo in the test.

**GREEN.** The least code that passes. Not the code you expect to need later.
Run it. Read the pass, and confirm nothing else went red.

**REFACTOR.** With everything green, and only then. Run again.

## In this repository

- Tests mirror `src/` under `tests/`, path for path. That is how "is this
  covered?" is answered.
- Stores are plain functions and the highest-value target: every action gets
  a test against a fresh store.
- Timers use fake timers. Never a real wait.
- xterm is never instantiated; `__mocks__/@xterm/` records. CodeMirror is
  real and renders. `node-pty` is never loaded; `__mocks__/node-pty.ts`
  records spawn arguments.
- The 80% gate holds on all four metrics, and no coverage-ignore comment
  passes it. An untestable branch is a shape to fix.
- `pnpm exec vitest run <path>` runs one spec. `pnpm test -- <path>` runs
  everything.

## Red flags

| Thought | Reality |
| --- | --- |
| "I'll add the test after" | Then it tests what you wrote, not what was needed. |
| "It's a one-liner" | One-liners have the highest ratio of confident to correct. |
| "The test would just duplicate the code" | Then the test is wrong, not unnecessary. |
| "I watched it fail in my head" | Run it. |
| "Just this once" | That is the rationalisation. Delete, start over. |

---
name: brainstorm
description: Use before any creative work in a Hive session, creating features, components or changing behaviour, and before writing a plan. Classifies the work as a spike, a bounded change or architectural, explores intent, and produces a spec for the architectural path. Invoked by work-on and goal-on; never dispatched to an agent.
---

# Brainstorm

Turn an idea into a design the person has approved, with exactly as much
ceremony as the idea needs. The approval gate never scales down; the artifact
does.

**Do not write code, scaffold anything or invoke an implementation skill until
you have said what you intend and the person has approved it.** Every path
below ends at that gate.

## Three paths, announced first

Classify before the first question and say the classification out loud, so it
can be overridden:

| Path | When | Output |
| --- | --- | --- |
| **Spike** | a feasibility question: "can we", "is it possible", "quick and dirty is fine" | a recommendation; anything built is labelled throwaway |
| **Bounded** | a change to a flow that already exists in this repo: a flag, a small endpoint, a one-file fix | a short design in chat, an explicit yes, then implementation with no plan document |
| **Architectural** | a new subsystem, an interface others depend on, anything that restructures how components fit, anything across processes | a spec file, then `hive:plan` |

Bounded measures the repo, not your familiarity: if there is no existing flow to
change, it is architectural. In doubt, take the heavier path. The ratchet is one
way: complexity found mid-task upgrades the path; nothing downgrades.

## Spike

1. Read enough to frame the probe.
2. Present the question and what you will try, two or three sentences.
3. Get a nod.
4. Find out as cheaply as correctness allows.
5. Report a recommendation. Keeping the code is a new request; classify it.

## Bounded

1. Read the flow you are changing: files, docs, recent commits.
2. Ask the clarifying questions that matter, in **one** `AskUserQuestion` call.
3. Present the design in chat: approach, files touched, how it is tested.
4. STOP and wait for an explicit yes. Presenting and starting in one breath is
   skipping the gate.
5. Implement with `hive:tdd`; no plan document.

## Architectural

1. **Read the code the change touches.** Trace the flow end to end before
   proposing anything. Follow the patterns that are there; include a targeted
   improvement only where an existing problem gets in the way of this work.
2. **Scope check.** Several independent subsystems in one request is a
   decomposition, not a spec. Name the pieces and their order, then brainstorm
   the first one.
3. **Questions: one call, four questions, recommended option first.** Collect
   every decision the design needs before asking any. A second call only when
   an answer changes what the next question is. (This is the Hive's rule and
   it replaces "one question at a time": every serial question parks the
   session for the same information one call gathers.)
4. **Two or three approaches**, trade-offs, your recommendation first, YAGNI
   applied to each.
5. **The design, in sections** scaled to their weight: architecture,
   components, data flow, error handling, testing. Ask after each section
   whether it holds.
6. **A UI surface** gets one browser-rendered HTML mockup of the recommended
   design through the Artifact tool. Variants, two or three, only for a
   surface the app has no pattern for, or on request. Never ASCII. Show them
   before any code.
7. **Write the spec** to `<repo>/.hive/specs/YYYY-MM-DD-<topic>.md`. `.hive/`
   is a working folder, not history: if `<repo>/.hive/.gitignore` does not
   exist, write it with the single line `*`.
8. **Self-review inline**, no subagent: placeholders ("TBD", "handle edge
   cases"), contradictions between sections, scope that needs splitting, any
   requirement readable two ways. Fix and move on.
9. **The person reads the spec.** "Spec written to `<path>`. Read it and tell me
   what to change before I plan." Wait.
10. **`hive:plan`**, and nothing else.

## Design for isolation

Units with one purpose each, communicating through named interfaces, testable
alone. For each unit you can say what it does, how it is used and what it
depends on. If a consumer must read a unit's internals to use it, the boundary
is wrong. A file that has grown past what you can hold at once is usually two.

## Red flags

| Thought | Reality |
| --- | --- |
| "Too simple to need a design" | Two sentences in chat, then approval. |
| "I'll call it bounded and skip the spec" | Reaching for the label is the doubt. Heavier path. |
| "The design is obvious, I'll start while they read" | The gate is the approval, not the design's length. |
| "I know this kind of app, so it's bounded" | Bounded measures the repo. |
| "The spike works, I'll keep the code" | A spike's output is an answer. |
| "It grew, but I'm nearly done" | Stop, say so, re-classify. |
| "I'll ask one question now and the rest later" | One call, four questions. |

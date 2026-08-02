# Simulation mode

**Scope:** the scripted event replay that makes the prototype feel alive, and the
fake clock it runs on.

**Owned by story 061** (`../../stories/061-simulation-mode.md`). This file is a
placeholder until that story lands; it exists now so the routing table in
`../AGENTS.md` never points at a missing file.

## What already holds today

- The flag is parsed in `src/config/env.ts`: `?sim=1` enables simulation.
  `SIMULATION_ENABLED` is the only export, and nothing consumes it yet.
- `sendToEntity` returns its `setTimeout` handle specifically so scripted and
  test-driven runs can cancel a pending acknowledgement deterministically rather
  than racing a real wait. Simulation is expected to use the same escape hatch.
- `appendEntityLines(id, lines, status?)` is the intended write path for replayed
  events — it appends transcript and optionally moves a session's status in one
  step.

## What story 061 adds here

The event script format, the fake clock, the driver that feeds events into the
stores, and the rule for what simulation may and may not mutate.

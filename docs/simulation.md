# Simulation mode

**Scope:** the scripted event replay that makes the prototype feel alive, and the
fake clock it runs on.

**Owned by story 061** (HIVE, Jira). This file is a
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
- **The fake clock already exists**: `src/lib/fake-clock.ts`, built by story 053.
  It starts at 14:38, advances a minute per `stamp()`, and `reset()` rewinds it.
  Simulation should stamp its events through it rather than introducing a second
  clock. See [`state-and-data.md`](state-and-data.md) → The fake clock.
  **It has no producer at the moment**: the activity feed was its only one, and
  the project explorer replaced that panel. The module and its `reset()` call in
  `hive-store` were deliberately kept rather than deleted as dead code, so this
  story inherits the seam it was told to use — simulation will be its first
  consumer.
- **`pushNotif(notif)` is the inbox's write path**, capped at 8. Simulation
  prepending a notification is what drives the rail's red badge and the header
  bell (051).

## What story 061 adds here

The event script format, the driver that feeds events into the stores, and the
rule for what simulation may and may not mutate. (The fake clock landed early,
with story 053 — see above.)

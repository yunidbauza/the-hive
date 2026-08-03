# HIVE-48 — Orchestrator Drives Real PTYs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The orchestrator console's `send` and the session message row stop faking a round-trip on a timer and write into the real Claude Code session — `pty.write(sessionId, text + '\r')` — while the browser demo keeps working unchanged.

**Architecture:** One primitive, `sendToSession`, in `src/lib/terminal/session-input.ts`. It reads no store; ids arrive as arguments. Liveness comes from `pty-transport.ts`'s existing module-level channel map, which already knows whether a spawn was requested and whether the process has exited. `src/stores/hive-store.ts` is the only branch point: a live desktop session takes the pty path (feed item, no echo, no timer), everything else — the browser target, agents — keeps the existing demo round-trip. Main's bootstrap gains a second stage so `spawn <repo> <task>` delivers its task once the TUI is up.

**Tech Stack:** React 19, TypeScript (strict), zustand, xterm.js, Electron (`utilityProcess` + `node-pty`), vitest + Testing Library, Playwright (`_electron`).

Design spec: [`../specs/2026-08-03-hive-48-orchestrator-drives-ptys-design.md`](../specs/2026-08-03-hive-48-orchestrator-drives-ptys-design.md)

## Global Constraints

Copied from `app/AGENTS.md`; every task's requirements implicitly include these.

- **kebab-case** for every file and folder under `src/` and `electron/`.
- **Absolute `@/` imports**, never relative parent imports (`../`).
- Import order: builtin → external → internal → parent → sibling → index, `@/**` pinned before internal, blank lines between groups, alphabetised.
- Import zones: `src/stores/**` may not import `src/features/**` or `src/components/**`. `src/lib/**` may not import `src/features/**` or `src/components/**`. `src/**` may not import `electron/main/**` or `electron/pty-host/**`; it reaches `electron/shared/**` through `@shared`, **type-only**.
- **No circular dependencies.**
- Components never read a store object directly and never call `getState()`. Non-render modules may.
- `tests/` **mirrors** `src/`. No exceptions.
- **80% coverage** on lines, statements, branches, functions — the gate fails the build. No coverage-ignore comments.
- Timer-based behaviour uses **fake timers**, never real waits.
- `node-pty` is never loaded for real in unit tests; `__mocks__/node-pty.ts` is the recording fake.
- `pnpm lint` and `pnpm type-check` must both pass before any task is done. No inline rule disables.
- All commands run from `app/`.

## File Structure

**Create**
- `src/lib/terminal/session-input.ts` — the send primitive: newline normalisation, the `\r` suffix, the refusal. Reads no store, touches no DOM beyond `window.hive`.
- `tests/lib/terminal/session-input.test.ts`
- `tests/e2e/electron/orchestrator-routing.spec.ts` — the three desktop assertions.

**Modify**
- `src/lib/terminal/pty-transport.ts` — export `sessionChannelState` and `requestSpawn` over the existing channel map. No change to `TerminalTransport`.
- `src/stores/hive-store.ts` — `sendToEntity` returns a `SendOutcome` and routes live sessions to the pty; `runOrchCommand`'s `send` prints the outcome; `spawnSession` requests the spawn eagerly and logs main's refusal.
- `electron/shared/ipc-contract.ts` — `SpawnRequest.task?: string`.
- `electron/shared/guards.ts` — optional keys in `assertShape`, plus `assertText` for the task.
- `electron/main/ipc/index.ts` — carry `task` through the `pty:spawn` handler.
- `electron/main/sessions/index.ts` — pass `request.task` to `bootstrap.arm`.
- `electron/main/sessions/bootstrap.ts` — the second stage.
- `docs/terminal-architecture.md`, `docs/state-and-data.md` — record the new seam.

**Not touched, deliberately**
- `src/features/orchestrator/utils/parse-command.ts` — zero-line diff. Shape errors stay in the parser; this story only changes the executor.
- `src/features/inbox/**` — cut from this story (design spec, Deviation 1).
- `tests/e2e/web/**` — must stay green untouched. That is the regression signal for Deviation 5.

---

### Task 1: Liveness and a shared spawn request in the transport

**Files:**
- Modify: `src/lib/terminal/pty-transport.ts`
- Test: `tests/lib/terminal/pty-transport.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export type ChannelState = 'live' | 'exited' | 'none'`
  - `export function sessionChannelState(entityId: string): ChannelState`
  - `export function requestSpawn(entityId: string, projectId: string, task?: string): Promise<SpawnOutcome>`
  - `export type SpawnOutcome = { ok: true } | { ok: false; reason: string }`

`'none'` means no channel exists or no spawn was ever requested. `'exited'` means the channel closed — the process died, the host was lost, or the spawn was refused. `'live'` is the only state that accepts a write.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/terminal/pty-transport.test.ts`. Follow the file's existing setup — it already stubs `window.hive` and calls `resetPtyChannels()` in `afterEach`.

```ts
describe('sessionChannelState', () => {
  it('is none for an entity that has never had a surface', () => {
    expect(sessionChannelState('never-opened')).toBe('none');
  });

  it('is live once a transport has requested a spawn', () => {
    const transport = createPtyTransport('sess-a1', 'apfm-web');
    transport.onData(() => {});

    expect(sessionChannelState('sess-a1')).toBe('live');
  });

  it('is exited after the process ends', () => {
    const transport = createPtyTransport('sess-a1', 'apfm-web');
    transport.onData(() => {});

    emitExit({ sessionId: 'sess-a1', exitCode: 0, signal: 0 });

    expect(sessionChannelState('sess-a1')).toBe('exited');
  });

  it('is exited after the host is lost, not live', () => {
    const transport = createPtyTransport('sess-a1', 'apfm-web');
    transport.onData(() => {});

    emitLost({ sessionId: 'sess-a1' });

    expect(sessionChannelState('sess-a1')).toBe('exited');
  });
});

describe('requestSpawn', () => {
  it('asks main exactly once, however many callers ask', async () => {
    const first = requestSpawn('sess-a1', 'apfm-web');
    const second = requestSpawn('sess-a1', 'apfm-web');

    await Promise.all([first, second]);

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('carries the task on the spawn request', async () => {
    await requestSpawn('sess-a1', 'apfm-web', 'fix the hero');

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'fix the hero' }),
    );
  });

  it('resolves with main’s refusal rather than throwing', async () => {
    spawn.mockRejectedValueOnce(
      new Error('apfm-web is not mapped — add it to /tmp/hive.json'),
    );

    const result = await requestSpawn('sess-a1', 'apfm-web');

    expect(result).toEqual({
      ok: false,
      reason: 'apfm-web is not mapped — add it to /tmp/hive.json',
    });
  });

  it('hands a mounting surface the same request, so nothing spawns twice', async () => {
    const pending = requestSpawn('sess-a1', 'apfm-web');
    const transport = createPtyTransport('sess-a1', 'apfm-web');
    transport.onData(() => {});

    await pending;

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- tests/lib/terminal/pty-transport.test.ts`
Expected: FAIL — `sessionChannelState is not a function`, `requestSpawn is not a function`.

- [ ] **Step 3: Implement over the existing channel map**

In `src/lib/terminal/pty-transport.ts`, add `spawnResult` to `EntityChannel` and initialise it in `openChannel`:

```ts
interface EntityChannel {
  // …existing fields…
  /**
   * The in-flight (or settled) spawn request, shared by every caller.
   *
   * `spawnRequested` alone answers "has one been asked for"; this answers
   * "how did it go", which is what a console that must print the refusal
   * needs. Held on the channel rather than in a second map so the two can
   * never disagree about whether a process was asked for.
   */
  spawnResult: Promise<SpawnOutcome> | null;
}
```

Replace `ensureSpawned` with a version that returns the shared promise, and express the old fire-and-forget call site in terms of it:

```ts
export type SpawnOutcome = { ok: true } | { ok: false; reason: string };

export type ChannelState = 'live' | 'exited' | 'none';

export function sessionChannelState(entityId: string): ChannelState {
  const channel = channels.get(entityId);
  if (!channel || !channel.spawnRequested) return 'none';
  return channel.closed ? 'exited' : 'live';
}

/**
 * Request a process for this entity, at most once, and report the outcome.
 *
 * The console needs main's refusal *as a value* so it can print it; the
 * transport needs it as a terminal notice. Both read the same promise, so a
 * surface mounting after the console asked cannot start a second process —
 * which would put two `claude` instances in one repository.
 */
export function requestSpawn(
  entityId: string,
  projectId: string,
  task?: string,
): Promise<SpawnOutcome> {
  const channel = channels.get(entityId) ?? openChannel(entityId);
  if (channel.spawnResult) return channel.spawnResult;

  channel.spawnRequested = true;
  channel.spawnResult = pty()
    .spawn({
      sessionId: entityId,
      projectId,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      ...(task === undefined ? {} : { task }),
    })
    .then((): SpawnOutcome => ({ ok: true }))
    .catch((cause: unknown): SpawnOutcome => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      /**
       * A refusal is information, and it belongs in the terminal *as well as*
       * wherever the caller reports it. Swallowing it here leaves an empty
       * black rectangle, which is the failure mode this path exists to avoid.
       */
      if (!channel.closed) {
        channel.closed = true;
        emit(channel, spawnRefused(reason));
      }
      return { ok: false, reason };
    });

  return channel.spawnResult;
}

function ensureSpawned(
  channel: EntityChannel,
  entityId: string,
  projectId: string,
): void {
  if (channel.spawnRequested) return;
  void requestSpawn(entityId, projectId);
}
```

Initialise `spawnResult: null` in `openChannel`'s object literal.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/lib/terminal/pty-transport.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Verify nothing else regressed, then commit**

```bash
pnpm test && pnpm lint && pnpm type-check
git add src/lib/terminal/pty-transport.ts tests/lib/terminal/pty-transport.test.ts
git commit -m "feat(terminal): channel state and a shared spawn request (HIVE-48)"
```

---

### Task 2: The send primitive

**Files:**
- Create: `src/lib/terminal/session-input.ts`
- Test: `tests/lib/terminal/session-input.test.ts`

**Interfaces:**
- Consumes: `sessionChannelState` from Task 1.
- Produces:
  - `export type SendResult = { ok: true } | { ok: false; reason: string }`
  - `export function normalizeInput(text: string): string`
  - `export function sendToSession(entityId: string, text: string): SendResult`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/terminal/session-input.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeInput,
  sendToSession,
} from '@lib/terminal/session-input';
import {
  createPtyTransport,
  resetPtyChannels,
} from '@lib/terminal/pty-transport';

const write = vi.fn();
const spawn = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  window.hive = {
    pty: {
      spawn,
      write,
      resize: vi.fn(),
      kill: vi.fn(),
      ack: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      onLost: vi.fn(() => () => {}),
      restart: vi.fn(),
    },
  } as unknown as Window['hive'];
});

afterEach(() => {
  resetPtyChannels();
  delete (window as { hive?: unknown }).hive;
});

/** Bring an entity to `live` the way a mounted surface would. */
const openSession = (id: string) => {
  createPtyTransport(id, 'apfm-web').onData(() => {});
};

describe('normalizeInput', () => {
  it('collapses newlines to spaces so a paste submits once', () => {
    expect(normalizeInput('first\nsecond')).toBe('first second');
    expect(normalizeInput('first\r\nsecond')).toBe('first second');
    expect(normalizeInput('first\rsecond')).toBe('first second');
  });

  it('trims the ends but keeps interior spacing', () => {
    expect(normalizeInput('  a  b  ')).toBe('a  b');
  });
});

describe('sendToSession', () => {
  it('submits with a carriage return, not a newline', () => {
    openSession('sess-a1');

    expect(sendToSession('sess-a1', 'y')).toEqual({ ok: true });
    expect(write).toHaveBeenCalledWith({ sessionId: 'sess-a1', data: 'y\r' });
  });

  it('sends the normalised text, not the raw text', () => {
    openSession('sess-a1');

    sendToSession('sess-a1', 'one\ntwo');

    expect(write).toHaveBeenCalledWith({
      sessionId: 'sess-a1',
      data: 'one two\r',
    });
  });

  it('refuses a session that was never opened, and writes nothing', () => {
    const result = sendToSession('sess-a1', 'y');

    expect(result).toEqual({
      ok: false,
      reason: 'sess-a1 has no live session — open it to start one',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a session that has exited, and writes nothing', () => {
    openSession('sess-a1');
    // The channel closes on exit; see pty-transport's onExit subscription.
    const onExit = vi.mocked(window.hive!.pty.onExit).mock.calls[0]![0];
    onExit({ sessionId: 'sess-a1', exitCode: 0, signal: 0, seq: 1 } as never);

    const result = sendToSession('sess-a1', 'y');

    expect(result).toEqual({
      ok: false,
      reason: 'sess-a1 has exited — restart it to send again',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses an empty message rather than submitting a bare newline', () => {
    openSession('sess-a1');

    expect(sendToSession('sess-a1', '   ')).toEqual({
      ok: false,
      reason: 'nothing to send',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses when there is no bridge at all', () => {
    delete (window as { hive?: unknown }).hive;

    expect(sendToSession('sess-a1', 'y').ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/lib/terminal/session-input.test.ts`
Expected: FAIL — cannot resolve `@lib/terminal/session-input`.

- [ ] **Step 3: Implement the primitive**

Create `src/lib/terminal/session-input.ts`:

```ts
import { sessionChannelState } from '@lib/terminal/pty-transport';

/**
 * Putting text into a live session (story 097).
 *
 * The whole mechanism of the coordination layer, and deliberately tiny: Claude
 * Code's TUI sits at a prompt, so text plus a carriage return is exactly what a
 * person typing would produce, and therefore exactly what the orchestrator
 * produces. No message bus, no protocol, no injection format.
 *
 * **Reads no store.** Ids arrive as arguments, the same discipline
 * `pty-transport.ts` holds itself to — which is also what keeps this module out
 * of an import cycle with `resolve-transport.ts`, the store-aware half of the
 * seam.
 */

export type SendResult = { ok: true } | { ok: false; reason: string };

/**
 * Every newline becomes a space.
 *
 * A multi-line message pasted into the row would otherwise submit its first
 * line and leave the rest sitting at the prompt as a half-typed second command.
 * `\r\n` is collapsed before the bare forms so it does not become two spaces.
 */
export function normalizeInput(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ').trim();
}

export function sendToSession(entityId: string, text: string): SendResult {
  const message = normalizeInput(text);
  if (message === '') return { ok: false, reason: 'nothing to send' };

  /**
   * Refuse rather than no-op, and say which kind of nothing this is.
   *
   * Main's `write` returns early for an entity with no live session — silently,
   * and correctly, because it cannot know whether that is a bug. The renderer
   * can: a session that was never opened has no process yet, and one that
   * exited needs a restart. Those are different problems with different fixes,
   * and a routing layer that fails silently is the worst possible outcome.
   */
  switch (sessionChannelState(entityId)) {
    case 'none':
      return {
        ok: false,
        reason: `${entityId} has no live session — open it to start one`,
      };
    case 'exited':
      return {
        ok: false,
        reason: `${entityId} has exited — restart it to send again`,
      };
    case 'live':
      break;
  }

  const bridge = window.hive;
  // Unreachable with a live channel — a channel can only exist where a bridge
  // did. Explicit anyway: the alternative is a TypeError inside a keystroke
  // handler, which reads as an xterm bug.
  if (!bridge) {
    return { ok: false, reason: 'this build has no terminal bridge' };
  }

  /**
   * `\r`, not `\n`. A terminal's Enter key sends carriage return; the line
   * discipline is what turns it into "line submitted". A bare line feed is
   * inserted literally by some shells and readline configurations, leaving the
   * message typed but never sent. `bootstrap.ts` relies on the same fact.
   */
  bridge.pty.write({ sessionId: entityId, data: `${message}\r` });
  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- tests/lib/terminal/session-input.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm lint && pnpm type-check
git add src/lib/terminal/session-input.ts tests/lib/terminal/session-input.test.ts
git commit -m "feat(terminal): sendToSession — text plus a carriage return (HIVE-48)"
```

---

### Task 3: The store routes live sessions to the pty

**Files:**
- Modify: `src/stores/hive-store.ts`
- Test: `tests/stores/hive-store.test.ts`

**Interfaces:**
- Consumes: `sendToSession`, `SendResult` (Task 2); `sessionChannelState` (Task 1).
- Produces:
  - `export type SendOutcome = { kind: 'routed' } | { kind: 'refused'; reason: string } | { kind: 'demo'; timer: ReturnType<typeof setTimeout> }`
  - `sendToEntity: (id: string, msg: string, origin?: MessageOrigin) => SendOutcome | null` — `null` only for an unknown entity, as before.

The demo variant still carries the timer handle, so the simulation and the existing tests keep their deterministic cancel.

- [ ] **Step 1: Write the failing tests**

Add to `tests/stores/hive-store.test.ts`, inside the existing `describe('sendToEntity')`:

```ts
describe('on a live desktop session', () => {
  beforeEach(() => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(sendToSession).mockReturnValue({ ok: true });
  });

  it('routes to the pty and reports it', () => {
    const outcome = useHiveStore.getState().sendToEntity('lead-form', 'y');

    expect(sendToSession).toHaveBeenCalledWith('lead-form', 'y');
    expect(outcome).toEqual({ kind: 'routed' });
  });

  it('does not echo into the transcript — that is the pty’s job', () => {
    const before = useHiveStore.getState().entities['lead-form']!.lines.length;

    useHiveStore.getState().sendToEntity('lead-form', 'y');

    expect(useHiveStore.getState().entities['lead-form']!.lines).toHaveLength(
      before,
    );
  });

  it('starts no acknowledgement timer', () => {
    useHiveStore.getState().sendToEntity('lead-form', 'y');

    vi.advanceTimersByTime(ACK_DELAY_MS * 2);

    expect(useHiveStore.getState().entities['lead-form']!.status).not.toBe(
      'working',
    );
  });

  it('still logs the routing to the activity feed', () => {
    useHiveStore.getState().sendToEntity('lead-form', 'y');

    expect(useHiveStore.getState().feed[0]!.txt).toBe(
      'Routed your reply to lead-form',
    );
  });

  it('reports a refusal and writes nothing', () => {
    vi.mocked(sendToSession).mockReturnValue({
      ok: false,
      reason: 'lead-form has exited — restart it to send again',
    });
    const before = useHiveStore.getState().entities['lead-form']!.lines.length;

    const outcome = useHiveStore.getState().sendToEntity('lead-form', 'y');

    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'lead-form has exited — restart it to send again',
    });
    expect(useHiveStore.getState().entities['lead-form']!.lines).toHaveLength(
      before,
    );
  });

  it('leaves agents on the demo round-trip — they have no pty this epic', () => {
    const outcome = useHiveStore.getState().sendToEntity('slack-agent', 'hi');

    expect(sendToSession).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'demo' });
  });
});

describe('on the browser target', () => {
  it('keeps the demo round-trip, timer and all', () => {
    vi.mocked(isDesktop).mockReturnValue(false);

    const outcome = useHiveStore.getState().sendToEntity('lead-form', 'y');

    expect(sendToSession).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'demo' });

    vi.advanceTimersByTime(ACK_DELAY_MS);
    expect(useHiveStore.getState().entities['lead-form']!.status).toBe(
      'working',
    );
  });
});
```

At the top of the file add the mocks:

```ts
vi.mock('@config/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@config/runtime')>()),
  isDesktop: vi.fn(() => false),
}));
vi.mock('@lib/terminal/session-input', () => ({
  sendToSession: vi.fn(() => ({ ok: true })),
  normalizeInput: (text: string) => text.trim(),
}));
```

and the matching imports (`isDesktop` from `@config/runtime`, `sendToSession` from `@lib/terminal/session-input`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- tests/stores/hive-store.test.ts`
Expected: FAIL — `sendToSession` is never called; `sendToEntity` returns a timer handle, not an outcome.

- [ ] **Step 3: Implement the branch**

In `src/stores/hive-store.ts`, add the imports and the outcome type:

```ts
import { isDesktop } from '@config/runtime';
import { sendToSession } from '@lib/terminal/session-input';
```

```ts
/**
 * What happened to a message.
 *
 * The action has to *report*, not just act: the console prints the refusal and
 * only its caller knows where that line goes. Story 097 says the signature is
 * unchanged; it cannot be, and the deviation is recorded in the design spec.
 *
 * `demo` still carries the timer handle so the simulation (story 061) and the
 * tests keep cancelling deterministically rather than racing a real wait.
 */
export type SendOutcome =
  | { kind: 'routed' }
  | { kind: 'refused'; reason: string }
  | { kind: 'demo'; timer: ReturnType<typeof setTimeout> };
```

Change the `sendToEntity` field type on `HiveState` to
`(id: string, msg: string, origin?: MessageOrigin) => SendOutcome | null`, and rewrite the action's opening:

```ts
sendToEntity: (id, msg, origin = 'orchestrator') => {
  const entity = get().entities[id];
  if (!entity) return null;

  /**
   * A real session takes the pty path; everything else keeps the prototype's
   * round-trip.
   *
   * Agents are the interesting half of that "everything else". They have no
   * project and no process this epic (story 096's scope note), so a pty path
   * for them would refuse every message where the demo answers. The browser
   * target is the same shape for a different reason — no bridge to ask.
   */
  if (isDesktop() && isSession(entity)) {
    const result = sendToSession(id, msg);

    get().pushFeed({
      time: stamp(),
      txt: result.ok
        ? origin === 'orchestrator'
          ? `Routed your reply to ${id}`
          : `Routed your message to ${id}`
        : `Could not route to ${id} — ${result.reason}`,
      tone: result.ok ? 'brand' : 'amber',
      icon: result.ok ? 'ph-paper-plane-tilt' : 'ph-warning',
    });

    /**
     * No echo. The pty echoes what it receives, and appending here too would
     * double-print every message — the defect story 097 names by name.
     */
    return result.ok ? { kind: 'routed' } : { kind: 'refused', reason: result.reason };
  }

  // …the existing demo path, unchanged, now returning:
  return { kind: 'demo', timer: setTimeout(/* …unchanged… */) };
},
```

Leave the demo path's echo, feed item and `ACK_LINE` timer exactly as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/stores/hive-store.test.ts`
Expected: PASS. The pre-existing `returns the timer handle so the ack can be cancelled` test needs its assertion updated to read `outcome.timer` — do that, it is the same guarantee under the new shape.

- [ ] **Step 5: Fix the other callers of `sendToEntity`**

`src/features/sessions/components/message-input.tsx` ignores the return value already; confirm it still compiles. `src/features/simulation/**` may read the timer — update it to `outcome?.kind === 'demo' ? outcome.timer : null`.

Run: `pnpm type-check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
pnpm test && pnpm lint && pnpm type-check
git add src/stores/hive-store.ts src/features tests/stores/hive-store.test.ts
git commit -m "feat(sessions): route live sessions to the pty, keep the demo elsewhere (HIVE-48)"
```

---

### Task 4: The console prints what happened

**Files:**
- Modify: `src/stores/hive-store.ts`
- Test: `tests/stores/hive-store.test.ts`

**Interfaces:**
- Consumes: `SendOutcome` (Task 3), `requestSpawn` (Task 1).
- Produces: no new exports. `spawnSession`'s signature is unchanged — it still returns the new entity id synchronously.

- [ ] **Step 1: Write the failing tests**

Add inside `describe('runOrchCommand')`:

```ts
describe('send, on desktop', () => {
  beforeEach(() => {
    vi.mocked(isDesktop).mockReturnValue(true);
  });

  it('confirms a routed message', () => {
    vi.mocked(sendToSession).mockReturnValue({ ok: true });

    run('send lead-form y');

    expect(lastLine().text).toBe('  routed → lead-form');
  });

  it('prints the refusal verbatim, in red', () => {
    vi.mocked(sendToSession).mockReturnValue({
      ok: false,
      reason: 'lead-form has exited — restart it to send again',
    });

    run('send lead-form y');

    expect(lastLine()).toEqual({
      text: '  lead-form has exited — restart it to send again',
      color: 'red',
    });
  });
});

describe('spawn, on desktop', () => {
  beforeEach(() => {
    vi.mocked(isDesktop).mockReturnValue(true);
  });

  it('prints main’s refusal verbatim rather than a generic failure', async () => {
    vi.mocked(requestSpawn).mockResolvedValue({
      ok: false,
      reason: 'apfm-web is not mapped — add it to /tmp/hive.json',
    });

    run('spawn apfm-web tidy the footer');
    await vi.waitFor(() =>
      expect(lastLine().text).toBe(
        '  apfm-web is not mapped — add it to /tmp/hive.json',
      ),
    );
    expect(lastLine().color).toBe('red');
  });

  it('carries the task to the spawn request', () => {
    vi.mocked(requestSpawn).mockResolvedValue({ ok: true });

    run('spawn apfm-web tidy the footer');

    expect(requestSpawn).toHaveBeenCalledWith(
      expect.any(String),
      'apfm-web',
      'tidy the footer',
    );
  });

  it('asks for no process on the browser target', () => {
    vi.mocked(isDesktop).mockReturnValue(false);

    run('spawn apfm-web tidy the footer');

    expect(requestSpawn).not.toHaveBeenCalled();
  });
});
```

Add `requestSpawn` to the `@lib/terminal/pty-transport` mock:

```ts
vi.mock('@lib/terminal/pty-transport', () => ({
  requestSpawn: vi.fn(() => Promise.resolve({ ok: true })),
  sessionChannelState: vi.fn(() => 'live'),
  resetPtyChannels: vi.fn(),
}));
```

`run` and `lastLine` are the file's existing helpers.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- tests/stores/hive-store.test.ts`
Expected: FAIL — the console prints `routed → lead-form` unconditionally and `requestSpawn` is never called.

- [ ] **Step 3: Implement the `send` case**

Replace the `send` case body in `runOrchCommand`:

```ts
case 'send': {
  if (!get().entities[command.target]) {
    pushOrch(`  no such session: ${command.target}`, 'red');
    return;
  }

  const outcome = get().sendToEntity(command.target, command.message);
  if (outcome?.kind === 'refused') {
    // Verbatim. The console prints failures; it does not translate or soften
    // them — the reason names what the user has to do about it.
    pushOrch(`  ${outcome.reason}`, 'red');
    return;
  }
  pushOrch(`  routed → ${command.target}`, 'dim');
  return;
}
```

- [ ] **Step 4: Implement the eager spawn**

In `spawnSession`, after the entity is created and its console line written, and **before** `useUiStore.getState().openTab(id)`:

```ts
/**
 * Ask for the process here, not when a surface mounts.
 *
 * The lazy path (story 094's `ensureSpawned`) works, but its refusal reaches
 * only the terminal, asynchronously, and only if a surface mounted at all. The
 * console has to print main's exact message, so the request is made where the
 * transcript is — the same argument that already puts the `spawned …` line
 * here rather than at each call site.
 *
 * Ordering is safe in both directions: `requestSpawn` and the transport share
 * one channel, so whoever asks first is the only one who asks, and main's
 * `open()` is attach-never-respawn regardless.
 */
if (isDesktop()) {
  void requestSpawn(id, repo, task).then((outcome) => {
    if (outcome.ok) return;
    set((state) => ({
      orchLines: capLines([...state.orchLines, line(`  ${outcome.reason}`, 'red')]),
    }));
  });
}
```

Import `requestSpawn` from `@lib/terminal/pty-transport`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- tests/stores/hive-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the parser is untouched**

Run: `git diff --stat src/features/orchestrator/utils/parse-command.ts`
Expected: **no output** — a zero-line diff, which is the story's own acceptance criterion.

Run: `pnpm test -- tests/features/orchestrator/utils/parse-command.test.ts`
Expected: PASS, untouched.

- [ ] **Step 7: Commit**

```bash
pnpm test && pnpm lint && pnpm type-check
git add src/stores/hive-store.ts tests/stores/hive-store.test.ts
git commit -m "feat(orchestrator): console prints routing outcomes and spawn refusals (HIVE-48)"
```

---

### Task 5: `SpawnRequest` carries a task

**Files:**
- Modify: `electron/shared/ipc-contract.ts`, `electron/shared/guards.ts`, `electron/main/ipc/index.ts`
- Test: `tests/electron/shared/guards.test.ts`, `tests/electron/preload/bridge.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SpawnRequest.task?: string`; `parseSpawnRequest` accepts and validates it; `OpenRequest.task?: string` on the sessions layer.

- [ ] **Step 1: Write the failing tests**

Add to `tests/electron/shared/guards.test.ts`:

```ts
describe('parseSpawnRequest, task', () => {
  const base = { sessionId: 'sess-a1', projectId: 'apfm-web', cols: 80, rows: 24 };

  it('accepts a request with no task at all', () => {
    expect(parseSpawnRequest(base).task).toBeUndefined();
  });

  it('accepts an ordinary task', () => {
    expect(parseSpawnRequest({ ...base, task: 'fix the hero' }).task).toBe(
      'fix the hero',
    );
  });

  it('rejects control characters — the task is written into a pty', () => {
    expect(() =>
      parseSpawnRequest({ ...base, task: 'rm -rf /\r' }),
    ).toThrow(IpcValidationError);
    expect(() =>
      parseSpawnRequest({ ...base, task: 'a\u001b[31mb' }),
    ).toThrow(IpcValidationError);
  });

  it('rejects an unbounded task', () => {
    expect(() =>
      parseSpawnRequest({ ...base, task: 'x'.repeat(4097) }),
    ).toThrow(IpcValidationError);
  });

  it('still rejects an unexpected key', () => {
    expect(() => parseSpawnRequest({ ...base, nope: 1 })).toThrow(
      IpcValidationError,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/electron/shared/guards.test.ts`
Expected: FAIL — `spawn: unexpected key "task"`.

- [ ] **Step 3: Widen the contract and the guard**

`electron/shared/ipc-contract.ts`:

```ts
export interface SpawnRequest {
  sessionId: string;
  projectId: string;
  cols: number;
  rows: number;
  /**
   * The first thing to say to the session, once its TUI is up (story 097).
   *
   * Optional because most spawns have nothing to say — a session opened from
   * the picker starts at a prompt and waits. Delivered by the bootstrap rather
   * than the renderer, which has no signal for "the TUI is ready" and by design
   * cannot have one.
   */
  task?: string;
}
```

`electron/shared/guards.ts` — give `assertShape` an optional-key parameter:

```ts
function assertShape(
  value: unknown,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  // …unchanged prologue…
  const allowed = [...required, ...optional];
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) return fail(`${label}: forbidden key "${key}"`);
    if (!allowed.includes(key)) return fail(`${label}: unexpected key "${key}"`);
  }
  for (const key of required) {
    if (!keys.includes(key)) return fail(`${label}: missing key "${key}"`);
  }
  return value as Record<string, unknown>;
}
```

Add the text validator and use it:

```ts
/**
 * Free text that will be **written into a pty**.
 *
 * Bounded, and control characters are rejected outright rather than stripped.
 * A `\r` would submit a line the user never typed; an escape byte would let a
 * payload address the cursor or set a title in a terminal the user is reading.
 * Rejecting says which field was wrong; stripping silently changes what was
 * asked for.
 */
const MAX_TEXT = 4096;

function assertText(value: unknown, label: string): string {
  const text = assertString(value, label);
  if (text.length > MAX_TEXT) return fail(`${label}: too long`);
  for (const char of text) {
    const code = char.codePointAt(0)!;
    /**
     * C0 (which includes `\r`, `\n` and ESC), DEL, and C1.
     *
     * Expressed by code point rather than a regex literal so this source file
     * stays free of control bytes and `no-control-regex` never has to be
     * disabled.
     */
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return fail(`${label}: control characters are not allowed`);
    }
  }
  return text;
}

export function parseSpawnRequest(input: unknown): SpawnRequest {
  const raw = assertShape(
    input,
    ['sessionId', 'projectId', 'cols', 'rows'],
    'spawn',
    ['task'],
  );
  return {
    sessionId: assertId(raw.sessionId, 'spawn.sessionId'),
    projectId: assertId(raw.projectId, 'spawn.projectId'),
    cols: assertDimension(raw.cols, 'spawn.cols'),
    rows: assertDimension(raw.rows, 'spawn.rows'),
    ...(raw.task === undefined ? {} : { task: assertText(raw.task, 'spawn.task') }),
  };
}
```

- [ ] **Step 4: Carry it through the handler**

`electron/main/ipc/index.ts`, in the `CH.ptySpawn` handler:

```ts
sessions?.open({
  entityId: request.sessionId,
  projectId: request.projectId,
  cols: request.cols,
  rows: request.rows,
  task: request.task,
});
```

Leave `CH.ptyRestart` alone — a restart replays the shell, not the original instruction; re-delivering a task the agent has already worked on would be worse than delivering nothing.

Add `task?: string` to `OpenRequest` in `electron/main/sessions/index.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- tests/electron/`
Expected: PASS. `tests/electron/preload/bridge.test.ts` should still pass — no verb was added, only a field widened.

- [ ] **Step 6: Commit**

```bash
pnpm test && pnpm lint && pnpm type-check
git add electron/shared electron/main/ipc/index.ts electron/main/sessions/index.ts tests/electron
git commit -m "feat(ipc): SpawnRequest carries an optional task (HIVE-48)"
```

---

### Task 6: The bootstrap's second stage

**Files:**
- Modify: `electron/main/sessions/bootstrap.ts`, `electron/main/sessions/index.ts`
- Test: `tests/electron/main/sessions/bootstrap.test.ts`

**Interfaces:**
- Consumes: `OpenRequest.task` (Task 5).
- Produces: `Bootstrap.arm(entityId: string, command: string, task?: string): void` — signature widened, behaviour unchanged when `task` is omitted.

- [ ] **Step 1: Write the failing tests**

Add to `tests/electron/main/sessions/bootstrap.test.ts`:

```ts
describe('the task stage', () => {
  it('writes the task after the TUI’s first output, not with the command', () => {
    const write = vi.fn();
    const bootstrap = createBootstrap({ write });

    bootstrap.arm('sess-a1', 'claude', 'fix the hero');

    bootstrap.sawOutput('sess-a1');
    vi.advanceTimersByTime(BOOTSTRAP_DEBOUNCE_MS);
    expect(write).toHaveBeenCalledExactlyOnceWith('sess-a1', 'claude\r');

    // The TUI paints; that is the signal the second stage waits for.
    bootstrap.sawOutput('sess-a1');
    vi.advanceTimersByTime(BOOTSTRAP_DEBOUNCE_MS);
    expect(write).toHaveBeenLastCalledWith('sess-a1', 'fix the hero\r');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('writes the task exactly once, however much the TUI paints', () => {
    const write = vi.fn();
    const bootstrap = createBootstrap({ write });

    bootstrap.arm('sess-a1', 'claude', 'fix the hero');
    bootstrap.sawOutput('sess-a1');
    vi.advanceTimersByTime(BOOTSTRAP_DEBOUNCE_MS);
    bootstrap.sawOutput('sess-a1');
    vi.advanceTimersByTime(BOOTSTRAP_DEBOUNCE_MS);

    bootstrap.sawOutput('sess-a1');
    bootstrap.sawOutput('sess-a1');
    vi.advanceTimersByTime(BOOTSTRAP_FALLBACK_MS * 2);

    expect(write).toHaveBeenCalledTimes(2);
  });

  it('writes the task even if the TUI prints nothing at all', () => {
    const write = vi.fn();
    const bootstrap = createBootstrap({ write });

    bootstrap.arm('sess-a1', 'claude', 'fix the hero');
    bootstrap.sawOutput('sess-a1');
    vi.advanceTimersByTime(BOOTSTRAP_DEBOUNCE_MS);

    vi.advanceTimersByTime(BOOTSTRAP_FALLBACK_MS);

    expect(write).toHaveBeenLastCalledWith('sess-a1', 'fix the hero\r');
  });

  it('drops a pending task when the session dies between stages', () => {
    const write = vi.fn();
    const bootstrap = createBootstrap({ write });

    bootstrap.arm('sess-a1', 'claude', 'fix the hero');
    bootstrap.sawOutput('sess-a1');
    vi.advanceTimersByTime(BOOTSTRAP_DEBOUNCE_MS);

    bootstrap.cancel('sess-a1');
    vi.advanceTimersByTime(BOOTSTRAP_FALLBACK_MS * 2);

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('is still a single write when there is no task', () => {
    const write = vi.fn();
    const bootstrap = createBootstrap({ write });

    bootstrap.arm('sess-a1', 'claude');
    bootstrap.sawOutput('sess-a1');
    vi.advanceTimersByTime(BOOTSTRAP_FALLBACK_MS * 2);

    expect(write).toHaveBeenCalledExactlyOnceWith('sess-a1', 'claude\r');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- tests/electron/main/sessions/bootstrap.test.ts`
Expected: FAIL — `arm` takes two arguments and writes once.

- [ ] **Step 3: Implement the second stage**

In `electron/main/sessions/bootstrap.ts`, add `task` to `Pending`, widen `arm`, and re-arm inside `fire`:

```ts
interface Pending {
  command: string;
  /** Written after the *next* settle, once the command's TUI is up. */
  task?: string;
  timer: ReturnType<typeof setTimeout>;
  settling: boolean;
}
```

```ts
function fire(entityId: string, silent: boolean): void {
  const entry = pending.get(entityId);
  if (!entry) return;
  pending.delete(entityId);
  if (silent) onSilentStart?.(entityId);
  write(entityId, `${entry.command}\r`);

  /**
   * The task is the same problem one level down, so it gets the same answer.
   *
   * `claude` has to start and paint its prompt before it will accept input,
   * and the renderer cannot see that happen — `session:status` carries
   * `working | idle | done` and deliberately nothing finer. Re-arming with
   * `settling: false` means the TUI's first paint restarts the identical
   * debounce, and the fallback still covers a TUI that prints nothing.
   *
   * Re-arming rather than chaining also inherits `cancel`: a session that dies
   * between the two stages drops the task with everything else.
   */
  if (entry.task === undefined) return;
  pending.set(entityId, {
    command: entry.task,
    settling: false,
    timer: setTimeout(() => fire(entityId, true), fallbackMs),
  });
}
```

```ts
arm(entityId, command, task) {
  if (pending.has(entityId)) return;
  pending.set(entityId, {
    command,
    ...(task === undefined ? {} : { task }),
    settling: false,
    timer: setTimeout(() => fire(entityId, true), fallbackMs),
  });
},
```

Update the `Bootstrap` interface: `arm(entityId: string, command: string, task?: string): void`.

In `electron/main/sessions/index.ts`'s `spawn`, pass it through:

```ts
bootstrap.arm(request.entityId, snapshot.claudeCommand, request.task);
```

Note `restartOnce` calls `spawn(request)` with the original `OpenRequest`. Strip the task there so a restart does not replay it:

```ts
spawn({ ...request, task: undefined });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/electron/main/sessions/`
Expected: PASS, including the pre-existing bootstrap suite.

- [ ] **Step 5: Add the restart assertion**

In `tests/electron/main/sessions/index.test.ts`:

```ts
it('does not replay the spawn task on restart', async () => {
  // A restart discards the agent's context; re-delivering an instruction it
  // has already acted on would be worse than delivering nothing.
  await harness.sessions.restart({
    entityId: 'sess-a1',
    projectId: 'apfm-web',
    cols: 80,
    rows: 24,
  });

  expect(harness.armed).toEqual(
    expect.arrayContaining([expect.objectContaining({ task: undefined })]),
  );
});
```

Adapt to the file's existing harness shape.

- [ ] **Step 6: Commit**

```bash
pnpm test && pnpm lint && pnpm type-check
git add electron/main/sessions tests/electron/main/sessions
git commit -m "feat(sessions): deliver the spawn task once the TUI is up (HIVE-48)"
```

---

### Task 7: Desktop end-to-end, and the docs

**Files:**
- Create: `tests/e2e/electron/orchestrator-routing.spec.ts`
- Modify: `docs/terminal-architecture.md`, `docs/state-and-data.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing importable.

- [ ] **Step 1: Write the spec**

Create `tests/e2e/electron/orchestrator-routing.spec.ts`, following `tests/e2e/electron/session-lifecycle.spec.ts` for the fixture, the scratch config and the `expect.poll` discipline (no fixed sleeps):

```ts
import { expect, test } from '@playwright/test';

/**
 * The coordination layer, against a real pty (story 097).
 *
 * Vitest proves the routing; only this proves the text arrives. Every
 * assertion polls a predicate to a deadline — a real shell decides when it is
 * ready, and a fixed sleep would encode this machine's speed as the contract.
 */

test('a console send reaches the session’s terminal', async ({}, testInfo) => {
  // …launch with a scratch project mapped, open a session, wait for a prompt…
  await runConsole(page, 'send sess-a1 echo routed-ok');

  await expect
    .poll(() => terminalText(page, 'sess-a1'), { timeout: 20_000 })
    .toContain('routed-ok');
});

test('a message typed into the row reaches the same prompt', async ({}, testInfo) => {
  await messageInput(page, 'sess-a1').fill('echo row-ok');
  await messageInput(page, 'sess-a1').press('Enter');

  await expect
    .poll(() => terminalText(page, 'sess-a1'), { timeout: 20_000 })
    .toContain('row-ok');
});

test('the message is not double-printed', async ({}, testInfo) => {
  await messageInput(page, 'sess-a1').fill('echo once-only');
  await messageInput(page, 'sess-a1').press('Enter');

  await expect
    .poll(() => terminalText(page, 'sess-a1'), { timeout: 20_000 })
    .toContain('once-only');

  // The pty echoes the typed line and prints its output — two occurrences.
  // A renderer-side echo would make three, which is the defect this guards.
  const text = await terminalText(page, 'sess-a1');
  expect(text.split('once-only')).toHaveLength(3);
});

test('spawn delivers its task as the session’s first message', async ({}, testInfo) => {
  await runConsole(page, 'spawn scratch echo task-delivered');

  await expect
    .poll(() => terminalText(page, spawnedId), { timeout: 30_000 })
    .toContain('task-delivered');
});

test('an unmapped spawn prints main’s refusal in the console', async ({}, testInfo) => {
  await runConsole(page, 'spawn unmapped-project do things');

  await expect
    .poll(() => consoleText(page), { timeout: 20_000 })
    .toContain('unmapped-project is not mapped — add it to');
});

test('sending to a session with no process refuses rather than failing silently', async ({}, testInfo) => {
  await runConsole(page, 'send never-opened hello');

  await expect
    .poll(() => consoleText(page), { timeout: 10_000 })
    .toContain('has no live session');
});
```

Replace the placeholder helper calls with the concrete fixture from `session-lifecycle.spec.ts`, and fix the stray character in the last test name.

- [ ] **Step 2: Run the desktop suite**

Run: `pnpm test:e2e:electron`
Expected: PASS. Run it five times and record the result — story 070's no-flake standard.

- [ ] **Step 3: Confirm the browser suite is untouched and green**

Run: `pnpm test:e2e:web`
Expected: PASS with a zero-line diff under `tests/e2e/web/`. This is the acceptance criterion for Deviation 5.

Run: `git diff --stat origin/main -- tests/e2e/web`
Expected: no output.

- [ ] **Step 4: Update the docs**

- `docs/terminal-architecture.md` — a section on `session-input.ts`: the `\r` rule, newline normalisation, and why liveness reads the channel map rather than `isLiveTerminal`.
- `docs/state-and-data.md` — `sendToEntity` now returns a `SendOutcome`; the demo round-trip is reached only where no pty backs the entity.

- [ ] **Step 5: Full verification**

```bash
pnpm test:coverage && pnpm lint && pnpm type-check && pnpm verify:boundaries
```

Expected: all green, coverage above 80% on all four axes, boundaries still 28/28 or higher.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/electron/orchestrator-routing.spec.ts docs
git commit -m "test(e2e): the coordination layer against a real pty (HIVE-48)"
```

---

## Self-review

**Spec coverage.** Deviation 1 (inbox cut) → no task, recorded in the plan's "not touched" list and in the ticket comment. Deviation 2 (`lib/terminal` placement) → Task 2. Deviation 3 (channel-map liveness) → Task 1. Deviation 4 (`SendOutcome`) → Task 3. Deviation 5 (timer gated) → Task 3 + Task 7 Step 3. Deviation 6 (eager spawn, console refusal) → Task 1 + Task 4. Deviation 7 (bootstrap second stage) → Tasks 5 and 6.

**Type consistency.** `SpawnOutcome` (transport, Task 1) and `SendResult` (session-input, Task 2) are structurally identical but named separately because they answer different questions and live in different modules; `SendOutcome` (store, Task 3) is the three-way variant. `sessionChannelState` is used under that name in Tasks 1, 2 and 4. `arm(entityId, command, task?)` matches between Tasks 5 and 6.

**Known gap.** Task 7's spec is written against `session-lifecycle.spec.ts`'s fixture without reproducing it; the implementer must read that file. This is the one place the plan points at existing code rather than restating it, because the fixture is ~60 lines of launch plumbing that would drift the moment it is copied.

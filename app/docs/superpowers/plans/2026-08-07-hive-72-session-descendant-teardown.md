# HIVE-72 — Session descendant teardown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A backgrounded descendant of a session's login shell is gone after the app quits, even when it ignores hangup.

**Architecture:** A new `process-tree.ts` owns every read of the process table and every signal. `session-manager.ts` routes both `kill()` and `killAll()` through one teardown that snapshots descendants *before* signalling, sends SIGHUP instead of SIGTERM, and unconditionally sweeps the snapshot afterwards.

**Tech Stack:** TypeScript, Node `child_process.execFile`, node-pty (mocked in unit tests), Vitest, Playwright.

## Global Constraints

- `electron/pty-host/**` may not import `electron/main/**` or `src/**` (verify-boundaries zones at `scripts/verify-boundaries.mjs:224,233`). `node:child_process` is fine.
- Total teardown must finish inside `SHUTDOWN_TIMEOUT_MS` (3,000ms, `electron/shared/pty-host-protocol.ts:152`) or the supervisor force-kills the host mid-sweep and the orphan survives anyway.

  > **Corrected during self review.** This constraint originally read "`PS_TIMEOUT_MS` overlap + `KILL_GRACE_MS` + `SWEEP_SETTLE_MS` ≈ 2.3s". **There is no overlap** — `teardown` awaits `ps`, *then* signals, *then* waits the grace, *then* settles — so the real worst case was 2,000 + 2,000 + 250 = **4,250ms against a 3,000ms limit**, and the supervisor arms that timer *before* it posts the shutdown message. Summing independent constants is what produced the error. The implementation therefore derives a `TEARDOWN_BUDGET_MS` from `SHUTDOWN_TIMEOUT_MS` and threads it through as a deadline that clamps both the grace and the settle, and `PS_TIMEOUT_MS` is 500ms rather than 2,000. A unit test asserts the whole teardown resolves in under 3,000ms in the worst case.
- Unit tests never signal a real process and never exec a real `ps`. Everything goes through the injected seam.
- `kill()` keeps its synchronous `void` return (it implements `SessionOperations.kill`, `electron/pty-host/sessions.ts:18`). It starts async work with `void teardown(...)`.

---

### Task 1: `process-tree.ts` — reading the tree and signalling

**Files:**
- Create: `electron/pty-host/process-tree.ts`
- Test: `tests/electron/pty-host/process-tree.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Descendant { pid: number; pgid: number }`, `ProcessControl { signalGroup(pgid, signal): void; signalPid(pid, signal): void; isAlive(pid): boolean; descendants(roots): Promise<Descendant[]> }`, `createProcessControl(deps?)`, `processControl` (the default instance), `parseProcessTable(text)`, `walkDescendants(rows, roots)`, `PS_TIMEOUT_MS`.

- [ ] **Step 1: Write the failing tests**

```ts
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  createProcessControl,
  parseProcessTable,
  walkDescendants,
} from '../../../electron/pty-host/process-tree';

/** `ps -eo pid=,ppid=,pgid=` output: shell 100 -> job 200 -> sleep 201. */
const TABLE = [
  '    1     0     1',
  '  100    99   100',
  '  200   100   200',
  '  201   200   200',
  '  300    99   300',
].join('\n');

describe('parseProcessTable', () => {
  it('reads pid, ppid and pgid from padded columns', () => {
    expect(parseProcessTable(TABLE)).toContainEqual({
      pid: 201,
      ppid: 200,
      pgid: 200,
    });
  });

  it('skips lines that are not three numbers', () => {
    const rows = parseProcessTable('  bad line\n\n  100    99   100\n');
    expect(rows).toEqual([{ pid: 100, ppid: 99, pgid: 100 }]);
  });
});

describe('walkDescendants', () => {
  it('finds the whole subtree, not just direct children', () => {
    const found = walkDescendants(parseProcessTable(TABLE), [100]);
    expect(found).toEqual([
      { pid: 200, pgid: 200 },
      { pid: 201, pgid: 200 },
    ]);
  });

  it('reports the descendant its own process group, which is the bug', () => {
    // 200 was backgrounded with `&` by an interactive shell, so job control
    // put it in a group of its own. `kill(-100)` cannot reach it.
    const [job] = walkDescendants(parseProcessTable(TABLE), [100]);
    expect(job!.pgid).not.toBe(100);
  });

  it('excludes the roots themselves', () => {
    const found = walkDescendants(parseProcessTable(TABLE), [100]);
    expect(found.map((d) => d.pid)).not.toContain(100);
  });

  it('walks several roots in one pass without duplicating', () => {
    const rows = parseProcessTable(`${TABLE}\n  400   100   400`);
    const found = walkDescendants(rows, [100, 200]);
    expect(found.map((d) => d.pid).sort()).toEqual([200, 201, 400]);
  });

  it('terminates on a ppid cycle instead of hanging the quit path', () => {
    const rows = parseProcessTable('  10    11    10\n  11    10    11\n');
    expect(walkDescendants(rows, [10])).toEqual([{ pid: 11, pgid: 11 }]);
  });
});

describe('descendants', () => {
  it('reads no process table when there are no roots', async () => {
    const readTable = vi.fn(() => Promise.resolve(TABLE));
    const control = createProcessControl({ readTable });

    await expect(control.descendants([])).resolves.toEqual([]);
    expect(readTable).not.toHaveBeenCalled();
  });

  it('resolves empty rather than rejecting when `ps` fails', async () => {
    // Teardown then falls back to the group kill it did before — strictly no
    // worse than today. Blocking the app's quit path would be worse than both.
    const control = createProcessControl({
      readTable: () => Promise.resolve(''),
    });

    await expect(control.descendants([100])).resolves.toEqual([]);
  });

  it('execs nothing on win32, where there is no `ps`', async () => {
    const readTable = vi.fn(() => Promise.resolve(TABLE));
    const control = createProcessControl({ readTable, platform: 'win32' });

    await expect(control.descendants([100])).resolves.toEqual([]);
    expect(readTable).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/electron/pty-host/process-tree.test.ts`
Expected: FAIL — cannot resolve `electron/pty-host/process-tree`.

- [ ] **Step 3: Write the implementation**

```ts
import { execFile } from 'node:child_process';

/**
 * Reading and signalling the process tree (HIVE-72).
 *
 * The only module that reads the process table. It exists because
 * `kill(-shellPid)` reaches one process *group*, and an interactive shell puts
 * every `&` job in a group of its own — so the group kill structurally cannot
 * reach the thing this app most needs dead.
 */

/** A live descendant of a session shell, with the group it belongs to. */
export interface Descendant {
  pid: number;
  pgid: number;
}

export interface ProcessControl {
  /** Signal a process group. */
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
  /** Signal a single process. */
  signalPid(pid: number, signal: NodeJS.Signals): void;
  /** Whether a pid is still around. */
  isAlive(pid: number): boolean;
  /** Every descendant of every root. Resolves empty when unreadable. */
  descendants(roots: readonly number[]): Promise<Descendant[]>;
}

/** How long `ps` gets before teardown gives up on knowing the tree. */
export const PS_TIMEOUT_MS = 2_000;

/** Room for a very busy machine; a truncated table would read as a short one. */
const PS_MAX_BUFFER = 4 * 1024 * 1024;

interface Row {
  pid: number;
  ppid: number;
  pgid: number;
}

/** Parse `ps -eo pid=,ppid=,pgid=` — three padded numeric columns, no header. */
export function parseProcessTable(text: string): Row[] {
  const rows: Row[] = [];

  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3) continue;

    const [pid, ppid, pgid] = parts.map(Number);
    if (
      !Number.isInteger(pid) ||
      !Number.isInteger(ppid) ||
      !Number.isInteger(pgid)
    ) {
      continue;
    }

    rows.push({ pid, ppid, pgid });
  }

  return rows;
}

/** Every descendant of `roots`, breadth-first, roots excluded. */
export function walkDescendants(
  rows: readonly Row[],
  roots: readonly number[],
): Descendant[] {
  const children = new Map<number, Row[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }

  /**
   * Seeded with the roots so one root that is a descendant of another is not
   * reported twice, and so a `ppid` cycle cannot loop forever. No sane kernel
   * produces a cycle — but a parser that *can* hang has no business on the
   * quit path.
   */
  const seen = new Set<number>(roots);
  const queue = [...roots];
  const found: Descendant[] = [];

  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push({ pid: child.pid, pgid: child.pgid });
      queue.push(child.pid);
    }
  }

  return found;
}

/** Read the table, answering `''` for any failure at all. */
function readProcessTable(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-eo', 'pid=,ppid=,pgid='],
      { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER },
      (error, stdout) => {
        resolve(error ? '' : stdout);
      },
    );
  });
}

export interface ProcessControlDeps {
  /** Injected so tests never exec a real `ps`. */
  readTable?: () => Promise<string>;
  platform?: NodeJS.Platform;
}

export function createProcessControl({
  readTable = readProcessTable,
  platform = process.platform,
}: ProcessControlDeps = {}): ProcessControl {
  return {
    signalGroup(pgid, signal) {
      // Negative pid means "the process group led by pgid".
      process.kill(-pgid, signal);
    },

    signalPid(pid, signal) {
      process.kill(pid, signal);
    },

    isAlive(pid) {
      try {
        // Signal 0 asks without delivering anything.
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },

    async descendants(roots) {
      if (roots.length === 0) return [];
      // No Windows build is packaged; this is about not shelling out to a `ps`
      // that does not exist.
      if (platform === 'win32') return [];

      const table = await readTable();
      if (table === '') return [];

      return walkDescendants(parseProcessTable(table), roots);
    },
  };
}

/** The real one. Injected over in every test. */
export const processControl: ProcessControl = createProcessControl();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/electron/pty-host/process-tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/pty-host/process-tree.ts tests/electron/pty-host/process-tree.test.ts
git commit -m "feat(pty): read and signal the process tree (HIVE-72)"
```

---

### Task 2: Teardown — snapshot, SIGHUP, sweep

**Files:**
- Modify: `electron/pty-host/session-manager.ts` (options at :32-42, `killProcessGroup` at :84-90, `signal`/`clearKillTimer` at :123-137, `kill` at :312-326, `killAll` at :345-386)
- Test: `tests/electron/pty-host/session-manager.test.ts` (harness at :48-99, `kill` at :409, `killAll` at :463)

**Interfaces:**
- Consumes: `ProcessControl`, `Descendant`, `processControl` from Task 1.
- Produces: `SessionManagerOptions.control?: ProcessControl` replacing `killGroup`. `SWEEP_SETTLE_MS = 250`.

- [ ] **Step 1: Write the failing tests**

Replace the `killGroup` harness. In the header block:

```ts
import type { ProcessControl } from '../../../electron/pty-host/process-tree';

let control: ProcessControl & {
  signalGroup: Mock<(pgid: number, signal: NodeJS.Signals) => void>;
  signalPid: Mock<(pid: number, signal: NodeJS.Signals) => void>;
  isAlive: Mock<(pid: number) => boolean>;
  descendants: Mock<(roots: readonly number[]) => Promise<Descendant[]>>;
};

/** Every signal, in order, so ordering can be asserted and not just counted. */
let signals: string[];
```

In `beforeEach`, replacing the `killGroup = vi.fn(...)` line:

```ts
signals = [];
control = {
  signalGroup: vi.fn((pgid: number, signal: NodeJS.Signals) => {
    signals.push(`group ${pgid} ${signal}`);
  }),
  signalPid: vi.fn((pid: number, signal: NodeJS.Signals) => {
    signals.push(`pid ${pid} ${signal}`);
  }),
  isAlive: vi.fn((_pid: number) => false),
  descendants: vi.fn((_roots: readonly number[]) => {
    signals.push('descendants');
    return Promise.resolve([] as Descendant[]);
  }),
};
```

and `build()` passes `control` where it passed `killGroup`.

Every existing assertion of the form `expect(killGroup).toHaveBeenCalledWith(4242, 'SIGTERM')` becomes `expect(control.signalGroup).toHaveBeenCalledWith(4242, 'SIGHUP')`, and the sync `manager.kill(...)` assertions gain an `await vi.advanceTimersByTimeAsync(0)` first, because the snapshot is awaited before the signal. Rewrite `describe('kill')`'s first case as:

```ts
it('hangs the group up rather than terminating it', async () => {
  vi.useFakeTimers();
  manager.spawn(SPAWN, emit);

  manager.kill('hero-refresh');
  await vi.advanceTimersByTimeAsync(0);

  // SIGTERM is *ignored* by an interactive shell, so the old escalation always
  // reached SIGKILL — and a SIGKILLed shell cannot hang up its own jobs, which
  // is exactly how the orphan was left behind. SIGHUP is what a closing
  // terminal sends, and the shell answers it by HUPing every job it owns.
  expect(control.signalGroup).toHaveBeenCalledWith(4242, 'SIGHUP');
});
```

Then add the new cases:

```ts
describe('descendant teardown', () => {
  const JOB: Descendant = { pid: 5150, pgid: 5150 };

  it('reads the tree before it signals anything', async () => {
    vi.useFakeTimers();
    manager.spawn(SPAWN, emit);

    manager.kill('hero-refresh');
    await vi.advanceTimersByTimeAsync(0);

    /**
     * The ordering *is* the fix.
     *
     * Once the shell dies its children are reparented to launchd/init and the
     * linkage that identifies them is gone permanently. Snapshot first or do
     * not snapshot at all — and without this assertion a later refactor can
     * reintroduce the bug with every other test still green.
     */
    expect(signals[0]).toBe('descendants');
  });

  it('kills a descendant that outlived the hangup, by group then pid', async () => {
    vi.useFakeTimers();
    control.descendants.mockResolvedValue([JOB]);
    control.isAlive.mockReturnValue(true);
    manager.spawn(SPAWN, emit);

    const pending = manager.killAll();
    pty().emitExit(0);
    await vi.advanceTimersByTimeAsync(250);
    await pending;

    // The group first: it reaches whatever the job spawned after the snapshot.
    expect(signals).toContain('group 5150 SIGKILL');
    expect(signals).toContain('pid 5150 SIGKILL');
  });

  it('sweeps even when every shell exited promptly', async () => {
    vi.useFakeTimers();
    control.descendants.mockResolvedValue([JOB]);
    control.isAlive.mockReturnValue(true);
    manager.spawn(SPAWN, emit);

    const pending = manager.killAll();
    // The shell takes SIGHUP and goes immediately — the ordinary case, and the
    // one where resolving early would leave a hangup-proof descendant running.
    pty().emitExit(0);
    await vi.advanceTimersByTimeAsync(250);
    await pending;

    expect(signals).toContain('pid 5150 SIGKILL');
  });

  it('leaves a descendant that already died alone', async () => {
    vi.useFakeTimers();
    control.descendants.mockResolvedValue([JOB]);
    control.isAlive.mockReturnValue(false);
    manager.spawn(SPAWN, emit);

    const pending = manager.killAll();
    pty().emitExit(0);
    await vi.advanceTimersByTimeAsync(250);
    await pending;

    expect(signals).not.toContain('pid 5150 SIGKILL');
  });

  it('still kills the session group when the tree cannot be read', async () => {
    vi.useFakeTimers();
    control.descendants.mockResolvedValue([]);
    manager.spawn(SPAWN, emit);

    const pending = manager.killAll();
    await vi.advanceTimersByTimeAsync(2_250);
    await pending;

    // Degrading to the old behaviour is acceptable. Blocking quit is not.
    expect(control.signalGroup).toHaveBeenCalledWith(4242, 'SIGKILL');
  });

  it('reads no process table with nothing running', async () => {
    await manager.killAll();
    expect(control.descendants).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/electron/pty-host/session-manager.test.ts`
Expected: FAIL — `control` is not an accepted option, `signalGroup` never called.

- [ ] **Step 3: Rewrite the teardown path**

Replace the `killProcessGroup` helper (`:83-90`) and the `killGroup` option with the import and the new option:

```ts
import {
  processControl,
  type Descendant,
  type ProcessControl,
} from './process-tree';
```

In `SessionManagerOptions`, replace `killGroup`:

```ts
  /**
   * Signals and process-table access. Injected so no test signals a real
   * process or execs a real `ps`.
   */
  control?: ProcessControl;
```

Add beside `KILL_GRACE_MS`'s use:

```ts
/**
 * A moment for a job that took SIGHUP to finish going.
 *
 * A courtesy, not a correctness requirement — the sweep would be correct
 * without it, just quicker to SIGKILL something that was already leaving.
 * Kept small: the whole teardown has to fit inside `SHUTDOWN_TIMEOUT_MS`.
 */
const SWEEP_SETTLE_MS = 250;
```

Destructure `control = processControl` in place of `killGroup`. Replace the `signal` helper (`:123-131`) with:

```ts
/** Signal a group, tolerating a process that is already gone. */
function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    control.signalGroup(pgid, sig);
  } catch {
    // ESRCH — it died between the decision and the signal. Nothing to do,
    // and certainly nothing to fail the app over.
  }
}

/** Signal one process, same tolerance. */
function signalPid(pid: number, sig: NodeJS.Signals): void {
  try {
    control.signalPid(pid, sig);
  } catch {
    // As above.
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
```

Add the teardown, above the returned object:

```ts
/** Wait for every target to exit, SIGKILLing whatever outlasts the grace. */
function waitForExit(targets: readonly Session[]): Promise<void> {
  const allGone = () => targets.every((session) => session.status !== 'live');

  return new Promise<void>((resolve) => {
    if (allGone()) {
      resolve();
      return;
    }

    const finish = () => {
      clearTimeout(timer);
      exitWatchers.delete(watcher);
      resolve();
    };

    const timer = setTimeout(() => {
      // Grace expired. Anything still alive gets SIGKILL, and the app stops
      // waiting on it — "the app would not quit" is worse than "one teardown
      // step was abrupt".
      for (const session of targets) {
        if (session.status === 'live') signalGroup(session.pid, 'SIGKILL');
      }
      finish();
    }, killGraceMs);

    const watcher = () => {
      if (allGone()) finish();
    };

    exitWatchers.add(watcher);
  });
}

/**
 * Kill anything from the snapshot that is still running.
 *
 * Unconditional, and that is the point. The tempting shortcut — stop once the
 * shells have exited — is exactly the leak: a shell takes SIGHUP and goes
 * promptly while a descendant that ignores hangup carries on.
 */
async function sweep(snapshot: readonly Descendant[]): Promise<void> {
  if (snapshot.length === 0) return;

  await delay(SWEEP_SETTLE_MS);

  const survivors = snapshot.filter(({ pid }) => control.isAlive(pid));
  if (survivors.length === 0) return;

  // The group first — it reaches children the job spawned after the snapshot
  // was taken, which by definition are not in it.
  for (const pgid of new Set(survivors.map((d) => d.pgid))) {
    signalGroup(pgid, 'SIGKILL');
  }

  for (const { pid } of survivors) {
    if (control.isAlive(pid)) signalPid(pid, 'SIGKILL');
  }
}

/** The one teardown both `kill` and `killAll` run. */
async function teardown(
  targets: readonly Session[],
  sig: NodeJS.Signals,
): Promise<void> {
  if (targets.length === 0) return;

  /**
   * Before any signal, without exception.
   *
   * Once a shell dies its children are reparented to launchd/init and the
   * `ppid` linkage that identifies them is gone for good. There is no reading
   * the tree afterwards.
   */
  const snapshot = await control.descendants(targets.map((s) => s.pid));

  for (const session of targets) signalGroup(session.pid, sig);

  await waitForExit(targets);
  await sweep(snapshot);
}
```

Replace `kill` (`:312-326`) with:

```ts
    kill(sessionId, sig = 'SIGHUP') {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'live') return;

      /**
       * Closing one session leaks its background jobs by exactly the mechanism
       * app-quit does, so it runs the same teardown. Fire-and-forget because
       * `SessionOperations.kill` is synchronous; every signal inside tolerates
       * a process that is already gone.
       */
      void teardown([session], sig as NodeJS.Signals);
    },
```

Replace `killAll` (`:345-386`) with:

```ts
    async killAll() {
      await teardown(
        [...sessions.values()].filter((session) => session.status === 'live'),
        'SIGHUP',
      );
    },
```

Delete `clearKillTimer`, the `killTimer` field on `Session`, its initialiser, and its call in `handleExit` — escalation now lives in `waitForExit`, so the timer has no remaining owner.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/electron/pty-host/`
Expected: PASS.

- [ ] **Step 5: Full static check**

Run: `pnpm type-check && pnpm exec eslint electron/pty-host tests/electron/pty-host && pnpm verify:boundaries`
Expected: clean, 29/29 boundaries.

- [ ] **Step 6: Commit**

```bash
git add electron/pty-host/session-manager.ts tests/electron/pty-host/session-manager.test.ts
git commit -m "fix(pty): hang the session up, then reap what survived (HIVE-72)"
```

---

### Task 3: Prove it end to end, and stop the `afterAll` deciding other tests

**Files:**
- Modify: `tests/e2e/electron/session-lifecycle.spec.ts` (test at :374-417, `afterAll` at :556-563)

**Interfaces:**
- Consumes: nothing from earlier tasks — this drives the built app.
- Produces: nothing.

- [ ] **Step 1: Scope the cleanup to pids this worker started**

Replace the `afterAll` (`:556-563`) and add the registry beside `isAlive` (`:364-372`):

```ts
/**
 * Descendant pids this worker started, so cleanup can never reach another's.
 *
 * The previous `pkill -f 'sleep 300'` matched by pattern across the whole
 * machine. With `fullyParallel`, a sibling worker's `afterAll` could therefore
 * kill the descendant *for* the app while this test was mid-poll and flip a
 * genuine failure green — which is exactly what hid HIVE-72. Observed
 * directly: the test passed at 22.9s, byte-identical to the sibling's.
 */
const strays: number[] = [];

test.afterAll(() => {
  for (const pid of strays) {
    // The group first: the recorded pid leads the job's own group, so this
    // reaps the `sleep` it started too.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone, which is the expected outcome.
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // As above.
    }
  }
});
```

Remove the now-unused `execFileSync` import if nothing else in the file uses it.

- [ ] **Step 2: Record the pid, and add the hangup-proof case**

In the existing test, after `const descendant = Number(read(pidFile));` add `strays.push(descendant);`.

Then add, after it:

```ts
test('quitting the app kills a descendant that ignores hangup', async ({}, testInfo) => {
  /**
   * The other half of HIVE-72.
   *
   * SIGHUP alone reaps an ordinary `&` job, because the shell hangs up the
   * jobs it owns. It does nothing to one that ignores hangup — and a
   * long-running agent is exactly the process that might. Measured before the
   * fix: this shape leaked where the plain one did not.
   */
  const configPath = testInfo.outputPath('hive-config.json');
  const stub = testInfo.outputPath('claude-stub.sh');
  const pidFile = testInfo.outputPath('pid.txt');
  writeStubCommand(stub, testInfo.outputPath('ran-in.txt'));
  writeConfig(configPath, { claudeCommand: stub });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  const page = await app.firstWindow();
  await openSession(page);
  await expectFile(testInfo.outputPath('ran-in.txt'), REAL_DIRECTORY);

  await page.evaluate(
    ([sessionId, path]) => {
      window.hive!.pty.write({
        sessionId: sessionId!,
        data: `sh -c 'trap "" HUP; echo $$ > "${path}"; sleep 300' &\n`,
      });
    },
    [SESSION, pidFile],
  );
  await expect.poll(() => read(pidFile), { timeout: 20_000 }).not.toBeNull();

  const descendant = Number(read(pidFile));
  strays.push(descendant);
  expect(isAlive(descendant)).toBe(true);

  await app.close();

  await expect.poll(() => isAlive(descendant), { timeout: 20_000 }).toBe(false);
});
```

- [ ] **Step 3: Run both serialized — the acceptance criterion**

Run: `PW_ELECTRON_ONLY=1 pnpm exec playwright test --project=electron --workers=1 -g "descendant" --reporter=list`
Expected: 2 passed. Serialized matters: it removes the cross-worker `pkill` that used to decide the outcome.

- [ ] **Step 4: Run the whole electron suite, parallel, for regressions**

Run: `PW_ELECTRON_ONLY=1 pnpm exec playwright test --project=electron`
Expected: all pass. `kill()`'s default signal changed, so the session-close specs are the ones to watch.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/electron/session-lifecycle.spec.ts
git commit -m "test(pty): prove the descendant dies, and stop the afterAll deciding it (HIVE-72)"
```

---

## Self-review

**Spec coverage.** Snapshot-before-signal → Task 2 Step 3 `teardown`, asserted Task 2 Step 1 (`signals[0] === 'descendants'`). SIGHUP over SIGTERM → Task 2. Unconditional sweep by pgid then pid → Task 2 `sweep`. `PS_TIMEOUT_MS`, cycle safety, win32, empty-on-failure → Task 1. `kill()` included → Task 2 Step 3. Unique per-worker cleanup → Task 3 Step 1. Both e2e shapes and the serialized run → Task 3 Steps 2-3.

**Type consistency.** `ProcessControl` has the same four members in Task 1's implementation, Task 2's mock, and Task 2's import. `Descendant` is `{ pid, pgid }` throughout. `SWEEP_SETTLE_MS` is 250 in the constant, in both timer advances, and in the constraint budget.

**Known gap.** Task 2's `sweep` runs after `waitForExit`, so a descendant spawned *after* the snapshot but before the shell dies is missed. Accepted: closing that needs a second `ps` while the shell is still alive, which the 700ms budget margin does not comfortably fund. The group kill in `sweep` covers the common case (a job forking its own children), which is the shape that actually occurs.

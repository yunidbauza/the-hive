// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONFIG_PATH_ENV } from '../../../../electron/shared/config-contract';
import type { AgentState } from '../../../../electron/main/agents/state';

/**
 * What a live mode switch must **not** throw away (HIVE-144, fix round 1).
 *
 * `switchIpcMode` reaches `resetIpcHandlers`, which finalises every headless
 * run in flight (`runs.closeAll('reset')`) and, until this round, then
 * *cancelled* the `agents.json` write that finalisation had just scheduled.
 * What went with it was not cosmetic: the closed run's summary, its
 * `runsSinceRotate`, its `nextRunAt` — and its `sessionUuid`, which is the
 * handle the next wake `--resume`s the conversation from
 * (`electron/main/agents/runs.ts`). A user who attached, detached, or merely
 * suffered a failed attach while an agent was mid-run lost that agent's
 * continuity with no error anywhere.
 *
 * ## What is real here and what stands in
 *
 * Real: `createAgentState`, its 400 ms debounce, `agentStateFile()`, the
 * config module, `registerIpcHandlers`, `switchIpcMode` and the whole
 * unbind/rebind sequence. The file is read back off a real disk under a temp
 * `HIVE_CONFIG_PATH`.
 *
 * Stood in for: the run tracker. `finalizeRun` writing a `sessionUuid` needs a
 * real `claude` child and its `'close'` event, which is `pnpm test:agent`'s
 * job. What this fixture keeps is the *seam that matters* — a `closeAll` that
 * writes into the very `AgentState` the composition built, from inside the
 * teardown, exactly where the real one does. That is what makes the ordering
 * assertion below meaningful: a flush placed before `closeAll` writes a file
 * that does not contain the uuid, and this test can tell the difference.
 */
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    on: vi.fn(),
    removeListener: vi.fn(),
    // Per-spec, never shared: vitest runs spec files in parallel worker
    // processes and these registrations really write here (HIVE-139).
    getPath: () => '/tmp/hive-test-mode-switch-durability',
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
    on: vi.fn(),
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
    removeAllListeners: vi.fn(),
  },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
}));

vi.mock('../../../../electron/main/pty-host', () => ({
  registerPtyHost: () => ({
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    onData: () => () => {},
    onExit: () => () => {},
    onSpawned: () => () => {},
    onError: () => () => {},
    onSessionLost: () => () => {},
    shutdown: async () => {},
    isRunning: () => true,
    isBlocked: () => false,
    sessionIds: () => [],
  }),
}));

vi.mock('../../../../electron/main/shutdown', () => ({ onShutdown: vi.fn() }));

/** Inert, for `remote-composition.test.ts`'s reason: a real tick would land
 * behind the unawaited `mcp.start()`, after this file's teardown. */
vi.mock('../../../../electron/main/agents/scheduler', () => ({
  createScheduler: () => ({
    onEntry: () => {},
    onRunClosed: () => {},
    onResume: () => {},
    onEvent: () => {},
    manualWake: () => ({ ok: false, status: 'stopped' }),
    start: () => {},
    stop: () => {},
  }),
}));

/**
 * An inert agents registry, for the reason `remote-channels.test.ts` states at
 * length (HIVE-144, fix round 2): `refreshKnownAgents()`'s unawaited
 * `agents.list()` opens with `mkdir(agentsRoot(), { recursive: true })`, and
 * `agentsRoot()` is under `dirname(configPath())` — this file's temp root,
 * which it removes after every case. A pending `mkdir` landing between
 * `rmSync`'s walk and its `rmdir` is an `ENOTEMPTY` that no retry reliably
 * outruns. Every fixture that points `HIVE_CONFIG_PATH` at a directory it
 * deletes needs this; the ones that mock `configPath` to a path they never
 * remove do not.
 */
vi.mock('../../../../electron/main/agents', () => ({
  createAgentsRuntime: () => ({
    list: async () => ({ agents: [], agentsRoot: '/tmp/hive-test-mode-switch-durability/agents' }),
    read: async () => null,
    write: async () => ({ ok: false, problems: [] }),
    remove: async () => {},
    rename: async () => ({ ok: false, problems: [] }),
    onChange: () => () => {},
    close: () => {},
  }),
}));

/**
 * The run tracker, standing in only for the spawn.
 *
 * `closeAll` does what the real `finalizeRun` does at the one point this test
 * is about: it writes the closed run's `sessionUuid` into the `AgentState` the
 * composition handed it, synchronously, from inside `resetIpcHandlers`. Every
 * other member is inert — nothing here exercises a run.
 */
let capturedState: AgentState | null = null;
const MID_RUN_UUID = 'a1b2c3d4-0000-4000-8000-000000000001';

vi.mock('../../../../electron/main/agents/runs', () => ({
  createRunTracker: (deps: { state: AgentState }) => {
    capturedState = deps.state;
    return {
      run: () => ({ started: false, refused: 'unknown', reason: 'inert' }),
      kill: () => false,
      noteTurnEnded: () => {},
      killAll: () => {},
      closeAll: () => {
        deps.state.patch('probe', { sessionUuid: MID_RUN_UUID, status: 'sleeping' });
      },
      live: () => [],
      liveRuns: () => [],
    };
  },
}));

const { resetIpcHandlers } = await import('../../../../electron/main/ipc');
const { registerIpc, switchIpcMode } = await import('../../../../electron/main/ipc/router');

/** A `RemoteClient` fake — nothing here sends a frame. */
const fakeClient = () => ({
  call: vi.fn(async () => undefined),
  notify: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  snapshot: vi.fn(() => ({})),
  serverName: vi.fn(() => 'mini'),
  close: vi.fn(),
});

const opts = () => ({
  target: { host: '127.0.0.1', port: 7433 },
  credential: { deviceId: 'device-1', token: 'secret' },
  connect: async () => fakeClient(),
});

const originalConfigPath = process.env[CONFIG_PATH_ENV];
let dir: string;

/** `~/.hive/ledger/agents.json`, under this case's own temp root. */
const stateFile = (): string => join(dir, 'ledger', 'agents.json');

const storedUuid = (): string | undefined => {
  if (!existsSync(stateFile())) return undefined;
  const parsed = JSON.parse(readFileSync(stateFile(), 'utf8')) as Record<
    string,
    { sessionUuid?: string }
  >;
  return parsed.probe?.sessionUuid;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-mode-switch-'));
  process.env[CONFIG_PATH_ENV] = join(dir, 'config.json');
  writeFileSync(join(dir, 'config.json'), '{\n  "version": 2,\n  "projects": []\n}\n');
  handlers.clear();
  capturedState = null;
  vi.clearAllMocks();
});

afterEach(() => {
  resetIpcHandlers();
  rmSync(dir, { recursive: true, force: true });
  if (originalConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
  else process.env[CONFIG_PATH_ENV] = originalConfigPath;
});

describe('a live mode switch and the writes it must not drop (HIVE-144)', () => {
  it('preserves a mid-run sessionUuid across a switch out and back', () => {
    registerIpc('local');
    expect(capturedState, 'the run tracker was never composed').not.toBeNull();
    // Nothing on disk yet: the write `closeAll` will schedule is inside the
    // 400 ms debounce, which is exactly the window a switch falls into.
    expect(storedUuid()).toBeUndefined();

    return switchIpcMode('remote', opts())
      .then((out) => {
        expect(out).toEqual({ ok: true });
        /*
          The whole finding. `closeAll` ran inside the teardown and wrote the
          uuid into the state; the flush is what got it to disk before the
          state was disposed. Without it the debounce is cancelled and this is
          `undefined` — the next wake starts a fresh conversation instead of
          `--resume`-ing, silently.
        */
        expect(existsSync(stateFile()), 'the flush never ran at all').toBe(true);
        /*
          Two failures, told apart. A missing file means the flush was dropped;
          a file that exists without the uuid means the flush ran *before*
          `runs.closeAll`, writing the state as it was a moment before the run
          was finalised — the same loss, with a file to make it look handled.
        */
        expect(storedUuid()).toBe(MID_RUN_UUID);
        return switchIpcMode('local', opts());
      })
      .then((out) => {
        expect(out).toEqual({ ok: true });
        // And back, through the other direction of the same switch: the
        // rebound registration read the file at construction and the second
        // teardown wrote it again.
        expect(storedUuid()).toBe(MID_RUN_UUID);
      });
  });

  it('preserves it when the attach fails and local is rebound', async () => {
    registerIpc('local');

    const outcome = await switchIpcMode('remote', {
      ...opts(),
      connect: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'connect-failed' });
    /*
      A restored surface is not the same as a free failure. The unbind runs
      before the dial, so a connect failure has already finalised every run in
      flight — the switch costs that whether or not it succeeds, and the flush
      is what keeps the cost to "the runs ended" rather than "the runs ended
      and nobody wrote it down".
    */
    expect(storedUuid()).toBe(MID_RUN_UUID);
  });

  /**
   * The default is still drop, and it has to be: eight suites call
   * `registerIpcHandlers` directly, their paths point at whatever `configPath`
   * and `app.getPath` were stubbed to, and a teardown that wrote there is how
   * a unit test comes to leave a file behind. Only `unbindEverything` opts in.
   */
  it('still writes nothing when a plain teardown drops', () => {
    registerIpc('local');

    resetIpcHandlers();

    expect(existsSync(stateFile())).toBe(false);
  });
});

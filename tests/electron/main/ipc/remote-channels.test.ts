// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONFIG_PATH_ENV,
  DEFAULT_REMOTE,
  type SwitchOutcome,
} from '../../../../electron/shared/config-contract';

/**
 * `config:set-remote`, the one settings verb that also *acts* (HIVE-144).
 *
 * Ruling 19 is the whole subject: **validate, then switch, then write only on
 * success**. Writing first and being refused would leave `config.json` saying
 * `remote` while this process is bound local, and the next launch would attach
 * to a server the user was just told it could not attach to.
 *
 * The config module is **not** mocked here — unlike `config-channels.test.ts`,
 * and deliberately. What is under test is whether a refusal reaches the disk,
 * and a mocked writer can only answer whether a function was called. This file
 * points `CONFIG_PATH_ENV` at a real temp file and reads it back, the same way
 * `tests/electron/main/config/remote.test.ts` proves `setRemote` itself.
 *
 * The switch, by contrast, *is* injected. `registerIpcHandlers` takes it as an
 * argument (see `ModeSwitcher`) rather than importing it, because `ipc/router
 * .ts` already imports `ipc/index.ts` and the reverse edge would be a cycle —
 * so handing a fake in here is the production seam, not a hole cut for a test.
 * What the real switch does with a mode and a target is
 * `remote-composition.test.ts`'s subject.
 */
const handlers = new Map<
  string,
  (event: unknown, payload: unknown) => unknown
>();

const shutdownHooks: (() => void)[] = [];

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    on: vi.fn(),
    removeListener: vi.fn(),
    // Per-spec, never shared: vitest runs spec files in parallel worker
    // processes and these registrations really write container sets (HIVE-139).
    getPath: () => '/tmp/hive-test-remote-channels',
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  /** Reports unavailable, which is the state that stores no credential. */
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, payload: unknown) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
    on: vi.fn(),
    removeHandler: vi.fn(),
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

vi.mock('../../../../electron/main/shutdown', () => ({
  onShutdown: (hook: () => void) => shutdownHooks.push(hook),
}));

/**
 * A fully inert scheduler — ported from `remote-composition.test.ts`, and this
 * file needs it more than that one does (HIVE-144, fix round 1).
 *
 * The real scheduler is a live `setInterval` plus an immediate
 * `tickSchedules()` at `start()`, and `start()` fires behind the real,
 * unmocked `mcp.start()`'s file write — a promise this fixture does not
 * control the timing of and nothing here awaits.
 */
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
 * An inert agents registry — **the fix for this file's `ENOTEMPTY`**, and the
 * writer is now named rather than guessed (HIVE-144, fix round 2).
 *
 * ## What was actually happening
 *
 * `registerIpcHandlers` calls `refreshKnownAgents()` (`ipc/index.ts:2115`),
 * which is `void agents?.list()` — dispatched and never awaited, deliberately,
 * because boot must not wait on a folder scan. `AgentRegistry.list()` opens
 * with `await mkdir(root, { recursive: true })` (`agents/registry.ts:302`),
 * where `root` is `agentsRoot()` = `dirname(configPath()) + '/agents'` — it
 * creates the folder it is about to read, on purpose, so `fs.watch` has
 * something to attach to on a fresh install.
 *
 * This file points `configPath()` at a temp directory and removes that
 * directory after every case. So the two meet: `rmSync` walks the tree and
 * deletes it, the pending `mkdir` lands, and the final `rmdir` finds a folder
 * that was not there a moment ago. Captured on the third of ten instrumented
 * batch runs, and the capture is unambiguous — at teardown the tree was
 * `["config.json"]` (the mkdir had **not** landed yet), the removal failed
 * `ENOTEMPTY`, and immediately afterwards the tree was `["agents"]`, an empty
 * directory created during the removal. `mkdir(…, { recursive: true })`
 * recreates the temp root along with it, which is why a retry can lose again.
 *
 * ## Why the fix is here and not in `registry.ts`
 *
 * Nothing about that behaviour is wrong. Creating the folder it names is what
 * the registry is supposed to do, nothing in production deletes it, and a boot
 * that awaited the scan would be a slower boot for no gain. **This is a
 * test-hygiene problem, not a product defect**: a fixture that deletes a
 * directory a live runtime is entitled to recreate. Removing the writer is the
 * fix, exactly as it was for the scheduler above.
 *
 * Inert rather than partial: this file's subject is `config:set-remote`, which
 * touches no agent. `remote-composition.test.ts` needs no such mock because it
 * mocks `configPath` to a fixed path it never removes.
 */
vi.mock('../../../../electron/main/agents', () => ({
  createAgentsRuntime: () => ({
    list: async () => ({ agents: [], agentsRoot: '/tmp/hive-test-remote-channels/agents' }),
    read: async () => null,
    write: async () => ({ ok: false, problems: [] }),
    remove: async () => {},
    rename: async () => ({ ok: false, problems: [] }),
    onChange: () => () => {},
    close: () => {},
  }),
}));

const { CH } = await import('../../../../electron/shared/ipc-contract');
const { reloadConfig } = await import('../../../../electron/main/config');
const { registerIpcHandlers, resetIpcHandlers } = await import(
  '../../../../electron/main/ipc'
);

/**
 * `assertSender` compares `senderFrame` to `sender.mainFrame` by identity, so
 * a trusted event has to share one object rather than two equal literals.
 */
const mainFrame = { url: 'file:///out/renderer/index.html' };
const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } };

const setRemoteVerb = (payload: unknown): Promise<unknown> => {
  const handler = handlers.get(CH.configSetRemote);
  if (handler === undefined) throw new Error('config:set-remote is not bound');
  return Promise.resolve(handler(trustedEvent, payload));
};

const originalConfigPath = process.env[CONFIG_PATH_ENV];
let dir: string;
let path: string;

/** What is actually on disk, right now. `null` when there is no file yet. */
const onDisk = (): Record<string, unknown> | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null;

/**
 * The injected switch. Each case sets {@link outcome}; every call is recorded,
 * along with **what was on disk at the moment it ran** — which is how the
 * ordering is proved rather than inferred.
 */
let outcome: SwitchOutcome = { ok: true };
let calls: { mode: string; target: unknown; diskAtCall: Record<string, unknown> | null }[] = [];

const switchMode = vi.fn(
  (mode: 'local' | 'remote', options?: { target?: { host: string; port: number } }) => {
    calls.push({ mode, target: options?.target, diskAtCall: onDisk() });
    return Promise.resolve(outcome);
  },
);

const seed = (text: string): void => {
  writeFileSync(path, text);
  reloadConfig();
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-remote-channels-'));
  path = join(dir, 'config.json');
  process.env[CONFIG_PATH_ENV] = path;
  handlers.clear();
  shutdownHooks.length = 0;
  calls = [];
  outcome = { ok: true };
  vi.clearAllMocks();
  seed('{\n  "version": 2,\n  "projects": []\n}\n');
  registerIpcHandlers(undefined, switchMode);
});

afterEach(() => {
  resetIpcHandlers();
  /*
    No retries, because the writer is gone rather than outrun — see the agents
    registry mock above for what it was and how it was caught (HIVE-144, fix
    round 2).

    Two earlier attempts retried instead, and both were wrong in a way worth
    recording. `maxRetries` **does not** cost `retryDelay × maxRetries`: Node
    backs off linearly, so the wall-clock bound goes as `retryDelay × n × (n+1)`
    — measured on this machine as 1587 ms at n=5, 5693 ms at n=10 and 47050 ms
    at n=30, against the 1.5 s the comment here used to claim. A retry loop is
    therefore both far more expensive than it reads and, against a writer that
    keeps recreating the directory, still able to lose after tens of seconds.
    Name the writer; do not outwait it.
  */
  rmSync(dir, { recursive: true, force: true });
  if (originalConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
  else process.env[CONFIG_PATH_ENV] = originalConfigPath;
});

describe('config:set-remote (HIVE-144, Ruling 19)', () => {
  it('switches before it writes', async () => {
    await setRemoteVerb({ mode: 'remote', host: '100.64.0.1' });

    /*
      The whole ruling, read off the disk rather than off a call order. At the
      instant the switch ran, the file still had no `remote` key at all — so an
      implementation that wrote first and switched second fails here even
      though its switch succeeded and its final file is identical.
    */
    expect(calls).toHaveLength(1);
    expect(calls[0].diskAtCall).not.toHaveProperty('remote');
    expect(onDisk()).toHaveProperty('remote', { mode: 'remote', host: '100.64.0.1' });
  });

  it('leaves the file untouched when the switch is refused', async () => {
    outcome = { ok: false, reason: 'live-sessions', sessions: ['hero-refresh'] };

    const result = await setRemoteVerb({ mode: 'remote', host: '100.64.0.1' });

    // Untouched, not reverted: there is no window in which disk and runtime
    // disagree, because the write never happened.
    expect(onDisk()).not.toHaveProperty('remote');
    expect(result).toMatchObject({
      switched: { ok: false, reason: 'live-sessions', sessions: ['hero-refresh'] },
    });
    // The snapshot handed back is the old one, so a pane re-rendering from it
    // shows the mode the app is actually in.
    expect((result as { config: { remote: unknown } }).config.remote).toEqual(DEFAULT_REMOTE);
  });

  it('leaves the file untouched when the target is refused as plaintext', async () => {
    outcome = { ok: false, reason: 'plaintext-refused' };

    const result = await setRemoteVerb({ mode: 'remote', host: '203.0.113.7' });

    expect(onDisk()).not.toHaveProperty('remote');
    expect(result).toMatchObject({ switched: { ok: false, reason: 'plaintext-refused' } });
  });

  it('leaves the file untouched when the connection fails', async () => {
    outcome = { ok: false, reason: 'connect-failed', message: 'ECONNREFUSED' };

    await setRemoteVerb({ mode: 'remote', host: '100.64.0.1' });

    expect(onDisk()).not.toHaveProperty('remote');
  });

  /**
   * `host` and `port` are optional and merged into the stored block, so the
   * switch has to be told the *effective* target rather than whatever subset
   * this one call carried — and it cannot read it from the file, because
   * Ruling 19 forbids the file from carrying it yet.
   */
  it('hands the switch the merged target, not the payload', async () => {
    seed('{\n  "version": 2,\n  "remote": { "mode": "remote", "host": "100.64.0.1" }\n}\n');
    resetIpcHandlers();
    handlers.clear();
    registerIpcHandlers(undefined, switchMode);
    calls = [];

    await setRemoteVerb({ mode: 'remote', port: 9001 });

    expect(calls[0]).toMatchObject({
      mode: 'remote',
      target: { host: '100.64.0.1', port: 9001 },
    });
  });

  /**
   * The blur, end to end (HIVE-144 review, I6).
   *
   * `mode` is **not** merged the way `host` and `port` are, and this is the
   * file that shows why it must not be: the stored block here says `'remote'`,
   * which is the state Ruling 19 leaves after a failed boot attach — and the
   * settings pane's address and port fields commit on blur with no `mode` at
   * all. Merged, that blur dialled: local IPC unbound, a socket opened, the
   * outcome `void`ed so no refusal was ever rendered, and on success the window
   * attached because a field lost focus.
   *
   * The address still reaches disk, which is the whole purpose of the commit.
   */
  it('writes a bare address commit without asking the switch for anything', async () => {
    seed('{\n  "version": 2,\n  "remote": { "mode": "remote", "host": "100.64.0.1" }\n}\n');
    resetIpcHandlers();
    handlers.clear();
    registerIpcHandlers(undefined, switchMode);
    calls = [];

    await setRemoteVerb({ host: '100.64.0.9' });

    expect(calls).toHaveLength(0);
    expect(onDisk()).toHaveProperty('remote', { mode: 'remote', host: '100.64.0.9' });
  });

  it('switching back to local writes the mode and nothing else', async () => {
    seed('{\n  "version": 2,\n  "remote": { "mode": "remote", "host": "100.64.0.1" }\n}\n');
    resetIpcHandlers();
    handlers.clear();
    registerIpcHandlers(undefined, switchMode);
    calls = [];

    await setRemoteVerb({ mode: 'local' });

    expect(calls[0]).toMatchObject({ mode: 'local' });
    // The address survives the round trip: a user who detaches and re-attaches
    // should not have to type it again.
    expect(onDisk()).toHaveProperty('remote', { mode: 'local', host: '100.64.0.1' });
  });

  it('refuses a malformed payload before the switch is asked anything', async () => {
    await expect(setRemoteVerb({ mode: 'both' })).rejects.toThrow(/setRemote\.mode/);

    expect(switchMode).not.toHaveBeenCalled();
    expect(onDisk()).not.toHaveProperty('remote');
  });

  /**
   * The default {@link ModeSwitcher} (HIVE-144, fix round 1).
   *
   * `registerIpc` always hands the real switch down, so production cannot land
   * here — but the default has to be a loud failure rather than a quiet
   * `{ ok: true }`, or a registration that forgot the argument would let this
   * verb write `mode: "remote"` to disk over a switch that never happened.
   * That is the exact state Ruling 19 exists to make impossible, arriving
   * through the wiring rather than through the ordering, and until this case
   * nothing asserted it: every other case in this file injects a switcher.
   */
  it('refuses, and writes nothing, when no mode switcher was wired', async () => {
    resetIpcHandlers();
    handlers.clear();
    registerIpcHandlers();

    await expect(setRemoteVerb({ mode: 'remote', host: '100.64.0.1' })).rejects.toThrow(
      /no mode switcher/,
    );
    expect(onDisk()).not.toHaveProperty('remote');
  });

  it('rejects a sender that is not the main frame', async () => {
    const handler = handlers.get(CH.configSetRemote);

    await expect(
      Promise.resolve().then(() =>
        handler?.(
          { senderFrame: { url: 'https://evil.example/' }, sender: { mainFrame } },
          { mode: 'local' },
        ),
      ),
    ).rejects.toThrow();
    expect(switchMode).not.toHaveBeenCalled();
  });
});

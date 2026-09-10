// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SNAPSHOT_READ_BUDGET_MS } from '@remote-host/listener';
import type { CloseCause } from '../../../../electron/remote-client/socket';
import { emptySnapshot } from '../../../../electron/shared/config-contract';
import { OVERMIND } from '../../../../electron/shared/ledger-contract';
import type { Channel } from '../../../../electron/shared/ipc-contract';
import { SNAPSHOT_CHANNELS, WINDOW_BOUND, type ResumePoint } from '../../../../electron/shared/remote-contract';
import type { ResumeResult } from '../../../../electron/main/ipc/pty';
import type { AttachedSocket } from '../../../../electron/main/ipc/socket-broadcaster';

/**
 * The composition HIVE-143 exists for: the module-scope registry `handle` and
 * `on` record into, and the socket half of the fan-out.
 *
 * Mocked the way `ledger-channels.test.ts` and `notification-broadcast.test.ts`
 * mock this module, and for the same reason — `ipc/index.ts` reaches Electron,
 * the pty host and the config at module scope, so the fakes have to be
 * installed before the dynamic import below. Nothing about the wiring under
 * test is faked: the registry, the dispatch, the broadcasters and
 * `registerIpcHandlers` itself are all real.
 *
 * What this file is *not*: a test of dispatch policy (`remote-dispatch.test.ts`),
 * of the registry's own storage (`registry.test.ts`), or of the socket
 * broadcaster's frame shape (`socket-broadcaster.test.ts`). It asserts only
 * that the four are wired to each other, and in the right order.
 */

interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: { send: (channel: string, payload: unknown) => void };
}

/** Every `webContents.send` this registration made, in order. */
const windowSends: [string, unknown][] = [];

const windows: FakeWindow[] = [];

const fakeWindow = (): FakeWindow => ({
  isDestroyed: () => false,
  webContents: {
    send: (channel, payload) => {
      windowSends.push([channel, payload]);
    },
  },
});

/**
 * Channels the fake `ipcMain.handle` below currently considers bound, and the
 * handler each is bound to.
 *
 * A bare `vi.fn()` here would accept a second registration for the same
 * channel silently, which makes `expect(() => registerIpcHandlers()).not
 * .toThrow()` a placebo — real Electron's `ipcMain.handle` throws on exactly
 * that, and that throw is what HIVE-144's whole reversibility guarantee is
 * proven against. So `handle` tracks what it has bound and `removeHandler`
 * un-tracks it, mirroring the one behaviour that matters here.
 *
 * A `Map` rather than a `Set` since HIVE-144's mode switch: the function is
 * kept as well as the name, so a test can actually *call* a channel and find
 * it answering. Counting bindings proves the surface is whole; calling one
 * proves the thing counted is a live handler and not a bookkeeping entry.
 */
const handledChannels = new Map<
  string,
  (event: unknown, payload: unknown) => unknown
>();

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    on: vi.fn(),
    removeListener: vi.fn(),
    // Per-spec, never shared: vitest runs spec files in parallel worker
    // processes and these registrations really write container sets (HIVE-139).
    getPath: () => '/tmp/hive-test-remote-composition',
    dock: { bounce: vi.fn(), setBadge: vi.fn() },
  },
  /*
    HIVE-150. The reconnect loop asks to be told when this machine wakes, so a
    lid opening reattaches at once rather than waiting out the backoff step it
    was parked on. Modelled here because `router.ts` really reads it.
  */
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => windows },
  dialog: { showOpenDialog: vi.fn() },
  Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      // The exact refusal Electron's real `ipcMain.handle` makes — the throw
      // HIVE-144's re-registration test exists to survive.
      if (handledChannels.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      handledChannels.set(channel, fn);
    },
    on: vi.fn(),
    removeHandler: (channel: string) => {
      handledChannels.delete(channel);
    },
    removeAllListeners: vi.fn(),
  },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn() },
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
    onForeground: () => () => {},
    shutdown: async () => {},
    isRunning: () => true,
    isBlocked: () => false,
    sessionIds: () => [],
  }),
}));

vi.mock('../../../../electron/main/shutdown', () => ({ onShutdown: vi.fn() }));

/**
 * A fully inert scheduler (HIVE-144).
 *
 * The real one is a live `setInterval` plus an immediate `tickSchedules()` at
 * `start()`, and `start()` fires behind the real, unmocked `mcp.start()`'s
 * file write — a promise this fixture does not control the timing of. Before
 * this mock, that write resolving mid-test (or mid the *next* test, since
 * nothing here awaits it) let a real tick read the real ledger mock, landing
 * unpredictably inside whichever test happened to be running and throwing
 * through code with no `.catch()` of its own. Nothing in this file asserts on
 * scheduler behaviour — `tests/electron/main/agents/scheduler.test.ts` owns
 * that — so removing it here removes the race without losing coverage.
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

// The whole snapshot, so no getter reading a field this fixture forgot can
// throw into a swallowing catch (HIVE-139).
const snapshot = emptySnapshot('/tmp/config.json', '/bin/zsh');

vi.mock('../../../../electron/main/config/index', () => ({
  getConfig: vi.fn(() => snapshot),
  reloadConfig: vi.fn(() => snapshot),
  loadConfig: vi.fn(() => snapshot),
  addProject: vi.fn(() => snapshot),
  removeProject: vi.fn(() => snapshot),
  renameProject: vi.fn(() => snapshot),
  repointProject: vi.fn(() => snapshot),
  reorderProjects: vi.fn(() => snapshot),
  configPath: vi.fn(() => '/tmp/config.json'),
}));

/**
 * `ledger:changed` is the event this file pushes, and the ledger is faked only
 * so a test can raise one — `createLedger`'s own rules are
 * `tests/electron/main/ledger/index.test.ts`'s job.
 */
let onChangeListener: ((entry: unknown) => void) | undefined;

/**
 * What `ledger.read` answers next (HIVE-144).
 *
 * A function rather than a plain value, like `resumeAnswer` below, so a case
 * can make it throw — `ledger:list` is one of {@link SNAPSHOT_CHANNELS}, and
 * this is what stands in for "a real read genuinely fails" in the attach
 * snapshot's own suite. It used to also be reached by the real agent
 * scheduler this composition builds (`openAsksFor`/`entries`), racing this
 * override on an unpredictable schedule of its own — the `createScheduler`
 * mock below removes that reader entirely, which is what lets the attach
 * snapshot's throw case assign this unconditionally rather than fencing it.
 */
let ledgerReadImpl: () => unknown = () => ({
  entries: [],
  openAsks: [],
  claims: {},
});

vi.mock('../../../../electron/main/ledger', () => ({
  createLedger: () => ({
    read: () => ledgerReadImpl(),
    append: () => ({ ok: true, id: 'entry-1' }),
    answer: () => ({ ok: true, id: 'entry-2' }),
    onChange: (listener: (entry: unknown) => void) => {
      onChangeListener = listener;
      return () => {
        onChangeListener = undefined;
      };
    },
  }),
}));

/**
 * The `onAttach` the real composition built, captured by standing in for the
 * listener it is handed to.
 *
 * `registerIpcHandlers` constructs the listener and passes it the callback
 * under test, and nothing else exposes it. Faking the listener is therefore the
 * only way to reach the fan-out set and the replay loop without a real socket —
 * and it fakes only the transport: the callback, the set it adds to, and the
 * frames it builds are all the production ones.
 *
 * It is also the *only* way, deliberately (HIVE-143 review). There used to be an
 * `attachForTest` export that added a socket to the set directly; it was a
 * production export with a test-only comment, and push access to every attached
 * client's stream is not a thing to leave lying in a module the whole main
 * process imports. Every case below that needs an attached socket goes through
 * this door, which is the one production code uses too.
 */
type OnAttach = (socket: AttachedSocket, resumeFrom: Readonly<Record<string, ResumePoint>> | undefined) => void;
type OnDetach = (socket: AttachedSocket) => void;
let capturedOnAttach: OnAttach | null = null;
let capturedOnDetach: OnDetach | null = null;

/** The captured callback, or a failure naming why it is missing. */
const onAttach = (): OnAttach => {
  if (capturedOnAttach === null) {
    throw new Error('createRemoteListener was never handed an onAttach');
  }
  return capturedOnAttach;
};

/** Its pair, captured the same way (HIVE-145). */
const onDetach = (): OnDetach => {
  if (capturedOnDetach === null) {
    throw new Error('createRemoteListener was never handed an onDetach');
  }
  return capturedOnDetach;
};

/**
 * `buildAttachSnapshot`, captured the same door `onAttach` is (HIVE-144).
 *
 * The real function — this file fakes only the listener it is handed to, not
 * the builder itself, so calling this reaches `remoteRegistry`'s real
 * recorded handlers, wired to this file's own fakes for `config`, `ledger`,
 * `sessions` and the rest. That is the property these tests are for: whether
 * a joining client's snapshot is genuinely built from what `registerIpcHandlers`
 * wired up, not from a second, parallel description of it.
 */
type BuildSnapshot = () => Promise<Partial<Record<Channel, unknown>>>;
let capturedBuildSnapshot: BuildSnapshot | null = null;

/** The captured builder, or a failure naming why it is missing. */
const buildSnapshot = (): BuildSnapshot => {
  if (capturedBuildSnapshot === null) {
    throw new Error('createRemoteListener was never handed a buildSnapshot');
  }
  return capturedBuildSnapshot;
};

vi.mock('@remote-host/listener', async (importOriginal) => {
  // `...actual` is not test convenience — `electron/main/ipc/index.ts` imports
  // `SNAPSHOT_READ_BUDGET_MS` from this same module (HIVE-144 review, the
  // constant's move beside `ATTACH_HANDSHAKE_TIMEOUT_MS`), and a factory that
  // returned only `createRemoteListener` would silently hand it `undefined`
  // for the race's own timeout delay — no type error, no lint error, just a
  // `setTimeout` with `NaN` under it. Only the listener's *construction* is
  // faked here; its real, un-mocked constants pass straight through.
  const actual = await importOriginal<typeof import('@remote-host/listener')>();
  return {
    ...actual,
    createRemoteListener: (options: {
      onAttach: OnAttach;
      onDetach: OnDetach;
      buildSnapshot: BuildSnapshot;
    }) => {
      capturedOnAttach = options.onAttach;
      capturedOnDetach = options.onDetach;
      capturedBuildSnapshot = options.buildSnapshot;
      return {
        start: async () => {
          // Counted, not just stubbed (HIVE-144 review, I3). `startRemoteListener`
          // answers `null` both when the listener is there and when it has
          // been dropped, so the resolved value cannot tell the two apart —
          // this counter is what proves the object still exists to be started.
          listenerStarts += 1;
          return null;
        },
        stop: async () => {},
        get boundHost() {
          return null;
        },
        get lastBindError() {
          return null;
        },
      };
    },
  };
});

/**
 * What `sessions.resume` answers next, per entity id — the three-way branch
 * `onAttach` reads.
 *
 * A function rather than a value so a case can observe *when* it is called,
 * which is how the ordering assertion below is made: a push raised from inside
 * this fake is a push raised from inside the replay loop.
 */
let resumeAnswer: (entityId: string, from: ResumePoint) => ResumeResult | null = () => null;

/**
 * How many times the fake listener's `start()` has been called (HIVE-144
 * review, I3) — see the fake's own comment for why a counter and not the
 * resolved value.
 */
let listenerStarts = 0;

/**
 * What `sessions.generationFor` answers next, per entity id (HIVE-144).
 *
 * `onAttach`'s gap branch reads this to stamp its synthetic frame with the
 * entity's *live* generation, never the client's stale one — see
 * `ipc/index.ts`'s comment on that line. Defaulting to `1` rather than
 * `undefined` keeps the ordinary cases realistic (a session that has never
 * restarted); a case that cares about the distinction sets this explicitly.
 */
let generationAnswer: (entityId: string) => number | undefined = () => 1;

/**
 * The live entity ids this machine's own sessions layer reports (HIVE-144).
 *
 * `switchIpcMode`'s `live-sessions` refusal reads exactly this, through
 * `sessionsLayer()`, and it is the only refusal a user can clear themselves —
 * so a case that wants one sets this and gets the production path, not an
 * injected substitute for it.
 */
let entitiesAnswer: () => string[] = () => [];

vi.mock('../../../../electron/main/sessions', () => ({
  createSessions: () => ({
    open: vi.fn(),
    openCommand: vi.fn(),
    write: vi.fn(() => false),
    resize: vi.fn(),
    ack: vi.fn(),
    resume: (entityId: string, from: ResumePoint) => resumeAnswer(entityId, from),
    generationFor: (entityId: string) => generationAnswer(entityId),
    kill: vi.fn(),
    restart: vi.fn(async () => {}),
    entities: () => entitiesAnswer(),
    isIdle: () => false,
    observedCwd: () => undefined,
    containerRemoval: async () => {},
    diagnostics: () => [],
    dispose: vi.fn(),
  }),
}));

const { CH } = await import('../../../../electron/shared/ipc-contract');
const {
  ipcBindingsSize,
  registerIpcHandlers,
  remoteRegistrySize,
  resetIpcHandlers,
  sessionsLayer,
  startRemoteListener,
} = await import('../../../../electron/main/ipc');
const { remoteProxyBindingsSize, resetRemoteProxy } = await import(
  '../../../../electron/main/ipc/remote-proxy'
);
const { PlaintextRefusedError } = await import('../../../../electron/remote-client/socket');
const { BACKOFF_MS } = await import('../../../../electron/main/ipc/reattach');
const { attachedResumeTracker, attachedServerName, registerIpc, switchIpcMode } = await import(
  '../../../../electron/main/ipc/router'
);
const { resetServerModeForTest, setServerMode } = await import(
  '../../../../electron/main/server-mode'
);

/**
 * Read at import time, before any test body has run, so the composition-order
 * assertion below cannot be weakened by moving a case: at this point in the
 * file `registerIpcHandlers` has never been called and the registry has to be
 * empty. The listener is only ever `start()`-ed later, from
 * `electron/main/index.ts`, which is what makes "populated before a socket can
 * attach" true rather than lucky.
 */
const sizeBeforeRegistration = remoteRegistrySize();

const emitLedgerChanged = (entry: unknown): void => {
  if (onChangeListener === undefined) throw new Error('ledger.onChange was never wired');
  onChangeListener(entry);
};

beforeEach(() => {
  windowSends.length = 0;
  windows.length = 0;
  onChangeListener = undefined;
  capturedOnAttach = null;
  capturedOnDetach = null;
  capturedBuildSnapshot = null;
  resumeAnswer = () => null;
  generationAnswer = () => 1;
  ledgerReadImpl = () => ({ entries: [], openAsks: [], claims: {} });
  entitiesAnswer = () => [];
  listenerStarts = 0;
  resetServerModeForTest();
  vi.clearAllMocks();
  /*
    Both surfaces, both hooks (HIVE-144). `registerRemoteProxy` binds the same
    channel names `registerIpcHandlers` does, so a case that left the proxy
    registered would make the *next* case's registration hit the fake
    `ipcMain.handle`'s duplicate-handler throw — which is a real refusal, from
    the one behaviour this fixture models faithfully, arriving in the wrong test.
  */
  resetRemoteProxy();
  resetIpcHandlers();
});

afterEach(() => {
  resetRemoteProxy();
  resetIpcHandlers();
  resetServerModeForTest();
});

describe('remote composition (HIVE-143)', () => {
  it('records nothing before registerIpcHandlers runs', () => {
    expect(sizeBeforeRegistration).toBe(0);
  });

  it('records a handler for every call and notify channel', () => {
    registerIpcHandlers();

    /*
      99 call + 6 notify. HIVE-144 added `config:set-remote`, `remote:pair`
      and `remote:forget`, all three `call`, taking calls to 100; HIVE-146
      then removed two and added one, which is where the 99 comes from. The
      arithmetic in this note read 100 + 6 against an asserted 105 until
      HIVE-153 re-derived it — the literal was right and the note was stale,
      which is the wrong way round for a number three files pin.

      Asserted as the total so a channel added to the contract without a
      handler — or a `handle`/`on` call that stopped recording — fails here
      rather than at a socket. Adding a channel to `PROCESS_LOCAL` does not
      move it: a locally-answered channel is still bound, just not to a proxy.

      It does **not** catch a channel registered twice: `recordCall` and
      `recordNotify` are `Map.set`, so a second registration overwrites the
      first and leaves the count exactly where it was. That case is covered
      elsewhere, by the real `ipcMain.handle` refusing a second handler for a
      channel — not by this number.
    */
    expect(remoteRegistrySize()).toBe(105);
  });

  it('re-registers every channel after a reset without throwing (HIVE-144)', () => {
    registerIpcHandlers();
    resetIpcHandlers();

    // The throw this guards against is Electron's own
    // "Attempted to register a second handler for 'x'".
    expect(() => registerIpcHandlers()).not.toThrow();

    resetIpcHandlers();
  });

  it('empties the registry on reset, so a socket sees not-ready rather than a stale handler', () => {
    registerIpcHandlers();
    resetIpcHandlers();

    expect(remoteRegistrySize()).toBe(0);
  });

  it('sends an event to an attached socket as well as to every window', () => {
    windows.push(fakeWindow());
    registerIpcHandlers();
    const socket = { send: vi.fn() };
    // Attached the way production attaches — the real `onAttach`, with no
    // `resumeFrom`, so nothing is replayed and the only effect under test is
    // that the socket joined the fan-out.
    onAttach()(socket, undefined);

    emitLedgerChanged({ id: 'e1' });

    expect(socket.send).toHaveBeenCalledWith({
      kind: 'event',
      channel: CH.ledgerChanged,
      payload: { id: 'e1' },
    });
    expect(windowSends).toContainEqual([CH.ledgerChanged, { id: 'e1' }]);
  });

  it('drops a detached socket, and keeps delivering to the windows', () => {
    windows.push(fakeWindow());
    registerIpcHandlers();
    const socket = { send: vi.fn() };
    onAttach()(socket, undefined);

    resetIpcHandlers();
    registerIpcHandlers();
    emitLedgerChanged({ id: 'e2' });

    // The set is cleared with the registry, or one suite's socket receives the
    // next suite's events.
    expect(socket.send).not.toHaveBeenCalled();
    expect(windowSends).toContainEqual([CH.ledgerChanged, { id: 'e2' }]);
  });
});

/**
 * The replay loop `onAttach` runs (HIVE-143 review).
 *
 * It is the most intricate new logic on the branch — the per-entry iteration,
 * the three-way `null`/`gap`/`replay` branch, the add-before-send ordering, and
 * the frame shape — and until this it was proved only by two live cases, which
 * need a built app and a real `claude` to run. Everything below is the real
 * callback: only the listener that carries it and the session layer it asks are
 * stood in for.
 */
describe('the attach replay loop (HIVE-143)', () => {
  /** A socket that records what it was sent, in order. */
  const recordingSocket = (): { socket: AttachedSocket; sent: unknown[] } => {
    const sent: unknown[] = [];
    return { socket: { send: (frame) => sent.push(frame) }, sent };
  };

  it('sends nothing at all when the client asked for no resume', () => {
    registerIpcHandlers();
    const { socket, sent } = recordingSocket();
    const resume = vi.fn(() => null);
    resumeAnswer = resume;

    onAttach()(socket, undefined);

    /*
      Not merely "no frames" — `resume` is never *asked*. An absent `resumeFrom`
      and an empty one are different questions (`AttachRequest.resumeFrom`), and
      a client with nothing on screen is the absent case.
    */
    expect(resume).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('skips a session the server has never heard of', () => {
    registerIpcHandlers();
    const { socket, sent } = recordingSocket();
    resumeAnswer = () => null;

    onAttach()(socket, { ghost: { gen: 1, seq: 12 } });

    // A client holding an id from a previous run, or from a session that has
    // since exited. Nothing to send; its own exit handling covers the rest.
    expect(sent).toEqual([]);
  });

  it('replays every event it was handed, in order, as pty:data', () => {
    registerIpcHandlers();
    const { socket, sent } = recordingSocket();
    resumeAnswer = (entityId) => ({
      kind: 'replay',
      events: [
        { sessionId: entityId, chunk: 'one', seq: 4, gen: 1 },
        { sessionId: entityId, chunk: 'two', seq: 5, gen: 1 },
      ],
    });

    onAttach()(socket, { 'hero-refresh': { gen: 1, seq: 3 } });

    expect(sent).toEqual([
      { kind: 'event', channel: CH.ptyData, payload: { sessionId: 'hero-refresh', chunk: 'one', seq: 4, gen: 1 } },
      { kind: 'event', channel: CH.ptyData, payload: { sessionId: 'hero-refresh', chunk: 'two', seq: 5, gen: 1 } },
    ]);
  });

  it('marks a gap with exactly one empty chunk at the head seq, stamped with the live generation (HIVE-144)', () => {
    registerIpcHandlers();
    const { socket, sent } = recordingSocket();
    resumeAnswer = () => ({ kind: 'gap', seq: 97 });
    // The client's own point names generation 1; the live one has moved to 2.
    // The frame below must carry the live one, never the client's.
    generationAnswer = () => 2;

    onAttach()(socket, { 'hero-refresh': { gen: 1, seq: 12 } });

    /*
      One frame, empty, stamped at where the stream actually is. The seq is not
      `lastSeq + 1`, which is what trips the client's discontinuity check
      (`src/lib/terminal/pty-transport.ts`) the moment it lands rather than
      whenever output next happens; the empty chunk is what makes that free —
      xterm writes nothing. `toEqual` on the whole array, so a second frame or a
      non-empty chunk fails here.
    */
    expect(sent).toEqual([
      { kind: 'event', channel: CH.ptyData, payload: { sessionId: 'hero-refresh', chunk: '', seq: 97, gen: 2 } },
    ]);
  });

  it('asks about every session in the map, and branches per session', () => {
    registerIpcHandlers();
    const { socket, sent } = recordingSocket();
    const asked: [string, ResumePoint][] = [];
    resumeAnswer = (entityId, from) => {
      asked.push([entityId, from]);
      if (entityId === 'gone') return null;
      if (entityId === 'stale') return { kind: 'gap', seq: 30 };
      return { kind: 'replay', events: [{ sessionId: entityId, chunk: 'x', seq: 2, gen: 1 }] };
    };

    onAttach()(socket, {
      gone: { gen: 1, seq: 1 },
      stale: { gen: 1, seq: 2 },
      live: { gen: 1, seq: 1 },
    });

    expect(asked).toEqual([
      ['gone', { gen: 1, seq: 1 }],
      ['stale', { gen: 1, seq: 2 }],
      ['live', { gen: 1, seq: 1 }],
    ]);
    expect(sent).toEqual([
      { kind: 'event', channel: CH.ptyData, payload: { sessionId: 'stale', chunk: '', seq: 30, gen: 1 } },
      { kind: 'event', channel: CH.ptyData, payload: { sessionId: 'live', chunk: 'x', seq: 2, gen: 1 } },
    ]);
  });

  /**
   * Two attached clients (HIVE-145).
   *
   * The fan-out has been N-way since HIVE-143, but nothing until now asserted
   * it with two sockets actually present — and the `Set<AttachedSocket>` it
   * read became a surface registry in this story, which is exactly the kind of
   * swap that can quietly deliver to one client and not the other.
   */
  const withLifetime = (): {
    socket: AttachedSocket;
    sent: unknown[];
    close: () => void;
  } => {
    const sent: unknown[] = [];
    const closers: (() => void)[] = [];
    const socket = {
      send: (frame: unknown) => sent.push(frame),
      on: (event: string, listener: () => void) => {
        if (event === 'destroyed') closers.push(listener);
        return undefined;
      },
    } as unknown as AttachedSocket;
    return {
      socket,
      sent,
      close: () => {
        for (const closer of closers) closer();
      },
    };
  };

  it('delivers one push to both attached clients', () => {
    registerIpcHandlers();
    const a = withLifetime();
    const b = withLifetime();

    onAttach()(a.socket, undefined);
    onAttach()(b.socket, undefined);
    emitLedgerChanged({ id: 'both' });

    const expected = { kind: 'event', channel: CH.ledgerChanged, payload: { id: 'both' } };
    expect(a.sent).toEqual([expected]);
    expect(b.sent).toEqual([expected]);
  });

  it('keeps delivering to the survivor when one client drops', () => {
    registerIpcHandlers();
    const a = withLifetime();
    const b = withLifetime();
    onAttach()(a.socket, undefined);
    onAttach()(b.socket, undefined);

    a.close();
    emitLedgerChanged({ id: 'after' });

    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([
      { kind: 'event', channel: CH.ledgerChanged, payload: { id: 'after' } },
    ]);
  });

  it('removes a socket through onDetach even with no lifetime of its own', () => {
    registerIpcHandlers();
    const { socket, sent } = recordingSocket();
    onAttach()(socket, undefined);

    onDetach()(socket);
    emitLedgerChanged({ id: 'gone' });

    expect(sent).toEqual([]);
  });

  it('is in the fan-out before it replays anything', () => {
    registerIpcHandlers();
    const { socket, sent } = recordingSocket();
    /*
      The push is raised from *inside* the replay loop, which is what makes this
      an ordering assertion rather than a membership one: if the socket were
      added after the loop, a `ledger:changed` landing mid-replay would find an
      empty set and be lost. It arrives, and it arrives *before* the replayed
      frame — the order a client's own seq assertion depends on, since a live
      batch delivered ahead of the frames it follows is worse than a gap.
    */
    resumeAnswer = (entityId) => {
      emitLedgerChanged({ id: 'mid-replay' });
      return { kind: 'replay', events: [{ sessionId: entityId, chunk: 'x', seq: 9, gen: 1 }] };
    };

    onAttach()(socket, { 'hero-refresh': { gen: 1, seq: 8 } });

    expect(sent).toEqual([
      { kind: 'event', channel: CH.ledgerChanged, payload: { id: 'mid-replay' } },
      { kind: 'event', channel: CH.ptyData, payload: { sessionId: 'hero-refresh', chunk: 'x', seq: 9, gen: 1 } },
    ]);
  });
});

/**
 * The attach snapshot (HIVE-144).
 *
 * `buildAttachSnapshot` is not re-implemented here: `buildSnapshot()` above
 * reaches the exact function `registerIpcHandlers` handed `createRemoteListener`,
 * closing over the real `remoteRegistry` and this file's own fakes for
 * `config`, `ledger`, `sessions` and the rest. What is under test is whether a
 * real registration actually answers every one of `SNAPSHOT_CHANNELS`, and
 * whether one broken read costs only its own key.
 */
describe('the attach snapshot (HIVE-144)', () => {
  it('answers an empty snapshot rather than throwing when no channel is registered yet', async () => {
    // `resetIpcHandlers` without a following `registerIpcHandlers`: every one
    // of the six is `null` in the registry. `raceSnapshotRead` does not
    // special-case that — it calls `null` as a function and lets the
    // resulting `TypeError` land in its own `.catch` — so this proves that
    // path resolves cleanly to "omitted" rather than rejecting the whole call
    // (HIVE-144 review, finding 3).
    registerIpcHandlers();
    resetIpcHandlers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const snapshot = await buildSnapshot()();

    expect(snapshot).toEqual({});
    expect(logged).toHaveBeenCalledTimes(SNAPSHOT_CHANNELS.length);
    logged.mockRestore();
  });

  it('carries every snapshot channel a real registry can answer', async () => {
    registerIpcHandlers();

    const snapshot = await buildSnapshot()();

    for (const channel of SNAPSHOT_CHANNELS) {
      expect(snapshot).toHaveProperty(channel);
    }
  });

  it('omits a channel whose read throws, without losing the others', async () => {
    registerIpcHandlers();

    const boom = new Error('the ledger file is corrupt');
    const read = vi.fn(() => {
      throw boom;
    });
    ledgerReadImpl = read;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const snapshot = await buildSnapshot()();

    /*
      Proves the read actually ran and failed, not that `ledger:list` was
      never asked for in the first place — a bare key count cannot tell those
      apart, and a fixture that only ever removed the key up front would pass
      this test for the wrong reason (HIVE-144 review).
    */
    expect(read).toHaveBeenCalledTimes(1);
    expect(snapshot).not.toHaveProperty(CH.ledgerList);
    expect(Object.keys(snapshot)).toHaveLength(SNAPSHOT_CHANNELS.length - 1);
    for (const channel of SNAPSHOT_CHANNELS) {
      if (channel === CH.ledgerList) continue;
      expect(snapshot).toHaveProperty(channel);
    }
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it(
    'drops a channel whose read is slower than SNAPSHOT_READ_BUDGET_MS, without waiting for it (HIVE-144 review — Ruling 15 extended)',
    async () => {
      /*
        `CH.githubPrs`'s real handler awaits `loginEnvStatus()` and shells out
        to `gh`, whose own runner timeout is 20 000 ms — four times the whole
        handshake window — and it resolves rather than rejects on failure, so
        a per-channel try/catch alone never sees it. `ledger:list` is what
        this fixture can make hang on demand; the mechanism under test is the
        same one that protects `github:prs` in production. A promise that
        genuinely never settles (not a slow-but-finite one) is what proves the
        *budget*, not the read finishing on its own, is what ends this.

        Real timers, deliberately (HIVE-144 review, second draft): the other
        five channels are answered by *this file's* real, unmocked
        `registerIpcHandlers()` composition — `agents:list` in particular does
        real, if fast, work of its own — and `vi.useFakeTimers()` only
        controls `setTimeout`/`setInterval`, not when that real work's own I/O
        actually completes. A first version of this test raced the fake
        clock against real disk I/O and flaked: `agents:list` timed out
        alongside the deliberately-hung `ledger:list`, for a reason that had
        nothing to do with the budget under test. Two real seconds bought
        instead is the honest price of exercising the real composition.
      */
      registerIpcHandlers();
      ledgerReadImpl = () => new Promise(() => {});

      const snapshot = await buildSnapshot()();

      expect(snapshot).not.toHaveProperty(CH.ledgerList);
      for (const channel of SNAPSHOT_CHANNELS) {
        if (channel === CH.ledgerList) continue;
        expect(snapshot).toHaveProperty(channel);
      }
    },
    SNAPSHOT_READ_BUDGET_MS + 5_000,
  );

  it(
    'logs a timed-out read once, not twice, when it rejects after the budget already gave up on it (HIVE-144 review)',
    async () => {
      /*
        `raceSnapshotRead` carries three `if (settled) return;` guards, and
        this is the one of the three with an observable effect: without it, a
        read that the budget has already timed out still logs a second,
        spurious "could not read" line when it eventually rejects — for a
        failure nobody is still waiting to hear about, since the snapshot
        already answered without this channel. The other two guards settle a
        `Promise`, which is a no-op the second time by spec regardless of
        whether the guard runs; this one gates a `console.error` call, which
        is not.
      */
      registerIpcHandlers();
      let rejectLate: ((cause: Error) => void) | undefined;
      ledgerReadImpl = () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const snapshot = await buildSnapshot()();
      expect(snapshot).not.toHaveProperty(CH.ledgerList);

      const logsFor = (needle: string): number =>
        logged.mock.calls.filter(
          (call) => String(call[0]).includes(CH.ledgerList) && String(call[0]).includes(needle),
        ).length;

      // The budget's own log, from the timeout branch — exactly one, proving
      // the read really was timed out before it ever rejected.
      expect(logsFor('exceeded')).toBe(1);

      // Now the read actually fails, well after `buildSnapshot()()` already
      // resolved without it.
      rejectLate?.(new Error('the ledger file is corrupt, eventually'));
      await new Promise((resolve) => setImmediate(resolve));

      // The catch branch's guard swallowed it: no second, later log for this
      // channel.
      expect(logsFor('could not read')).toBe(0);

      logged.mockRestore();
    },
    SNAPSHOT_READ_BUDGET_MS + 5_000,
  );
});

/**
 * The `WINDOW_BOUND` rule, made checkable (HIVE-143 review).
 *
 * `REMOTE_INVOKE_EVENT` is `{}` cast to an `IpcMainInvokeEvent`, which is safe
 * only because every call handler that dereferences it is refused before
 * `remote-dispatch` reaches a handler. Its comment says a fourth such handler
 * "must be added to that table in the same commit" — a rule nothing enforced.
 * This is the enforcement: the source text of `ipc/index.ts` itself, since what
 * is being asserted is a property of how the handlers are *written*, and no
 * amount of calling them can reveal a dereference that a window-bound refusal
 * stops from ever running.
 */
describe('handlers that dereference the Electron event', () => {
  /*
    A registration whose callback binds a first parameter that is not
    underscore-prefixed. That convention is the codebase's own and is enforced
    by `noUnusedParameters`: a handler that ignores the event writes `_event`,
    one that needs no arguments at all writes `()`, and only a handler that
    actually uses it writes `event`.
  */
  const REGISTRATION =
    /^\s*(?:handle|on)\(\s*CH\.(\w+)\s*,\s*(?:async\s+)?\(\s*([A-Za-z$][\w$]*)/gm;

  it('is exactly the WINDOW_BOUND entries that dereference it, plus the ones adapted for a surface', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../electron/main/ipc/index.ts', import.meta.url)),
      'utf8',
    );

    const channels = new Set<string>();
    for (const match of source.matchAll(REGISTRATION)) {
      const key = match[1] as keyof typeof CH;
      channels.add(CH[key]);
    }

    /**
     * The channels that read the event for a **surface identity**, not for a
     * window — added rather than refused, because a socket supplies one.
     *
     * It genuinely does, since HIVE-145: a call dispatched from a socket is
     * handed a synthetic event carrying that socket as its `sender`, the same
     * shape the notify path has always had. Before that it was handed `{}`, and
     * the first channel to key anything by surface found the hole — `fs:watch`
     * over a socket installed a watcher belonging to a surface that did not
     * exist, and every `fs:changed` it produced was addressed to nobody.
     *
     * `pty:prompt` was the first (HIVE-143): the surface registry accepts
     * anything with an `.on`, which `listener.ts` hands it, and refusing it
     * would have silently reverted HIVE-135's nudge holding for every remote
     * session. HIVE-145 added the other three, all for the same reason — each
     * holds state that is *per surface* and needs to know whose it is:
     *
     * - `ui:foreground` — which stage this surface is showing. One value for
     *   every surface at once was the defect.
     * - `pty:ack` — how far this surface has consumed. The flow-control window
     *   follows the slowest of them.
     * - `fs:watch` / `fs:unwatch` — which project tree this surface is
     *   watching. One slot meant the second client stole the first's watcher.
     *
     * None of them belongs in `WINDOW_BOUND`, and the membership test is what
     * says so: a channel qualifies there when its effect lands on the machine
     * that answers it while the person who asked is at the other one. These
     * record a fact about the asker and have no effect on the answering machine
     * at all.
     *
     * `configReveal` is subtracted (HIVE-144, Ruling 25) — the one
     * `WINDOW_BOUND` entry that does *not* dereference the event.
     * `handle(CH.configReveal, (): void => ...)` binds no parameter at all,
     * because `shell.showItemInFolder` needs none; it is refused for what it
     * does to the server's filesystem, not for anything it would do with
     * `REMOTE_INVOKE_EVENT`. Keeping it in `expected` here would assert a
     * property of the source text that is not true — this test's own
     * `REGISTRATION` regex correctly never matches its handler.
     */
    const SURFACE_ADAPTED = [
      CH.ptyPrompt,
      CH.uiForeground,
      CH.ptyAck,
      CH.fsWatch,
      CH.fsUnwatch,
    ];

    const expected = new Set(
      [...Object.keys(WINDOW_BOUND), ...SURFACE_ADAPTED].filter(
        (channel) => channel !== CH.configReveal,
      ),
    );

    expect(channels, [
      'A handler binds the Electron event that WINDOW_BOUND does not cover.',
      'There is no event to give one over a socket — REMOTE_INVOKE_EVENT is `{}`.',
      'Either add the channel to WINDOW_BOUND (electron/shared/remote-contract.ts),',
      'or adapt the handler the way pty:prompt was, to accept what a socket can supply.',
    ].join(' ')).toEqual(expected);
  });
});

/**
 * The mode switch (HIVE-144, Task 10).
 *
 * Here rather than in `router.test.ts` because the property under test is a
 * *count*: how many channels each surface actually has on `ipcMain` before,
 * during and after a switch. `router.test.ts` mocks both registrars, so every
 * count there would be zero — this file is the one that runs the real
 * `registerIpcHandlers`, the real `registerRemoteProxy`, and the real bindings
 * recorder underneath both.
 *
 * The brief's own version of "leaves the local surface bound when it refuses"
 * invoked one channel and checked it answered. That is necessary and nowhere
 * near sufficient: half an unbound surface answers that one channel too. So
 * every case below asserts the size of both recorders, and the invocation is
 * kept alongside as the second half — a count proves the surface is whole, a
 * call proves what was counted is a live handler.
 */
describe('the mode switch (HIVE-144)', () => {
  /**
   * Both modes bind the same channels: every `call` and every `notify` in the
   * contract, and no `event` — 105 of them. Written once here because the two
   * surfaces agreeing on this number is itself the invariant. `remote-proxy
   * .test.ts` and the registry case above own the question of whether 105 is
   * still the right number; this file only asks whether the two agree.
   */
  const BOUND_CHANNELS = 105;

  /**
   * `assertSender` compares `senderFrame` to `sender.mainFrame` by identity,
   * so a trusted event has to share one object rather than two equal literals.
   */
  const mainFrame = { url: 'file:///out/renderer/index.html' };
  const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } };

  /** Call a channel the way Electron would, through whatever is bound now. */
  const invoke = (channel: string, payload?: unknown): Promise<unknown> => {
    const handler = handledChannels.get(channel);
    if (handler === undefined) throw new Error(`nothing is bound to ${channel}`);
    return Promise.resolve(handler(trustedEvent, payload));
  };

  /**
   * A `RemoteClient` fake — fully implemented, so nothing is cast away.
   *
   * `drop()` is how a test ends this connection the way the real socket's
   * handlers would (HIVE-150), which is what the reconnect path listens on.
   */
  const fakeClient = () => {
    const closeListeners = new Set<(cause: CloseCause) => void>();
    return {
      call: vi.fn(async () => undefined),
      notify: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      snapshot: vi.fn(() => ({})),
      serverName: vi.fn(() => 'mini'),
      onClose: vi.fn((listener: (cause: CloseCause) => void) => {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      }),
      /*
        **A real `close()` fires the close listeners**, because `ws` answers a
        close with a `'close'` event and `socket.ts` announces from there. A
        fake that stayed silent hid a real defect for a whole branch: a
        deliberate detach closes this socket, the announcement lands, and the
        reconnect loop takes it for a drop and starts dialling the server the
        user has just left. The live two-app suite caught it; this fake is what
        lets a unit test catch it next time (HIVE-150).
      */
      close: vi.fn(() => {
        for (const listener of [...closeListeners]) {
          listener({ kind: 'transport', code: 'transport', message: 'closed' });
        }
        closeListeners.clear();
      }),
      drop(cause: CloseCause = { kind: 'transport', code: 'transport', message: 'closed' }) {
        for (const listener of [...closeListeners]) listener(cause);
        closeListeners.clear();
      },
    };
  };

  /**
   * A switch that would succeed: a loopback target, a stored credential, and a
   * dialler that answers. Each case overrides the one thing it is about.
   */
  const opts = (over: Record<string, unknown> = {}) => ({
    target: { host: '127.0.0.1', port: 7433 },
    credential: { deviceId: 'device-1', token: 'secret' },
    connect: async () => fakeClient(),
    ...over,
  });

  /** Bind local through the production door, as boot does, and count it. */
  const boundLocally = (): number => {
    registerIpc('local');
    return ipcBindingsSize();
  };

  it('binds the same number of channels either way', async () => {
    const local = boundLocally();

    expect(await switchIpcMode('remote', opts())).toEqual({ ok: true });

    expect(local).toBe(BOUND_CHANNELS);
    expect(remoteProxyBindingsSize()).toBe(BOUND_CHANNELS);
  });

  it('refuses local → remote while local sessions are live, and names them', async () => {
    boundLocally();
    /*
      In the order they were opened. `Sessions.entities()` spreads a `Map`'s
      keys, and `Map` iteration is insertion-ordered by the language spec, so
      this array is deterministic rather than incidental — and it is the order
      a pane should list them in.
    */
    entitiesAnswer = () => ['hero-refresh', 'api-migration'];

    expect(await switchIpcMode('remote', opts())).toEqual({
      ok: false,
      reason: 'live-sessions',
      sessions: ['hero-refresh', 'api-migration'],
    });
  });

  it('leaves the local surface entirely bound when it refuses over live sessions', async () => {
    const local = boundLocally();
    entitiesAnswer = () => ['hero-refresh'];

    await switchIpcMode('remote', opts());

    // Whole, not merely alive: an unbind that ran before the check would show
    // up here as a smaller number, never as a missing `config:get`.
    expect(ipcBindingsSize()).toBe(local);
    expect(remoteProxyBindingsSize()).toBe(0);
    expect(await invoke(CH.configGet)).toBeDefined();
  });

  /**
   * The interlock (HIVE-144 review, I3).
   *
   * `RemoteConfig`'s own doc comment says an install is the server or the
   * client and never a hybrid, and nothing enforced it. What that cost was
   * not a muddle but a permanent failure: `switchIpcMode`'s remote arm calls
   * `unbindEverything()` synchronously, before its first `await`, and that
   * runs `resetIpcHandlers({ flush: true })` → `remoteListener = null`. The
   * listener is built by `registerIpcHandlers` and started from exactly one
   * place, inside `whenReady` — so a boot attach on a serving machine dropped
   * it before it was ever started, and the machine stopped serving for good,
   * across relaunches, with the tray still claiming server mode.
   *
   * The assertion that matters is the last one: the listener is still there
   * to start. Before the fix, `startRemoteListener()` here answered `null`
   * off a dropped `remoteListener` and this counter stayed at 0 —
   * indistinguishable, from the resolved value alone, from a listener that
   * started and bound nothing.
   */
  it('refuses to attach on a machine that is serving, before dialling anything', async () => {
    const local = boundLocally();
    const connect = vi.fn(async () => fakeClient());
    setServerMode(true);

    const outcome = await switchIpcMode('remote', opts({ connect }));

    expect(outcome).toEqual({
      ok: false,
      reason: 'connect-failed',
      message: expect.stringContaining('server or the client, never both'),
    });
    // Refused before anything was touched: no dial, and the local surface is
    // whole rather than merely alive.
    expect(connect).not.toHaveBeenCalled();
    expect(ipcBindingsSize()).toBe(local);
    expect(remoteProxyBindingsSize()).toBe(0);
  });

  /**
   * The half the finding is actually about, asserted on its own so it cannot
   * be short-circuited by the refusal case above failing first.
   *
   * A dialler that **would succeed** is the point: a `vi.fn()` that never
   * answers would pass here for the wrong reason, because without the
   * interlock the switch fails on the dial, takes its rebind-local arm, and
   * constructs a fresh listener. Only a dial that would have worked leaves
   * the listener gone — which is exactly the boot case, where the attach
   * succeeds and `whenReady`'s `startRemoteListener()` then finds `null`.
   */
  it('leaves a serving machine with the listener it would otherwise have destroyed', async () => {
    boundLocally();
    setServerMode(true);

    await switchIpcMode('remote', opts({ connect: async () => fakeClient() }));
    await startRemoteListener();

    expect(listenerStarts).toBe(1);
  });

  it('still attaches on a machine that is not serving', async () => {
    boundLocally();
    setServerMode(false);

    expect(await switchIpcMode('remote', opts())).toEqual({ ok: true });
  });

  it('refuses a plaintext target before dialling or unbinding anything', async () => {
    const local = boundLocally();
    const connect = vi.fn();

    const outcome = await switchIpcMode(
      'remote',
      opts({ target: { host: '203.0.113.7', port: 7433 }, connect }),
    );

    expect(outcome).toEqual({ ok: false, reason: 'plaintext-refused' });
    /*
      Never dialled. A refusal that cost a TCP connection has already told
      whoever holds that address that this machine is here and looking for a
      Hive — the same property `connectRemote`'s own fence-(1) test pins.
    */
    expect(connect).not.toHaveBeenCalled();
    expect(ipcBindingsSize()).toBe(local);
    expect(remoteProxyBindingsSize()).toBe(0);
    expect(await invoke(CH.configGet)).toBeDefined();
  });

  it('rebinds the whole local surface when the connection fails', async () => {
    const local = boundLocally();

    const outcome = await switchIpcMode(
      'remote',
      opts({ connect: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:7433')) }),
    );

    expect(outcome).toEqual({
      ok: false,
      reason: 'connect-failed',
      message: 'connect ECONNREFUSED 127.0.0.1:7433',
    });
    // The count, not one channel: a rebind that dropped half the surface would
    // still answer `config:get`, and the window would be quietly crippled.
    expect(ipcBindingsSize()).toBe(local);
    expect(remoteProxyBindingsSize()).toBe(0);
    expect(await invoke(CH.configGet)).toBeDefined();
  });

  /**
   * `connectRemote`'s second fence: the host is a legitimate `.ts.net` string,
   * and the resolver answered with an address that is not a tailnet one. It
   * cannot be caught before the dial — the string is genuinely fine — so it
   * arrives as a rejection, and it must still read as `plaintext-refused`
   * rather than as a generic failure, because the remedy is the address field
   * and the tailnet, not a retry.
   */
  it('reports a refusal the resolver made as plaintext-refused, and rebinds local', async () => {
    const local = boundLocally();

    const outcome = await switchIpcMode(
      'remote',
      opts({
        target: { host: 'mini.tail1234.ts.net', port: 7433 },
        connect: () => Promise.reject(new PlaintextRefusedError('it resolved to 203.0.113.7')),
      }),
    );

    expect(outcome).toEqual({ ok: false, reason: 'plaintext-refused' });
    expect(ipcBindingsSize()).toBe(local);
    expect(remoteProxyBindingsSize()).toBe(0);
  });

  it('switches local → remote when nothing is live', async () => {
    boundLocally();
    const client = fakeClient();

    expect(await switchIpcMode('remote', opts({ connect: async () => client }))).toEqual({
      ok: true,
    });

    // The local surface is gone and the remote one is whole — not both, which
    // is what a switch that forgot to unbind would leave.
    expect(ipcBindingsSize()).toBe(0);
    expect(remoteProxyBindingsSize()).toBe(BOUND_CHANNELS);
    // Bound to the socket, not to this process: the proxy forwards.
    await invoke(CH.configGet);
    expect(client.call).toHaveBeenCalledWith(CH.configGet, undefined);
  });

  it('always allows remote → local, whatever is running on the other machine', async () => {
    const local = boundLocally();
    await switchIpcMode('remote', opts());

    /*
      The mini keeps its sessions; this client simply stops showing them, so
      there is nothing to strand and nothing to refuse over. `liveSessions` is
      answered non-empty on purpose: a `live-sessions` check that sat above the
      mode branch rather than inside its `remote` arm would fire here, and this
      is the case that catches it.
    */
    const outcome = await switchIpcMode('local', opts({ liveSessions: () => ['hero-refresh'] }));

    expect(outcome).toEqual({ ok: true });
    expect(ipcBindingsSize()).toBe(local);
    expect(remoteProxyBindingsSize()).toBe(0);
    expect(await invoke(CH.configGet)).toBeDefined();
  });

  it('closes the socket it opened when it detaches', async () => {
    boundLocally();
    const client = fakeClient();
    await switchIpcMode('remote', opts({ connect: async () => client }));

    await switchIpcMode('local', opts());

    // Whoever opened it closes it — `registerRemoteProxy` is handed a client it
    // did not open, and a detached socket nobody closes is a leak that outlives
    // every window this app has.
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  /**
   * `registerRemoteProxy` refuses a second registration outright (Task 9),
   * rather than silently orphaning the previous one's `notify` listeners. So
   * every re-register has to be preceded by `resetRemoteProxy()`, and a switch
   * that skipped it would throw where its caller expects an outcome.
   */
  it('re-attaches to a second server without a relaunch', async () => {
    boundLocally();
    await switchIpcMode('remote', opts());

    const second = fakeClient();
    const outcome = await switchIpcMode(
      'remote',
      opts({ target: { host: '100.64.0.9', port: 7433 }, connect: async () => second }),
    );

    expect(outcome).toEqual({ ok: true });
    expect(remoteProxyBindingsSize()).toBe(BOUND_CHANNELS);
    expect(ipcBindingsSize()).toBe(0);
    // The new socket answers, which is what "re-attached" means.
    await invoke(CH.configGet);
    expect(second.call).toHaveBeenCalledWith(CH.configGet, undefined);
  });

  /**
   * A settings pane commits the address field on blur while still in local
   * mode, which reaches the switch as `local` when local is already bound.
   * Tearing down and rebuilding for that would dispose the sessions layer —
   * which does not kill this machine's ptys but **orphans** them, still
   * running and no longer reachable, over a keystroke in a text field.
   */
  it('does not touch a local surface that is already bound', async () => {
    const local = boundLocally();
    const layer = sessionsLayer();

    expect(await switchIpcMode('local', opts())).toEqual({ ok: true });

    // Identity, not a count: a teardown and rebuild lands on the same number.
    expect(sessionsLayer()).toBe(layer);
    expect(ipcBindingsSize()).toBe(local);
  });

  /**
   * The rebind itself can fail, and when it does the switch **rejects** rather
   * than answering an outcome (HIVE-144, fix round 1).
   *
   * Nothing wraps `registerIpc('local', …)` in the catch arm, so a channel
   * `ipcMain` refuses — here, one bound behind the switch's back, exactly as a
   * half-torn-down surface would leave it — comes out as a rejected promise.
   * That is the honest shape: it is a programming error, not a runtime
   * condition, and flattening it into `connect-failed` would hide the one
   * state this whole story exists to prevent behind a message about the
   * network. It is also why `electron/main/index.ts`'s boot attach carries a
   * `.catch()`: unhandled, this is an unhandled rejection over a window with
   * no IPC.
   */
  it('rejects rather than lying when the rebind itself fails', async () => {
    boundLocally();
    // A squatter on one channel, so `registerIpcHandlers` hits the fake
    // `ipcMain.handle`'s duplicate refusal partway through its rebind.
    handledChannels.delete(CH.configGet);
    resetIpcHandlers();
    handledChannels.set(CH.configGet, () => undefined);

    await expect(
      switchIpcMode('remote', opts({ connect: () => Promise.reject(new Error('down')) })),
    ).rejects.toThrow(/second handler/);

    /*
      Swept up here rather than in `beforeEach`. The squatter is by definition
      a channel neither recorder knows about, so nothing in the shared teardown
      can reach it — and a `handledChannels.clear()` there would also erase the
      *real* leak this fixture's duplicate-handler refusal exists to catch.
    */
    handledChannels.delete(CH.configGet);
  });

  /**
   * The credential is read, not assumed. A machine that has never paired has
   * nothing to attach with, and that has to surface as a refusal the pane can
   * render rather than as an unhandled rejection in main — with local rebound,
   * because the unbind has already happened by the time the dial is attempted.
   */
  it('fails the switch, and rebinds local, when nothing has been paired', async () => {
    const local = boundLocally();
    const connect = vi.fn();

    const outcome = await switchIpcMode('remote', opts({ credential: null, connect }));

    expect(outcome).toMatchObject({ ok: false, reason: 'connect-failed' });
    expect(connect).not.toHaveBeenCalled();
    expect(ipcBindingsSize()).toBe(local);
    expect(remoteProxyBindingsSize()).toBe(0);
  });

  /**
   * Reconnecting after a drop (HIVE-150).
   *
   * HIVE-144's delivery notes list "nothing re-attaches after a socket drops"
   * as a deliberately deferred gap; this is where it closes. The loop's own
   * schedule is `reattach.test.ts`'s subject — what these prove is the seam:
   * that a drop is heard at all, that the surface is rebound to the new socket
   * rather than left pointing at the dead one, and that the two teardown paths
   * this module already had are not disturbed.
   */
  describe('a socket that drops after a successful attach', () => {
    // The backoff is the subject of every case here, and waiting out even the
    // first step for real would be a second of wall-clock per assertion.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rebinds the surface to the new client without unbinding local twice', async () => {
      boundLocally();
      const first = fakeClient();
      const second = fakeClient();
      let dials = 0;
      const connect = vi.fn(() => {
        dials += 1;
        return Promise.resolve(dials === 1 ? first : second);
      });

      await switchIpcMode('remote', opts({ connect }));
      expect(remoteProxyBindingsSize()).toBe(BOUND_CHANNELS);

      first.drop();
      await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);

      /*
        The count is the assertion that matters. `registerRemoteProxy` refuses
        to bind over itself, so a reattach that forgot `resetRemoteProxy` would
        throw; one that used `unbindEverything` instead would tear down the
        sessions layer and stop the receiver, which is a different bug with the
        same passing count. Both are excluded by binding exactly once more.
      */
      expect(remoteProxyBindingsSize()).toBe(BOUND_CHANNELS);
      expect(attachedServerName()).toBe('mini');
      expect(connect).toHaveBeenCalledTimes(2);
    });

    it('dials again naming where each watched terminal left off', async () => {
      boundLocally();
      const first = fakeClient();
      let dialCount = 0;
      const connect = vi.fn((deps: { resumeFrom?: Record<string, unknown> }) => {
        dialCount += 1;
        void deps;
        return Promise.resolve(dialCount === 1 ? first : fakeClient());
      });

      await switchIpcMode('remote', opts({ connect }));

      // What the proxy's two taps will do for real once a session is running.
      const tracker = attachedResumeTracker();
      tracker?.markWatched('sess-a');
      tracker?.record('sess-a', 2, 44);

      first.drop();
      await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);

      /*
        The first dial cannot carry one — there was nothing to resume from — and
        the second is the whole reason HIVE-144 built `ResumePoint` and bumped
        the protocol. Until this, `router.ts` dialled without it and the machine
        on the far side had no way to know a returning client had ever been
        there.
      */
      expect(connect.mock.calls[0][0].resumeFrom).toBeUndefined();
      expect(connect.mock.calls[1][0].resumeFrom).toEqual({
        'sess-a': { gen: 2, seq: 44 },
      });
    });

    it('does not reattach after the user has gone local', async () => {
      boundLocally();
      const first = fakeClient();
      const connect = vi.fn(() => Promise.resolve(fakeClient()));
      connect.mockResolvedValueOnce(first);

      await switchIpcMode('remote', opts({ connect }));
      first.drop();
      // Mid-backoff, the user gives up and works locally.
      await switchIpcMode('local');
      await vi.advanceTimersByTimeAsync(600_000);

      /*
        The trap this closes: a live timer outliving the mode switch and
        silently reattaching a user who explicitly asked to stop. `config:set-remote`
        is PROCESS_LOCAL precisely so this exit still answers with the socket
        dead, and it would be worth nothing if the loop ignored it.
      */
      expect(connect).toHaveBeenCalledTimes(1);
      expect(attachedServerName()).toBeNull();
      expect(remoteProxyBindingsSize()).toBe(0);
    });

    it('tells the window it has no link once it goes local', async () => {
      boundLocally();
      const first = fakeClient();
      const broadcaster = { emit: vi.fn() };
      const connect = vi.fn(() => Promise.resolve(first));

      await switchIpcMode('remote', opts({ connect, broadcaster }));
      broadcaster.emit.mockClear();

      await switchIpcMode('local', { broadcaster });

      /*
        `null`, not a `disconnected` status: that state means a link ended for a
        reason retrying cannot fix, and a deliberate detach is not that. Without
        this push the last `attached` status stands, and the header chip and the
        attach pane go on naming a machine the user has just stopped driving —
        the same staleness this channel exists to end, arriving through the
        other door.
      */
      expect(broadcaster.emit).toHaveBeenCalledWith(CH.remoteLinkStatus, null);
    });

    it('tells the window it has no link when an attach fails outright', async () => {
      boundLocally();
      const broadcaster = { emit: vi.fn() };
      const connect = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));

      const outcome = await switchIpcMode('remote', opts({ connect, broadcaster }));

      expect(outcome).toMatchObject({ ok: false });
      // A failed attach lands local too, and owes the window the same sentence.
      expect(broadcaster.emit).toHaveBeenCalledWith(CH.remoteLinkStatus, null);
    });

    it('does not hear its own detach as a drop', async () => {
      boundLocally();
      const first = fakeClient();
      const connect = vi.fn(() => Promise.resolve(first));

      await switchIpcMode('remote', opts({ connect }));
      await switchIpcMode('local');
      await vi.advanceTimersByTimeAsync(600_000);

      /*
        `unbindEverything` closes the client it dialled, and a real socket
        answers a close by announcing one — so without dropping the
        subscription first, going local starts a reconnect loop against the
        server the user has just left. `cancel()` alone does not stop it: a
        cancelled loop is idle, and `begin` on an idle loop is exactly how a
        genuine drop starts one.
      */
      expect(connect).toHaveBeenCalledTimes(1);
      expect(attachedServerName()).toBeNull();
    });

    it('never dials for a refusal another dial would reproduce', async () => {
      boundLocally();
      const first = fakeClient();
      const connect = vi.fn(() => Promise.resolve(first));

      await switchIpcMode('remote', opts({ connect }));
      first.drop({ kind: 'terminal', code: 'revoked', message: 'That device was revoked.' });
      await vi.advanceTimersByTimeAsync(600_000);

      expect(connect).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Notifications delivered to whoever is attached (HIVE-145).
 *
 * ## Why here and not in the live suite
 *
 * The other half of this story's acceptance is "a session question notifies the
 * remote client's OS", and the live suite cannot drive it: raising a real
 * notification needs real hook traffic from a real `claude`, which
 * `server-conformance.test.ts` deliberately stubs out with `true; false` so
 * that a machine with a real `claude` on its PATH does not have one started by
 * a socket.
 *
 * What it *can* be driven through is this file, which runs the real hub, the
 * real router and the real queue over the real registry — only the listener and
 * the session layer are stood in for. So the toast decision, the per-surface
 * routing and the queue are all under test at their own seam, and the last
 * inch, an Electron `Notification` actually appearing, is `remote-toast.test.ts`
 * (no automated test anywhere can assert a real banner appeared on a desktop).
 */
describe('notifications reach the attached client (HIVE-145)', () => {
  /** A socket that records what it was sent, in order. */
  const recordingSocket = (): { socket: AttachedSocket; sent: unknown[] } => {
    const sent: unknown[] = [];
    return { socket: { send: (frame) => sent.push(frame) } as AttachedSocket, sent };
  };

  /** An ask addressed to the console, which is what mints an `agent.ask` card. */
  const ask = (id: string) => ({
    id,
    ts: Date.now(),
    from: 'scout',
    to: OVERMIND,
    kind: 'ask',
    ref: 'a12',
    body: 'May I force-push?\nThe rebase is clean.',
  });

  const toastsTo = (sent: unknown[]): unknown[] =>
    sent.filter(
      (frame) => (frame as { channel?: string }).channel === CH.notificationsToast,
    );

  it('sends the toast over the socket rather than raising it on the server', () => {
    registerIpcHandlers();
    const { socket, sent } = recordingSocket();
    onAttach()(socket, undefined);

    emitLedgerChanged(ask('20260909-120000-0001'));

    /*
      The whole point of the story's notification half. A served Mac raises a
      toast on a desktop nobody is at; the row always crossed, the interruption
      did not. `Notification.isSupported()` is false in this fixture, so the
      local presenter is a no-op either way — what is asserted is that the
      *frame* went to the socket.
    */
    const toasts = toastsTo(sent);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      kind: 'event',
      channel: CH.notificationsToast,
      payload: {
        id: '20260909-120000-0001',
        kind: 'agent.ask',
        /*
          The asker's name, resolved by the hub at the moment the toast is made
          rather than frozen when the ask was written (HIVE-118) — so what
          crosses the socket is the composed toast title, not the row's own.
          That is why `ToastPayload` is not `HiveNotification`: a receiver
          recomposing this could disagree with the machine that decided it.
        */
        title: 'scout May I force-push?',
        body: 'The rebase is clean.',
      },
    });
  });

  it('sends one toast to each of two attached clients', () => {
    registerIpcHandlers();
    const a = recordingSocket();
    const b = recordingSocket();
    onAttach()(a.socket, undefined);
    onAttach()(b.socket, undefined);

    emitLedgerChanged(ask('20260909-120000-0002'));

    expect(toastsTo(a.sent)).toHaveLength(1);
    expect(toastsTo(b.sent)).toHaveLength(1);
  });

  it('holds a toast raised with nobody attached, and delivers it on the next attach', () => {
    registerIpcHandlers();

    /*
      Raised into an empty room: no window, no socket. The row is not lost
      either way — the hub's buffer outlives every surface and the attach
      snapshot carries it — so what is held here is only the interruption.
    */
    emitLedgerChanged(ask('20260909-120000-0003'));

    const { socket, sent } = recordingSocket();
    expect(toastsTo(sent)).toHaveLength(0);

    onAttach()(socket, undefined);

    const toasts = toastsTo(sent);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      payload: { id: '20260909-120000-0003', kind: 'agent.ask' },
    });
  });

  it('does not replay a held toast to a second client that missed nothing', () => {
    registerIpcHandlers();
    emitLedgerChanged(ask('20260909-120000-0004'));

    const first = recordingSocket();
    onAttach()(first.socket, undefined);
    expect(toastsTo(first.sent)).toHaveLength(1);

    /*
      The flush is on the empty-to-non-empty edge, not on every arrival. A
      second device joining a server the first is already watching has missed
      nothing, and replaying to it would interrupt about an event the surface
      beside it was told of at the time.
    */
    const second = recordingSocket();
    onAttach()(second.socket, undefined);

    expect(toastsTo(second.sent)).toHaveLength(0);
  });

  it('empties the queue on the flush, so a re-attach is quiet', () => {
    registerIpcHandlers();
    emitLedgerChanged(ask('20260909-120000-0005'));

    const first = recordingSocket();
    onAttach()(first.socket, undefined);
    expect(toastsTo(first.sent)).toHaveLength(1);
    onDetach()(first.socket);

    const again = recordingSocket();
    onAttach()(again.socket, undefined);

    expect(toastsTo(again.sent)).toHaveLength(0);
  });
});

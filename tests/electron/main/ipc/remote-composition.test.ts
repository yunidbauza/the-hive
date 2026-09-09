// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptySnapshot } from '../../../../electron/shared/config-contract';
import { WINDOW_BOUND } from '../../../../electron/shared/remote-contract';
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
 * Channels the fake `ipcMain.handle` below currently considers bound.
 *
 * A bare `vi.fn()` here would accept a second registration for the same
 * channel silently, which makes `expect(() => registerIpcHandlers()).not
 * .toThrow()` a placebo — real Electron's `ipcMain.handle` throws on exactly
 * that, and that throw is what HIVE-144's whole reversibility guarantee is
 * proven against. So `handle` tracks what it has bound and `removeHandler`
 * un-tracks it, mirroring the one behaviour that matters here.
 */
const handledChannels = new Set<string>();

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
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => windows },
  dialog: { showOpenDialog: vi.fn() },
  Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  ipcMain: {
    handle: (channel: string, _fn: unknown) => {
      // The exact refusal Electron's real `ipcMain.handle` makes — the throw
      // HIVE-144's re-registration test exists to survive.
      if (handledChannels.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      handledChannels.add(channel);
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
    shutdown: async () => {},
    isRunning: () => true,
    isBlocked: () => false,
    sessionIds: () => [],
  }),
}));

vi.mock('../../../../electron/main/shutdown', () => ({ onShutdown: vi.fn() }));

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

vi.mock('../../../../electron/main/ledger', () => ({
  createLedger: () => ({
    read: () => ({ entries: [], openAsks: [], claims: {} }),
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
type OnAttach = (socket: AttachedSocket, resumeFrom: Readonly<Record<string, number>> | undefined) => void;
let capturedOnAttach: OnAttach | null = null;

/** The captured callback, or a failure naming why it is missing. */
const onAttach = (): OnAttach => {
  if (capturedOnAttach === null) {
    throw new Error('createRemoteListener was never handed an onAttach');
  }
  return capturedOnAttach;
};

vi.mock('@remote-host/listener', () => ({
  createRemoteListener: (options: { onAttach: OnAttach }) => {
    capturedOnAttach = options.onAttach;
    return {
      start: async () => null,
      stop: async () => {},
      get boundHost() {
        return null;
      },
      get lastBindError() {
        return null;
      },
    };
  },
}));

/**
 * What `sessions.resume` answers next, per entity id — the three-way branch
 * `onAttach` reads.
 *
 * A function rather than a value so a case can observe *when* it is called,
 * which is how the ordering assertion below is made: a push raised from inside
 * this fake is a push raised from inside the replay loop.
 */
let resumeAnswer: (entityId: string, lastSeq: number) => ResumeResult | null = () => null;

vi.mock('../../../../electron/main/sessions', () => ({
  createSessions: () => ({
    open: vi.fn(),
    openCommand: vi.fn(),
    write: vi.fn(() => false),
    resize: vi.fn(),
    ack: vi.fn(),
    resume: (entityId: string, lastSeq: number) => resumeAnswer(entityId, lastSeq),
    kill: vi.fn(),
    restart: vi.fn(async () => {}),
    entities: () => [],
    isIdle: () => false,
    observedCwd: () => undefined,
    containerRemoval: async () => {},
    diagnostics: () => [],
    dispose: vi.fn(),
  }),
}));

const { CH } = await import('../../../../electron/shared/ipc-contract');
const { registerIpcHandlers, remoteRegistrySize, resetIpcHandlers } = await import(
  '../../../../electron/main/ipc'
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
  resumeAnswer = () => null;
  vi.clearAllMocks();
  resetIpcHandlers();
});

afterEach(() => {
  resetIpcHandlers();
});

describe('remote composition (HIVE-143)', () => {
  it('records nothing before registerIpcHandlers runs', () => {
    expect(sizeBeforeRegistration).toBe(0);
  });

  it('records a handler for every call and notify channel', () => {
    registerIpcHandlers();

    /*
      89 call + 6 notify. Asserted as the total so a channel added to the
      contract without a handler — or a `handle`/`on` call that stopped
      recording — fails here rather than at a socket.

      It does **not** catch a channel registered twice: `recordCall` and
      `recordNotify` are `Map.set`, so a second registration overwrites the
      first and leaves the count exactly where it was. That case is covered
      elsewhere, by the real `ipcMain.handle` refusing a second handler for a
      channel — not by this number.
    */
    expect(remoteRegistrySize()).toBe(102);
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

    onAttach()(socket, { ghost: 12 });

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
        { sessionId: entityId, chunk: 'one', seq: 4 },
        { sessionId: entityId, chunk: 'two', seq: 5 },
      ],
    });

    onAttach()(socket, { 'hero-refresh': 3 });

    expect(sent).toEqual([
      { kind: 'event', channel: CH.ptyData, payload: { sessionId: 'hero-refresh', chunk: 'one', seq: 4 } },
      { kind: 'event', channel: CH.ptyData, payload: { sessionId: 'hero-refresh', chunk: 'two', seq: 5 } },
    ]);
  });

  it('marks a gap with exactly one empty chunk at the head seq', () => {
    registerIpcHandlers();
    const { socket, sent } = recordingSocket();
    resumeAnswer = () => ({ kind: 'gap', seq: 97 });

    onAttach()(socket, { 'hero-refresh': 12 });

    /*
      One frame, empty, stamped at where the stream actually is. The seq is not
      `lastSeq + 1`, which is what trips the client's discontinuity check
      (`src/lib/terminal/pty-transport.ts`) the moment it lands rather than
      whenever output next happens; the empty chunk is what makes that free —
      xterm writes nothing. `toEqual` on the whole array, so a second frame or a
      non-empty chunk fails here.
    */
    expect(sent).toEqual([
      { kind: 'event', channel: CH.ptyData, payload: { sessionId: 'hero-refresh', chunk: '', seq: 97 } },
    ]);
  });

  it('asks about every session in the map, and branches per session', () => {
    registerIpcHandlers();
    const { socket, sent } = recordingSocket();
    const asked: [string, number][] = [];
    resumeAnswer = (entityId, lastSeq) => {
      asked.push([entityId, lastSeq]);
      if (entityId === 'gone') return null;
      if (entityId === 'stale') return { kind: 'gap', seq: 30 };
      return { kind: 'replay', events: [{ sessionId: entityId, chunk: 'x', seq: 2 }] };
    };

    onAttach()(socket, { gone: 1, stale: 2, live: 1 });

    expect(asked).toEqual([
      ['gone', 1],
      ['stale', 2],
      ['live', 1],
    ]);
    expect(sent).toEqual([
      { kind: 'event', channel: CH.ptyData, payload: { sessionId: 'stale', chunk: '', seq: 30 } },
      { kind: 'event', channel: CH.ptyData, payload: { sessionId: 'live', chunk: 'x', seq: 2 } },
    ]);
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
      return { kind: 'replay', events: [{ sessionId: entityId, chunk: 'x', seq: 9 }] };
    };

    onAttach()(socket, { 'hero-refresh': 8 });

    expect(sent).toEqual([
      { kind: 'event', channel: CH.ledgerChanged, payload: { id: 'mid-replay' } },
      { kind: 'event', channel: CH.ptyData, payload: { sessionId: 'hero-refresh', chunk: 'x', seq: 9 } },
    ]);
  });
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

  it('is exactly the WINDOW_BOUND three, plus the one adapted for a socket', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../electron/main/ipc/index.ts', import.meta.url)),
      'utf8',
    );

    const channels = new Set<string>();
    for (const match of source.matchAll(REGISTRATION)) {
      const key = match[1] as keyof typeof CH;
      channels.add(CH[key]);
    }

    /*
      `pty:prompt` is the deliberate fourth: it uses the event for a surface
      *lifetime* rather than for a window, and `watchReporter` accepts anything
      with an `.on`, which `listener.ts` hands it. Refusing it would silently
      revert HIVE-135's nudge holding for every remote session.
    */
    const expected = new Set([...Object.keys(WINDOW_BOUND), CH.ptyPrompt]);

    expect(channels, [
      'A handler binds the Electron event that WINDOW_BOUND does not cover.',
      'There is no event to give one over a socket — REMOTE_INVOKE_EVENT is `{}`.',
      'Either add the channel to WINDOW_BOUND (electron/shared/remote-contract.ts),',
      'or adapt the handler the way pty:prompt was, to accept what a socket can supply.',
    ].join(' ')).toEqual(expected);
  });
});

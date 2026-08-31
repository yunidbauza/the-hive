// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LedgerResult } from '../../../../electron/shared/ledger-contract';

/**
 * The ledger's channel wiring (HIVE-111 fix round 1) — what `ipc/index.ts`
 * *does with* a `Ledger`, not the ledger's own rules.
 *
 * `createLedger` is faked the way `sessions/history.ts` is faked in
 * `session-history.test.ts`, and for the same reason: kind validation, thread
 * resolution, the body cap and every other store rule are
 * `tests/electron/main/ledger/index.test.ts`'s job. What belongs here is the
 * seam — that `ledger:post` and `ledger:answer` substitute the coordinator id
 * regardless of what a payload claims, that `knowsParty` is the three-way OR
 * the contract promises and stays null-safe across the one window in startup
 * where its two dependencies are not yet assigned, that a refusal is a
 * *value* the promise resolves with, and that an appended entry reaches every
 * live window and no destroyed one.
 */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

let liveIds: string[] = [];
let resumableIds: string[] = [];

interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
  /**
   * Only `notifications:act` (HIVE-118) needs these three — the focus
   * sequence `hub.activate` runs before it looks at the action at all.
   * Optional so every window built for the `ledger:changed` cases above
   * keeps compiling unchanged.
   */
  isMinimized?: () => boolean;
  restore?: () => void;
  focus?: () => void;
}
const windows: FakeWindow[] = [];

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    on: vi.fn(),
    removeListener: vi.fn(),
    getPath: () => '/tmp/hive-test',
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => windows },
  dialog: { showOpenDialog: vi.fn() },
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
  onShutdown: vi.fn(),
}));

const snapshot = {
  configPath: '/tmp/config.json',
  templateWritten: false,
  shell: '/bin/zsh',
  claudeCommand: 'claude',
  projects: [],
  errors: [],
};

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

vi.mock('../../../../electron/main/sessions/history', () => ({
  createSessionHistory: () => ({
    begin: vi.fn(),
    record: vi.fn(),
    resumable: (id: string) => (resumableIds.includes(id) ? { id } : undefined),
    all: () => [],
    flush: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock('../../../../electron/main/sessions/index', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../electron/main/sessions/index')>();
  return {
    ...actual,
    createSessions: (options: Parameters<typeof actual.createSessions>[0]) => ({
      ...actual.createSessions(options),
      entities: () => liveIds,
    }),
  };
});

/**
 * What `registerIpcHandlers()` hands to `createHookRuntime` and to its own
 * `handle(CH.ledger*, …)` calls — captured off the fake so the assertions
 * below are about what main *did with* it, never about what it computes
 * internally.
 */
let capturedKnowsParty: ((id: string) => boolean) | undefined;
let capturedOnChangeListener: ((entry: unknown) => void) | undefined;
/**
 * `knowsParty`'s answer evaluated *inside* the `createLedger` call itself —
 * the one moment `sessions` is provably still `null`, because
 * `ipc/index.ts` assigns it a few lines *after* constructing the ledger.
 * Nothing outside that call can observe this window once
 * `registerIpcHandlers()` has returned, so it is captured here rather than
 * asserted from a test body.
 */
let knowsPartyBeforeSessionsAssigned: boolean | undefined;

const ledgerRead = vi.fn(() => ({ entries: [], openAsks: [], claims: {} }));
const ledgerAppend = vi.fn(
  (_request: unknown): LedgerResult => ({ ok: true, id: 'entry-1' }),
);
const ledgerAnswer = vi.fn(
  (_request: unknown, _from: string): LedgerResult => ({ ok: true, id: 'entry-2' }),
);

vi.mock('../../../../electron/main/ledger', () => ({
  createLedger: (options: { knowsParty: (id: string) => boolean }) => {
    capturedKnowsParty = options.knowsParty;
    knowsPartyBeforeSessionsAssigned = options.knowsParty('anyone');
    return {
      read: ledgerRead,
      append: ledgerAppend,
      answer: ledgerAnswer,
      onChange: (listener: (entry: unknown) => void) => {
        capturedOnChangeListener = listener;
        return () => {
          capturedOnChangeListener = undefined;
        };
      },
    };
  },
}));

const { CH } = await import('../../../../electron/shared/ipc-contract');
const { OVERMIND } = await import('../../../../electron/shared/ledger-contract');
const { registerIpcHandlers, resetIpcHandlers } = await import(
  '../../../../electron/main/ipc'
);

const mainFrame = { url: 'file:///out/renderer/index.html' };
const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } } as never;

const post = (payload: unknown) =>
  Promise.resolve().then(() => handlers.get(CH.ledgerPost)!(trustedEvent, payload));
const answer = (payload: unknown) =>
  Promise.resolve().then(() => handlers.get(CH.ledgerAnswer)!(trustedEvent, payload));
/** `notifications:act` (HIVE-118) — a clicked inbox row, or a clicked toast. */
const act = (payload: unknown) => handlers.get(CH.notificationsAct)!(trustedEvent, payload);

beforeEach(() => {
  handlers.clear();
  liveIds = [];
  resumableIds = [];
  windows.length = 0;
  capturedKnowsParty = undefined;
  capturedOnChangeListener = undefined;
  knowsPartyBeforeSessionsAssigned = undefined;
  vi.clearAllMocks();
  registerIpcHandlers();
});

afterEach(() => {
  resetIpcHandlers();
});

describe('ledger:post forces `from` (HIVE-111)', () => {
  it('substitutes the coordinator id even when the payload names another party', async () => {
    await post({ kind: 'post', body: 'hello', from: 'impersonator' });

    expect(ledgerAppend).toHaveBeenCalledWith({
      kind: 'post',
      body: 'hello',
      from: OVERMIND,
    });
    expect(ledgerAppend).not.toHaveBeenCalledWith(
      expect.objectContaining({ from: 'impersonator' }),
    );
  });
});

describe('ledger:answer answers as the coordinator (HIVE-111)', () => {
  it('passes the coordinator id as `from`, and drops any `from` smuggled into the payload', async () => {
    await answer({ thread: 'a1', body: 'done', from: 'impersonator' });

    // `LedgerAnswerRequest` carries no `from` to begin with — `parseLedgerAnswerRequest`
    // builds the request from `thread`/`body`/`meta` alone, so the object
    // reaching `ledger.answer` has no such field regardless of the payload.
    expect(ledgerAnswer).toHaveBeenCalledWith({ thread: 'a1', body: 'done' }, OVERMIND);
  });
});

describe('knowsParty (HIVE-111)', () => {
  it('accepts the coordinator id', () => {
    expect(capturedKnowsParty?.(OVERMIND)).toBe(true);
  });

  it('accepts a live session', () => {
    liveIds = ['sess-live'];
    expect(capturedKnowsParty?.('sess-live')).toBe(true);
  });

  it('accepts a resumable (ended) session', () => {
    resumableIds = ['sess-ended'];
    expect(capturedKnowsParty?.('sess-ended')).toBe(true);
  });

  it('refuses an id that is none of those', () => {
    liveIds = ['sess-live'];
    resumableIds = ['sess-ended'];
    expect(capturedKnowsParty?.('stranger')).toBe(false);
  });

  it('does not throw at the one moment `sessions` is still null — before it is assigned', () => {
    // See `knowsPartyBeforeSessionsAssigned` above: computed synchronously
    // inside the `createLedger` call, before `ipc/index.ts` assigns
    // `sessions` a few lines later. A non-null-safe `sessions.entities()`
    // would have thrown right here, during `registerIpcHandlers()` itself,
    // and every test in this file would already be failing to set up.
    expect(knowsPartyBeforeSessionsAssigned).toBe(false);
  });

  it('does not throw once `sessions` and `history` are null again, after teardown', () => {
    // The closure captured above closes over the module's own `sessions` and
    // `history` variables, not a snapshot — `resetIpcHandlers()` nulls both,
    // so invoking the same function afterwards exercises the identical
    // null-safe path a second time, from the other side of the module's
    // lifecycle.
    const knowsParty = capturedKnowsParty!;
    resetIpcHandlers();

    expect(() => knowsParty('anyone')).not.toThrow();
    expect(knowsParty('anyone')).toBe(false);
    expect(knowsParty(OVERMIND)).toBe(true);
  });
});

describe('a refusal resolves as a value (HIVE-111)', () => {
  it('does not reject the invoke promise when the ledger refuses a write', async () => {
    ledgerAppend.mockReturnValueOnce({
      ok: false,
      status: 404,
      reason: 'unknown party: ghost',
    });

    await expect(post({ kind: 'post', body: 'hi' })).resolves.toEqual({
      ok: false,
      status: 404,
      reason: 'unknown party: ghost',
    });
  });
});

describe('ledger:changed — the push channel (HIVE-111)', () => {
  it('broadcasts an appended entry to every live window and skips destroyed ones', () => {
    const liveSend = vi.fn();
    const destroyedSend = vi.fn();
    windows.push(
      { isDestroyed: () => false, webContents: { send: liveSend } },
      { isDestroyed: () => true, webContents: { send: destroyedSend } },
    );

    const entry = {
      id: '20260828-141530-0001',
      ts: 1,
      from: OVERMIND,
      kind: 'post' as const,
      body: 'hi',
    };
    capturedOnChangeListener?.(entry);

    expect(liveSend).toHaveBeenCalledWith(CH.ledgerChanged, entry);
    expect(destroyedSend).not.toHaveBeenCalled();
  });
});

/**
 * `notifications:act` routing an `ask` (HIVE-118) — the main-process half of
 * dispatch. Main answers nothing on an ask's behalf (a desktop toast has no
 * option buttons), so its whole contract is "focus the window, tell the
 * renderer where the card is, touch nothing else". `agent` is covered on the
 * renderer side instead — `performAction` in `notification-card.test.tsx`
 * never reaches this handler for it at all, and this file's fake `electron`
 * module has no `shell` or `Notification` to assert *against*, which is
 * exactly the point: those must stay untouched.
 *
 * The focus cases are characterization tests. The `notifications:activate`
 * case is not: it is the regression for the review finding that main returned
 * early on an `ask` and sent nothing, so a user whose rail sat on the explorer
 * — or was collapsed — got the window forward and no card anywhere on it.
 */
describe('notifications:act — an ask focuses the window and reveals the card (HIVE-118)', () => {
  /**
   * The fix itself: main names the cause, the renderer picks the destination.
   *
   * Asserted as the exact event rather than "something was sent", because the
   * discriminant is the whole contract — `use-notification-activate.ts`
   * branches on it, and an `entity`-shaped payload here would send the user to
   * a tab instead of the inbox.
   */
  it('tells the renderer an ask was activated, on the same channel a session uses', () => {
    const send = vi.fn();
    windows.push({
      isDestroyed: () => false,
      webContents: { send },
      isMinimized: () => false,
      restore: vi.fn(),
      focus: vi.fn(),
    });

    act({ type: 'ask', thread: 'a41' });

    expect(send).toHaveBeenCalledWith(CH.notificationsActivate, { type: 'ask' });
  });

  /** The session path still says which entity, and still says it the same way. */
  it('keeps the session path on the entity shape', () => {
    const send = vi.fn();
    windows.push({
      isDestroyed: () => false,
      webContents: { send },
      isMinimized: () => false,
      restore: vi.fn(),
      focus: vi.fn(),
    });

    act({ type: 'session', entityId: 'sess-01' });

    expect(send).toHaveBeenCalledWith(CH.notificationsActivate, {
      type: 'entity',
      entityId: 'sess-01',
    });
  });

  it('characterizes the contract: focuses every live window, throws nothing, opens nothing external', () => {
    const focus = vi.fn();
    const restore = vi.fn();
    windows.push({
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
      isMinimized: () => false,
      restore,
      focus,
    });

    expect(() => act({ type: 'ask', thread: 'a41' })).not.toThrow();

    expect(focus).toHaveBeenCalledTimes(1);
    // Nothing minimized, so nothing should have been asked to restore.
    expect(restore).not.toHaveBeenCalled();
  });

  it('characterizes the contract: restores a minimized window before focusing it, exactly as any other action does', () => {
    const focus = vi.fn();
    const restore = vi.fn();
    windows.push({
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
      isMinimized: () => true,
      restore,
      focus,
    });

    act({ type: 'ask', thread: 'a41' });

    expect(restore).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('characterizes the contract: skips a destroyed window rather than touching it', () => {
    const isMinimized = vi.fn(() => false);
    const focus = vi.fn();
    windows.push({
      isDestroyed: () => true,
      webContents: { send: vi.fn() },
      isMinimized,
      focus,
    });

    expect(() => act({ type: 'ask', thread: 'a41' })).not.toThrow();

    expect(isMinimized).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});

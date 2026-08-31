// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ui:foreground` (HIVE-81) — main records the id and computes the predicate.
 * The notifier's re-arm (`reevaluateForeground`) is one of its consumers now;
 * this file mocks the notifier factory itself, so that half is exercised in
 * `tests/electron/main/notifications/index.test.ts` instead.
 *
 * Mocked the way `config-channels.test.ts` mocks electron, and for the same
 * reason: `ipc/index.ts` imports it at module scope, so the mock has to be
 * installed before the dynamic import below. `ipcMain.on` records every
 * registration instead of `.handle`, because `CH.uiForeground` is a `send`
 * channel — a report, not a question.
 *
 * `windows` is a mutable array the tests reassign to simulate the window
 * gaining and losing OS focus; `windowFocused()` in `ipc/index.ts` reads it
 * fresh on every call via `BrowserWindow.getAllWindows()`.
 */
type OnHandler = (event: unknown, payload: unknown) => void;

const onHandlers = new Map<string, OnHandler>();
const shutdownHooks: (() => void)[] = [];

let windows: { isDestroyed: () => boolean; isFocused: () => boolean }[] = [];

/**
 * `app`-level window events (HIVE-81 review, finding 4).
 *
 * A set per event name, so a test can both fire them and assert that
 * `resetIpcHandlers` took its listeners away again.
 */
const appListeners = new Map<string, Set<() => void>>();

const emitAppEvent = (event: string): void => {
  for (const listener of appListeners.get(event) ?? []) listener();
};

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    getPath: () => '/tmp/hive-test',
    on: (event: string, listener: () => void) => {
      const existing = appListeners.get(event) ?? new Set<() => void>();
      existing.add(listener);
      appListeners.set(event, existing);
    },
    removeListener: (event: string, listener: () => void) => {
      appListeners.get(event)?.delete(listener);
    },
  },
  BrowserWindow: {
    fromWebContents: () => null,
    getAllWindows: () => windows,
  },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, fn: OnHandler) => {
      onHandlers.set(channel, fn);
    },
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
  onShutdown: (hook: () => void) => shutdownHooks.push(hook),
}));

/**
 * The real `isForeground` composition (HIVE-81) — `action.type === 'session'
 * && isForeground(action.entityId)` in `ipc/index.ts` — is the one line that
 * makes "non-session kinds are never gated" true in the shipped app. Asserting
 * it by inspection is not enough, so this mocks the hub *factory* rather than
 * the hub itself: `registerIpcHandlers` still runs for real, still resolves
 * the real `isForeground` from module scope, still composes the real
 * predicate — this only intercepts the options object handed to
 * `createNotificationHub` so the predicate can be called directly.
 */
let capturedIsForeground:
  | ((action: import('../../../../electron/shared/notification-contract').NotificationAction) => boolean)
  | undefined;

/** The hub's `subjectName` resolver, captured the same way (HIVE-110). */
let capturedSubjectName: ((terminalId: string) => string) | undefined;

const fakeHub = {
  list: () => [],
  markRead: () => {},
  dismiss: () => {},
  raise: () => null,
  activate: () => {},
  clear: () => {},
};

/*
  The hub and the notifier are faked; `createSessionNames` is the **real** one
  (HIVE-110). The point of these tests is the wiring — that a name reported over
  `ui:session-name` is the name the hub would put in a toast — and a fake
  registry would let that wiring be broken and still pass.
*/
vi.mock('../../../../electron/main/notifications', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../electron/main/notifications')
  >('../../../../electron/main/notifications');

  return {
    createNotificationHub: (options: {
      isForeground?: (
        action: import('../../../../electron/shared/notification-contract').NotificationAction,
      ) => boolean;
      subjectName?: (terminalId: string) => string;
    }) => {
      capturedIsForeground = options.isForeground;
      capturedSubjectName = options.subjectName;
      return fakeHub;
    },
    createNotifier: () => ({ observe: vi.fn(), reevaluateForeground: vi.fn() }),
    createSessionNames: actual.createSessionNames,
  };
});

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

const { CH } = await import('../../../../electron/shared/ipc-contract');
const { registerIpcHandlers, resetIpcHandlers, isForeground } = await import(
  '../../../../electron/main/ipc'
);

/**
 * `assertSender` compares `senderFrame` to `sender.mainFrame` by **identity**,
 * so a trusted event has to share one object rather than two equal literals.
 */
const mainFrame = { url: 'file:///out/renderer/index.html' };
const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } } as never;

/** A window that has, or has not, OS focus right now. */
const fakeWindow = (focused: boolean) => ({
  isDestroyed: () => false,
  isFocused: () => focused,
});

const report = (payload: unknown) => {
  onHandlers.get(CH.uiForeground)!(trustedEvent, payload);
};

const reportName = (payload: unknown) => {
  onHandlers.get(CH.uiSessionName)!(trustedEvent, payload);
};

beforeEach(() => {
  onHandlers.clear();
  shutdownHooks.length = 0;
  appListeners.clear();
  windows = [fakeWindow(true)];
  vi.clearAllMocks();
  vi.useFakeTimers();
  registerIpcHandlers();
});

/*
  The cases below advance the clock by a millisecond rather than running the
  timers to exhaustion (HIVE-120).

  `scheduleForegroundChange` is a 0 ms `setTimeout`, so a single tick is all it
  ever needed. `vi.runAllTimers()` additionally required that the composition
  own no *repeating* timer — and since the ledger sweep, it owns one, so
  exhaustion is no longer a state this registration can reach.
*/

afterEach(() => {
  resetIpcHandlers();
  vi.useRealTimers();
});

describe('ui:foreground', () => {
  it('registers as a send (`on`) channel, not invoke', () => {
    expect(onHandlers.has(CH.uiForeground)).toBe(true);
  });

  it('records a reported terminal id', () => {
    report({ terminalId: 'term-1' });

    expect(isForeground('term-1')).toBe(true);
  });

  it('rejects a payload with an extra key', () => {
    report({ terminalId: 'term-1', extra: 1 });

    // The guard throws inside `on()`'s wrapper, which logs and drops rather
    // than surfacing — so the assertion is on the state the rejected payload
    // failed to change, not on a thrown error.
    expect(isForeground('term-1')).toBe(false);
  });

  it('rejects a non-string, non-null terminalId', () => {
    report({ terminalId: 42 });

    expect(isForeground('42')).toBe(false);
    expect(isForeground('term-1')).toBe(false);
  });

  it('is not foreground while the window is blurred', () => {
    windows = [fakeWindow(false)];

    report({ terminalId: 'term-1' });

    expect(isForeground('term-1')).toBe(false);
  });

  it('is not foreground for a different terminal id', () => {
    report({ terminalId: 'term-1' });

    expect(isForeground('term-2')).toBe(false);
  });

  it('treats a null report as nothing on stage', () => {
    report({ terminalId: 'term-1' });
    report({ terminalId: null });

    expect(isForeground('term-1')).toBe(false);
  });

  it('notifies foreground listeners when the reported id changes', async () => {
    const { onForegroundChange } = await import('../../../../electron/main/ipc');
    const listener = vi.fn();
    onForegroundChange(listener);

    report({ terminalId: 'term-1' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when the report repeats the current id', async () => {
    const { onForegroundChange } = await import('../../../../electron/main/ipc');
    report({ terminalId: 'term-1' });
    const listener = vi.fn();
    onForegroundChange(listener);

    report({ terminalId: 'term-1' });

    expect(listener).not.toHaveBeenCalled();
  });

  /**
   * `onForegroundChange` answers a disposer (HIVE-81 review, finding 11).
   * Before it did, the set was emptied only by the test-only
   * `resetIpcHandlers` — a subscribe with no way out.
   */
  it('stops calling a listener that unsubscribed', async () => {
    const { onForegroundChange } = await import('../../../../electron/main/ipc');
    const listener = vi.fn();
    const unsubscribe = onForegroundChange(listener);

    report({ terminalId: 'term-1' });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    report({ terminalId: 'term-2' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('leaves the recorded id unchanged on a malformed payload, and fires no listener', async () => {
    const { onForegroundChange } = await import('../../../../electron/main/ipc');
    report({ terminalId: 'term-1' });
    const listener = vi.fn();
    onForegroundChange(listener);

    report({ terminalId: 42 });
    report('not an object');
    report({ wrong: 'key' });

    expect(isForeground('term-1')).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});

/**
 * Window focus, the half the renderer cannot publish (HIVE-81 review, finding 4).
 *
 * These were wired as `focus`/`blur` on the **main window only**, while
 * `windowFocused()` counts every window — a mismatch with two opposite failure
 * modes, and the gate has to be immune to both.
 */
describe('window focus drives the re-arm', () => {
  const main = fakeWindow(true);
  const about = fakeWindow(false);

  /** Main focused, About open behind it, `term-1` on the stage. */
  const openWithAbout = (listener: () => void) => {
    windows = [main, about];
    report({ terminalId: 'term-1' });
    onForegroundChange(listener);
  };

  let onForegroundChange: (listener: () => void) => unknown;

  beforeEach(async () => {
    ({ onForegroundChange } = await import('../../../../electron/main/ipc'));
  });

  it('subscribes at the app level, so every window is observed', () => {
    expect(appListeners.get('browser-window-blur')?.size).toBe(1);
    expect(appListeners.get('browser-window-focus')?.size).toBe(1);
  });

  /**
   * The missed promotion. Main focused with a gated pending row → the user
   * opens About (main blurs, About focuses: still foreground, correctly
   * nothing promoted) → the user switches to another application, and it is
   * **About** that blurs. With the listener on the main window only, nothing
   * fired: the still-blocked session kept its already-read row, with no
   * promotion, no toast and no badge, for as long as the user was away. That is
   * precisely the "suppression must not lose a real notification" failure the
   * gate exists to prevent.
   */
  it('fires when the last focused window is the About panel', () => {
    const listener = vi.fn();
    openWithAbout(listener);

    // Open About: main blurs, About takes focus.
    windows = [fakeWindow(false), fakeWindow(true)];
    emitAppEvent('browser-window-blur');
    emitAppEvent('browser-window-focus');
    vi.advanceTimersByTime(1);
    listener.mockClear();

    // Switch to another application. Only About had focus to lose.
    windows = [fakeWindow(false), fakeWindow(false)];
    emitAppEvent('browser-window-blur');
    vi.advanceTimersByTime(1);

    expect(listener).toHaveBeenCalled();
    expect(isForeground('term-1')).toBe(false);
  });

  /**
   * The spurious promotion, which is the hazard the fix above walks into if it
   * is naive. On macOS `blur` on the main window fires **before** `focus` on
   * About, and in that gap no window of ours is focused — so a re-evaluation
   * run synchronously off the blur would promote a gated row and toast about a
   * session the user can see right behind the panel, contradicting
   * `windowFocused`'s own argument for counting About as foreground.
   *
   * The re-evaluation is deferred by a tick, so the focus half has landed by
   * the time the predicate is read.
   */
  it('does not promote in the gap between one window blurring and the next focusing', () => {
    const seen: boolean[] = [];
    openWithAbout(() => seen.push(isForeground('term-1')));

    windows = [fakeWindow(false), fakeWindow(false)];
    emitAppEvent('browser-window-blur');
    // ...and only then does About take it.
    windows = [fakeWindow(false), fakeWindow(true)];
    emitAppEvent('browser-window-focus');
    vi.advanceTimersByTime(1);

    // One evaluation, and it read the settled state: still foreground.
    expect(seen).toEqual([true]);
  });

  it('coalesces a burst of focus events into one evaluation', () => {
    const listener = vi.fn();
    openWithAbout(listener);

    emitAppEvent('browser-window-blur');
    emitAppEvent('browser-window-focus');
    emitAppEvent('browser-window-blur');
    emitAppEvent('browser-window-focus');
    vi.advanceTimersByTime(1);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('drops its app listeners on reset, so a re-registration does not double them', () => {
    resetIpcHandlers();

    expect(appListeners.get('browser-window-blur')?.size).toBe(0);
    expect(appListeners.get('browser-window-focus')?.size).toBe(0);

    registerIpcHandlers();
    expect(appListeners.get('browser-window-blur')?.size).toBe(1);
  });

  /** A pending tick must not outlive the handlers it would call into. */
  it('cancels a deferred evaluation on reset', () => {
    const listener = vi.fn();
    openWithAbout(listener);

    emitAppEvent('browser-window-blur');
    resetIpcHandlers();
    vi.advanceTimersByTime(1);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('the isForeground predicate composed for the notification hub (HIVE-81)', () => {
  const session = (entityId: string) => ({ type: 'session' as const, entityId });

  it('is true for a session action naming the reported terminal while focused', () => {
    report({ terminalId: 'term-1' });

    expect(capturedIsForeground?.(session('term-1'))).toBe(true);
  });

  it('is false while the window is blurred', () => {
    windows = [fakeWindow(false)];
    report({ terminalId: 'term-1' });

    expect(capturedIsForeground?.(session('term-1'))).toBe(false);
  });

  it('is false for a session action naming a different terminal', () => {
    report({ terminalId: 'term-1' });

    expect(capturedIsForeground?.(session('term-2'))).toBe(false);
  });

  it('is false for a non-session action, even while a session is foreground', () => {
    report({ terminalId: 'term-1' });

    expect(capturedIsForeground?.({ type: 'url', url: 'https://example.test' })).toBe(false);
    expect(capturedIsForeground?.({ type: 'none' })).toBe(false);
  });
});

/**
 * `ui:session-name` (HIVE-110) — the renderer telling main what the rail calls
 * a session, so a desktop toast can say the same thing.
 *
 * The inbox row needs none of this; it carries the terminal id and resolves the
 * name from the store. This channel exists for the one consumer that cannot —
 * an OS notification, which is presented once and must say something then.
 */
describe('ui:session-name', () => {
  it('registers as a send (`on`) channel, not invoke', () => {
    expect(onHandlers.has(CH.uiSessionName)).toBe(true);
  });

  it('feeds the resolver the hub composes toast titles from', () => {
    reportName({ terminalId: 'sess-11', name: 'mutex-explanation' });

    expect(capturedSubjectName?.('sess-11')).toBe('mutex-explanation');
  });

  it('answers with the terminal id until a name is reported', () => {
    expect(capturedSubjectName?.('sess-11')).toBe('sess-11');
  });

  it('follows a rename', () => {
    reportName({ terminalId: 'sess-11', name: 'mutex-explanation' });
    reportName({ terminalId: 'sess-11', name: 'HIVE-110-inbox-names' });

    expect(capturedSubjectName?.('sess-11')).toBe('HIVE-110-inbox-names');
  });

  /*
    Rejected rather than sanitised, exactly as `ui:foreground` is: a malformed
    payload must not be coerced into a name that then appears in a toast. The
    guard throws inside `on()`'s wrapper, which logs and drops rather than
    surfacing — so every assertion here is on the state the rejected payload
    failed to change, not on a thrown error.
  */
  it('rejects a payload with an extra key', () => {
    reportName({ terminalId: 'sess-11', name: 'mutex-explanation', extra: 1 });

    expect(capturedSubjectName?.('sess-11')).toBe('sess-11');
  });

  it('rejects a payload missing a key', () => {
    reportName({ terminalId: 'sess-11' });
    reportName({ name: 'mutex-explanation' });

    expect(capturedSubjectName?.('sess-11')).toBe('sess-11');
  });

  it('rejects a non-string name', () => {
    reportName({ terminalId: 'sess-11', name: 42 });

    expect(capturedSubjectName?.('sess-11')).toBe('sess-11');
  });

  it('rejects a non-object payload', () => {
    reportName('sess-11');
    reportName(null);

    expect(capturedSubjectName?.('sess-11')).toBe('sess-11');
  });

  /*
    Capped at the same length the other name producer caps at, because `names.ts`
    claims its map is bounded by the sessions this process has spawned and
    neither half of an unbounded pair would honour that.
  */
  it('rejects a name past the display cap', () => {
    reportName({ terminalId: 'sess-11', name: 'x'.repeat(121) });

    expect(capturedSubjectName?.('sess-11')).toBe('sess-11');
  });

  it('rejects a terminal id past the display cap', () => {
    const long = 'x'.repeat(121);
    reportName({ terminalId: long, name: 'mutex-explanation' });

    expect(capturedSubjectName?.(long)).toBe(long);
  });

  it('accepts a name exactly at the cap', () => {
    const name = 'x'.repeat(120);
    reportName({ terminalId: 'sess-11', name });

    expect(capturedSubjectName?.('sess-11')).toBe(name);
  });
});

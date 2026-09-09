// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An attached server's toasts, raised on this machine (HIVE-145).
 *
 * The inbox row already crossed the socket as an ordinary event push, so the
 * laptop's inbox was always right. What did not arrive was the interruption:
 * the mini raised it on its own desktop, where nobody is. This is the receiving
 * half.
 */

interface FakeNotification {
  title: string;
  body: string;
  shown: boolean;
  click: () => void;
  fail: (error: unknown) => void;
}

const raised: FakeNotification[] = [];
let supported = true;
let windows: {
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  focus: () => void;
}[] = [];

vi.mock('electron', () => {
  class FakeNotificationClass {
    private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    private readonly record: FakeNotification;

    constructor(options: { title: string; body: string }) {
      this.record = {
        title: options.title,
        body: options.body,
        shown: false,
        click: () => this.fire('click'),
        fail: (error: unknown) => this.fire('failed', undefined, error),
      };
      raised.push(this.record);
    }

    static isSupported(): boolean {
      return supported;
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const existing = this.listeners.get(event) ?? [];
      existing.push(listener);
      this.listeners.set(event, existing);
      return this;
    }

    show(): void {
      this.record.shown = true;
    }

    private fire(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }

  return {
    Notification: FakeNotificationClass,
    BrowserWindow: { getAllWindows: () => windows },
  };
});

const { CH } = await import('../../../../electron/shared/ipc-contract');
const { createRemoteToasts } = await import(
  '../../../../electron/main/notifications/remote-toast'
);

const fakeWindow = (over: { minimized?: boolean; destroyed?: boolean } = {}) => {
  const restore = vi.fn();
  const focus = vi.fn();
  return {
    isDestroyed: () => over.destroyed === true,
    isMinimized: () => over.minimized === true,
    restore,
    focus,
    calls: { restore, focus },
  };
};

const toast = {
  id: 'n1',
  kind: 'session.blocked' as const,
  title: 'hero is blocked',
  body: 'waiting on you',
  action: { type: 'session' as const, entityId: 'hero' },
};

let call: ReturnType<typeof vi.fn<(channel: string, payload: unknown) => Promise<unknown>>>;
let toasts: ReturnType<typeof createRemoteToasts>;

beforeEach(() => {
  raised.length = 0;
  supported = true;
  windows = [];
  call = vi.fn<(channel: string, payload: unknown) => Promise<unknown>>(async () => undefined);
  toasts = createRemoteToasts({ call });
});

describe('createRemoteToasts', () => {
  it('raises the server\'s toast on this machine', () => {
    toasts.receive(toast);

    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      title: 'hero is blocked',
      body: 'waiting on you',
      shown: true,
    });
  });

  it('raises nothing when the OS has no notification daemon', () => {
    supported = false;

    toasts.receive(toast);

    expect(raised).toHaveLength(0);
  });

  describe('a click', () => {
    it('focuses this machine\'s window, not the server\'s', () => {
      const window = fakeWindow();
      windows = [window];
      toasts.receive(toast);

      raised[0]!.click();

      expect(window.calls.focus).toHaveBeenCalledTimes(1);
    });

    it('restores a minimised window first, or focusing does nothing visible', () => {
      const window = fakeWindow({ minimized: true });
      windows = [window];
      toasts.receive(toast);

      raised[0]!.click();

      expect(window.calls.restore).toHaveBeenCalledTimes(1);
    });

    it('skips a destroyed window', () => {
      const window = fakeWindow({ destroyed: true });
      windows = [window];
      toasts.receive(toast);

      raised[0]!.click();

      expect(window.calls.focus).not.toHaveBeenCalled();
    });

    it('dismisses the row and activates the action, on the server', () => {
      toasts.receive(toast);

      raised[0]!.click();

      expect(call).toHaveBeenCalledWith(CH.notificationsDismiss, 'n1');
      expect(call).toHaveBeenCalledWith(CH.notificationsAct, toast.action);
    });

    /**
     * An `ask` click reveals the card rather than answering it (HIVE-118).
     * Dismissing would delete the very thing the click was meant to reveal:
     * the ledger entry stays an open ask, the agent stays blocked, and nothing
     * can bring the row back.
     */
    it('does not dismiss an ask', () => {
      toasts.receive({
        ...toast,
        kind: 'agent.ask',
        action: { type: 'ask', thread: 't1' },
      });

      raised[0]!.click();

      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith(CH.notificationsAct, { type: 'ask', thread: 't1' });
    });

    it('swallows a rejection from a socket that dropped', async () => {
      call.mockRejectedValue(new Error('socket closed'));
      toasts.receive(toast);

      expect(() => { raised[0]!.click(); }).not.toThrow();
      await Promise.resolve();
    });
  });

  /**
   * `notifications:act`'s `url` and `update.*` branches are answered on the
   * machine that receives the call, not the one that asked (HIVE-151). They
   * cannot arrive here today — the queue holds only kinds whose actions are
   * fleet-scoped — but that is a property of the caller, not of this code.
   */
  describe('an action that would act on the wrong machine', () => {
    it('drops a url action rather than opening a browser on the server', () => {
      toasts.receive({ ...toast, action: { type: 'url', url: 'https://example.com' } });

      expect(raised).toHaveLength(0);
      expect(call).not.toHaveBeenCalled();
    });

    it('drops an update action rather than driving the server\'s updater', () => {
      toasts.receive({ ...toast, action: { type: 'update.install' } });

      expect(raised).toHaveLength(0);
      expect(call).not.toHaveBeenCalled();
    });

    it('allows the fleet-scoped actions the queue can actually carry', () => {
      toasts.receive({ ...toast, action: { type: 'agent', name: 'scout' } });
      toasts.receive({ ...toast, id: 'n2', action: { type: 'none' } });

      expect(raised).toHaveLength(2);
    });
  });

  /**
   * The one inbound payload this branch takes from the far end. A paired
   * server is more trusted than a renderer and still not a reason to hand
   * whatever arrives straight to the OS.
   */
  describe('a payload that is not a toast', () => {
    it.each([
      ['not an object', 'nope'],
      ['null', null],
      ['no id', { ...toast, id: undefined }],
      ['an empty id', { ...toast, id: '' }],
      ['a non-string title', { ...toast, title: 42 }],
      ['a non-string body', { ...toast, body: {} }],
      ['a kind this build does not know', { ...toast, kind: 'slack.mention' }],
      ['no action', { ...toast, action: undefined }],
      ['an action with no type', { ...toast, action: {} }],
    ])('drops %s', (_label, payload) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      toasts.receive(payload);

      expect(raised).toHaveLength(0);
      expect(call).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('truncates text long enough to be a problem rather than a message', () => {
      toasts.receive({ ...toast, title: 'x'.repeat(900), body: 'y'.repeat(900) });

      // Clipped rather than refused: the interruption is the point, and a
      // clipped title still says which session wants you.
      expect(raised[0]?.title).toHaveLength(512);
      expect(raised[0]?.body).toHaveLength(512);
    });
  });

  it('raises nothing once disposed', () => {
    toasts.dispose();

    toasts.receive(toast);

    expect(raised).toHaveLength(0);
  });

  it('logs one refusal per distinct reason', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    toasts.receive(toast);
    toasts.receive({ ...toast, id: 'n2' });

    raised[0]!.fail('UNErrorDomain error 1');
    raised[1]!.fail('UNErrorDomain error 1');

    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

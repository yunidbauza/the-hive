// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `notifications:delivery` answers, and about which machine (HIVE-151).
 *
 * Both fields describe the OS of the process that answers: whether it supports
 * desktop notifications at all, and why it last turned one down. That was
 * merely odd while the answer always came from the machine the user was
 * sitting at. Since HIVE-145 the toast is raised on the *client's* desktop, so
 * a proxied answer made the settings switch read "desktop notifications are
 * unavailable" about a machine that is no longer the one raising them.
 *
 * Its own module rather than `ipc/index.ts` module scope because
 * `ipc/remote-proxy.ts` has to answer it locally while attached and may not
 * import `ipc/index.ts` — that closes a cycle.
 */

const isSupported = vi.fn(() => true);

vi.mock('electron', () => ({
  Notification: { isSupported: () => isSupported() },
}));

beforeEach(() => {
  vi.resetModules();
  isSupported.mockReturnValue(true);
});

const load = async () =>
  import('../../../../electron/main/notifications/delivery');

describe('notificationDelivery', () => {
  it('reports this OS as supporting notifications, with no refusal yet', async () => {
    const { notificationDelivery } = await load();

    expect(notificationDelivery()).toEqual({ supported: true, refused: null });
  });

  /*
    False on a Linux box with no notification daemon, and read per call rather
    than cached at boot: the daemon can come and go while the app runs.
  */
  it('reports unsupported where there is no daemon', async () => {
    isSupported.mockReturnValue(false);
    const { notificationDelivery } = await load();

    expect(notificationDelivery().supported).toBe(false);
  });

  it('reads support live rather than caching the first answer', async () => {
    const { notificationDelivery } = await load();

    expect(notificationDelivery().supported).toBe(true);
    isSupported.mockReturnValue(false);
    expect(notificationDelivery().supported).toBe(false);
  });
});

describe('recordNotificationRefusal', () => {
  it('remembers the reason the OS gave', async () => {
    const { notificationDelivery, recordNotificationRefusal } = await load();

    recordNotificationRefusal('UNErrorDomain error 1');

    expect(notificationDelivery().refused).toBe('UNErrorDomain error 1');
  });

  /*
    The return value is what lets the caller log once per distinct reason
    rather than once per dropped notification — a fleet of blocked sessions
    would otherwise fill a terminal with the same line.
  */
  it('answers true for a new reason and false for a repeat', async () => {
    const { recordNotificationRefusal } = await load();

    expect(recordNotificationRefusal('UNErrorDomain error 1')).toBe(true);
    expect(recordNotificationRefusal('UNErrorDomain error 1')).toBe(false);
    expect(recordNotificationRefusal('UNErrorDomain error 1')).toBe(false);
  });

  it('takes a different reason as new, and reports the latest', async () => {
    const { notificationDelivery, recordNotificationRefusal } = await load();

    expect(recordNotificationRefusal('first')).toBe(true);
    expect(recordNotificationRefusal('second')).toBe(true);
    expect(notificationDelivery().refused).toBe('second');
  });

  /*
    Never reset. A refusal is not transient in the case that produces it — an
    unsigned bundle stays unsigned for the life of the process — and clearing
    it on the next successful send would make the settings pane flicker
    between two accounts of the same system.
  */
  it('never clears a refusal once one has happened', async () => {
    const { notificationDelivery, recordNotificationRefusal } = await load();

    recordNotificationRefusal('UNErrorDomain error 1');
    isSupported.mockReturnValue(true);

    expect(notificationDelivery().refused).toBe('UNErrorDomain error 1');
  });
});

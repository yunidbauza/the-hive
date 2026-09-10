// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CH } from '../../../../electron/shared/ipc-contract';
import type { NotificationAction } from '../../../../electron/shared/notification-contract';
import { createToastRoute } from '../../../../electron/main/notifications/toast-route';
import type { Surface, SurfaceId } from '../../../../electron/main/ipc/surfaces';

/**
 * Where a toast actually goes (HIVE-145).
 *
 * The hub decides *whether* a notification is worth interrupting for — prefs,
 * delivery, supersede — and that decision stays on the server, where the hub
 * is. This decides *who* is interrupted, which is a different question the
 * moment there is more than one surface, and which the hub is deliberately
 * ignorant of.
 */

const session = (entityId: string): NotificationAction => ({ type: 'session', entityId });

let sent: [SurfaceId, string, unknown][];
let live: Surface[];
type Present = (options: { title: string; body: string; onClick: () => void }) => void;
let present: ReturnType<typeof vi.fn<Present>>;
let queued: unknown[];
let foregroundFor: (surfaceId: SurfaceId, terminalId: string) => boolean;
/** Whether this machine has a window of its own — see the empty-room branch. */
let hasWindow: boolean;

const surface = (id: SurfaceId, kind: 'window' | 'socket'): Surface => ({
  id,
  kind,
  send: (channel, payload) => sent.push([id, channel, payload]),
});

const route = () =>
  createToastRoute({
    surfaces: () => live,
    isForegroundFor: (surfaceId, terminalId) => foregroundFor(surfaceId, terminalId),
    present,
    queue: (payload) => queued.push(payload),
    hasWindow: () => hasWindow,
  });

const toast = {
  id: 'n1',
  kind: 'session.blocked' as const,
  title: 'hero is blocked',
  body: 'waiting on you',
  action: session('hero'),
  onClick: () => undefined,
};

beforeEach(() => {
  sent = [];
  queued = [];
  present = vi.fn<Present>();
  foregroundFor = () => false;
  hasWindow = false;
  live = [surface('sock-a', 'socket')];
});

describe('createToastRoute', () => {
  it('sends a socket surface the toast event rather than presenting locally', () => {
    route()(toast);

    expect(sent).toEqual([
      [
        'sock-a',
        CH.notificationsToast,
        {
          id: 'n1',
          kind: 'session.blocked',
          title: 'hero is blocked',
          body: 'waiting on you',
          action: session('hero'),
        },
      ],
    ]);
    // The whole point: the mini does not raise a toast on a desktop nobody is at.
    expect(present).not.toHaveBeenCalled();
  });

  it('presents locally for a window surface', () => {
    live = [surface('win', 'window')];

    route()(toast);

    expect(present).toHaveBeenCalledExactlyOnceWith({
      title: 'hero is blocked',
      body: 'waiting on you',
      onClick: toast.onClick,
    });
    expect(sent).toEqual([]);
  });

  it('reaches both a local window and an attached client at once', () => {
    live = [surface('win', 'window'), surface('sock-a', 'socket')];

    route()(toast);

    expect(present).toHaveBeenCalledTimes(1);
    expect(sent.map(([id]) => id)).toEqual(['sock-a']);
  });

  it('carries no callback over the wire', () => {
    route()(toast);

    const [, , payload] = sent[0]!;
    expect(payload).not.toHaveProperty('onClick');
  });

  describe('per-surface suppression', () => {
    it('skips only the surface already looking at that session', () => {
      live = [surface('sock-a', 'socket'), surface('sock-b', 'socket')];
      foregroundFor = (surfaceId) => surfaceId === 'sock-b';

      route()(toast);

      /*
        The reason suppression had to move per surface. One value said "someone
        is watching this", so device A — in another room, in another app — got
        nothing because device B happened to have the tab open.
      */
      expect(sent.map(([id]) => id)).toEqual(['sock-a']);
    });

    it('sends to nobody when every surface is watching it', () => {
      live = [surface('sock-a', 'socket'), surface('sock-b', 'socket')];
      foregroundFor = () => true;

      route()(toast);

      expect(sent).toEqual([]);
      expect(queued).toEqual([]);
    });

    it('asks about the action\'s own session, not some other', () => {
      const seen: [SurfaceId, string][] = [];
      foregroundFor = (surfaceId, terminalId) => {
        seen.push([surfaceId, terminalId]);
        return false;
      };

      route()(toast);

      expect(seen).toEqual([['sock-a', 'hero']]);
    });

    it('never suppresses a notification that is about no session', () => {
      foregroundFor = () => true;

      route()({ ...toast, action: { type: 'none' } });

      expect(sent).toHaveLength(1);
    });
  });

  describe('a notification raised into an empty room', () => {
    it('queues rather than firing at nobody', () => {
      live = [];

      route()(toast);

      expect(queued).toEqual([
        {
          id: 'n1',
          kind: 'session.blocked',
          title: 'hero is blocked',
          body: 'waiting on you',
          action: session('hero'),
        },
      ]);
      expect(present).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    /**
     * An empty registry is not proof of an empty room, and treating it as one
     * lost real notifications.
     *
     * A surface registers lazily, on its first report, so a freshly launched
     * app has a window and no surface for as long as the renderer takes to
     * mount; and on macOS the app outlives its window, at which point the
     * surface is untracked while the machine is still in front of someone.
     * Everything outside `TOAST_QUEUE_KINDS` was being swallowed in both.
     */
    it('presents locally when this machine has a window but no surface yet', () => {
      live = [];
      hasWindow = true;

      route()(toast);

      expect(present).toHaveBeenCalledTimes(1);
      expect(queued).toEqual([]);
    });

    it('queues only for a machine with no window at all', () => {
      live = [];
      hasWindow = false;

      route()(toast);

      expect(present).not.toHaveBeenCalled();
      expect(queued).toHaveLength(1);
    });

    it('does not lose a kind the queue would refuse', () => {
      live = [];
      hasWindow = true;

      // `pr.merged` is not a `TOAST_QUEUE_KINDS` member, so before this the
      // queue swallowed it and nothing raised it anywhere.
      route()({ ...toast, kind: 'pr.merged', action: { type: 'none' } });

      expect(present).toHaveBeenCalledTimes(1);
    });

    it('does not queue when a surface exists but is watching the session', () => {
      foregroundFor = () => true;

      route()(toast);

      // Not lost, and not queued: somebody saw it. The queue is for the case
      // where there was nobody to see it at all.
      expect(queued).toEqual([]);
    });
  });

  /**
   * The hazard that made this dedupe necessary.
   *
   * A row raised while some surface is watching is held by the notifier's
   * `pendingForeground` and promoted when that surface looks away. Without a
   * record of who has already been interrupted, the promotion would toast every
   * surface a second time — so the device that was never watching, and was
   * correctly toasted at raise time, would be interrupted twice about one event.
   */
  describe('a promotion after a surface looks away', () => {
    it('toasts only the surface that had been watching', () => {
      live = [surface('sock-a', 'socket'), surface('sock-b', 'socket')];
      foregroundFor = (surfaceId) => surfaceId === 'sock-b';
      const send = route();

      send(toast);
      expect(sent.map(([id]) => id)).toEqual(['sock-a']);

      // B looks away and the notifier promotes the held row.
      foregroundFor = () => false;
      send(toast);

      expect(sent.map(([id]) => id)).toEqual(['sock-a', 'sock-b']);
    });

    it('does not re-toast a surface for the same notification', () => {
      const send = route();

      send(toast);
      send(toast);

      expect(sent).toHaveLength(1);
    });

    it('treats a different notification as a different interruption', () => {
      const send = route();

      send(toast);
      send({ ...toast, id: 'n2' });

      expect(sent).toHaveLength(2);
    });

    it('does not re-present to a local window either', () => {
      live = [surface('win', 'window')];
      const send = route();

      send(toast);
      send(toast);

      expect(present).toHaveBeenCalledTimes(1);
    });

    it('toasts a surface that attached after the first delivery', () => {
      const send = route();
      send(toast);

      live = [surface('sock-a', 'socket'), surface('sock-b', 'socket')];
      send(toast);

      expect(sent.map(([id]) => id)).toEqual(['sock-a', 'sock-b']);
    });
  });
});

/**
 * An update announcement never leaves the machine it is about (HIVE-151).
 *
 * Every other kind describes the *fleet* and is equally true wherever it is
 * read. These two describe **this binary**: which release this app found, and
 * whether this app has it downloaded. Since HIVE-151 the click is answered by
 * the machine that made it, so a toast carried to an attached client would
 * drive that client's updater about a version its own checker has not found —
 * `download()` returns silently when `availableVersion` is `null`, and
 * `install()` opens a release page instead of installing.
 *
 * The row still crosses. Only the interruption, whose click promises something
 * this machine cannot honestly do, stops here.
 */
describe('an update announcement and a socket surface', () => {
  const update = (kind: 'app.update_available' | 'app.update_ready') => ({
    id: `u-${kind}`,
    kind,
    title: 'A new version is available',
    body: '0.11.0',
    action: { type: 'update.download' as const },
    onClick: () => undefined,
  });

  it.each(['app.update_available', 'app.update_ready'] as const)(
    'does not send %s to a socket surface',
    (kind) => {
      live = [surface('sock-a', 'socket')];

      route()(update(kind));

      expect(sent).toEqual([]);
      expect(present).not.toHaveBeenCalled();
    },
  );

  it.each(['app.update_available', 'app.update_ready'] as const)(
    'still presents %s on this machine’s own window',
    (kind) => {
      live = [surface('win-a', 'window')];

      route()(update(kind));

      expect(present).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([]);
    },
  );

  it('still sends every other kind to a socket surface', () => {
    live = [surface('sock-a', 'socket')];

    route()(toast);

    expect(sent).toHaveLength(1);
  });

  /*
    A mixed room: the window beside it is still interrupted. The rule is about
    where the toast would *land*, not about suppressing the announcement.
  */
  it('interrupts the local window while sparing the socket', () => {
    live = [surface('win-a', 'window'), surface('sock-a', 'socket')];

    route()(update('app.update_available'));

    expect(present).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });
});

import { CH } from '@shared/ipc-contract';
import type {
  NotificationKind,
  ToastPayload,
} from '@shared/notification-contract';

import type { Surface, SurfaceId } from '../ipc/surfaces';

import type { NotificationPresenter } from './hub';

/**
 * The kinds whose subject is **this binary** rather than the fleet (HIVE-151).
 *
 * A set rather than a predicate on the action, because what makes these two
 * special is the thing they are *about*, not the verb their click happens to
 * carry. An `app.update_available` row whose action were later changed to a
 * `url` would still be an announcement about one machine's release.
 */
const UPDATE_KINDS: ReadonlySet<NotificationKind> = new Set([
  'app.update_available',
  'app.update_ready',
]);

/**
 * Where a toast goes (HIVE-145).
 *
 * ## The two questions, and why they are not the same one
 *
 * The hub decides **whether** a notification is worth interrupting for: the
 * user's per-kind delivery preference, supersession, whether the row is a
 * duplicate. That is a fact about the notification, it stays where the hub is,
 * and none of it changes here.
 *
 * This decides **who** is interrupted. That was not a question at all while
 * there was one renderer: the answer was "the window", and the hub called
 * Electron's `Notification` directly. Two things broke it. A served Mac raises
 * a toast on a desktop nobody is at, so the inbox row reached the laptop and
 * the interruption did not. And with two devices attached, "is the user already
 * looking at this session" stopped having one answer.
 *
 * ## Suppression is per surface
 *
 * A surface staring at the session gets nothing; a surface that is not gets a
 * toast. That dissolves the any-versus-every ambiguity the single
 * `foregroundTerminalId` left behind — there is no need to decide whether one
 * device watching should silence the other, because each is asked about itself.
 *
 * ## Why it remembers who it has already told
 *
 * A row raised while some surface is watching is held by the notifier's
 * `pendingForeground` and promoted when that surface looks away. Promotion
 * calls this again with the same notification. Without a record of who has
 * already been interrupted, the surface that was never watching — and was
 * correctly toasted the first time — would be interrupted twice about one
 * event.
 */
export interface ToastRouteOptions {
  /** Who is live, resolved per toast: a client attaches whenever it likes. */
  surfaces: () => readonly Surface[];
  /** Is *this* surface already looking at that terminal — `ipc/index.ts`. */
  isForegroundFor: (surfaceId: SurfaceId, terminalId: string) => boolean;
  /** Raise one on this machine's own desktop. Electron's `Notification`. */
  present: (options: { title: string; body: string; onClick: () => void }) => void;
  /** Nobody is looking. Hold it for whoever attaches next (HIVE-145). */
  queue: (payload: ToastPayload) => void;
  /**
   * Does this machine have a window of its own right now?
   *
   * Not the same question as "is a surface registered". A surface registers
   * *lazily*, on its first report — `ui:foreground`, `pty:ack`, `pty:prompt`,
   * `fs:watch` — so a freshly launched app has a window and no surface for as
   * long as it takes the renderer to mount. Asking `BrowserWindow` directly is
   * what tells those two states apart.
   */
  hasWindow: () => boolean;
}

/**
 * How many notifications' delivery records to keep.
 *
 * Comfortably above the hub's own buffer cap, so an entry is never evicted
 * while the row it belongs to can still be promoted — an eviction would let the
 * promotion re-toast a surface that had already been told. Oldest first, and
 * bounded at all because a long-running server raises notifications for weeks.
 */
const DELIVERY_MEMORY = 512;

export function createToastRoute(options: ToastRouteOptions): NotificationPresenter {
  const { surfaces, isForegroundFor, present, queue, hasWindow } = options;

  /** Notification id → the surfaces already interrupted about it. */
  const delivered = new Map<string, Set<SurfaceId>>();

  const remember = (id: string, surfaceId: SurfaceId): void => {
    const already = delivered.get(id);
    if (already !== undefined) {
      already.add(surfaceId);
      return;
    }
    delivered.set(id, new Set([surfaceId]));
    // Insertion-ordered, so the first key is the oldest.
    while (delivered.size > DELIVERY_MEMORY) {
      const oldest = delivered.keys().next().value;
      if (oldest === undefined) break;
      delivered.delete(oldest);
    }
  };

  return ({ id, kind, title, body, action, onClick }) => {
    const live = surfaces();

    /*
      No surface — not "no surface that wants it". A surface watching the
      session has *seen* this, so there is nothing to hold for it; an empty room
      means the interruption would land nowhere and be gone. That is the
      distinction the queue exists on.

      But an empty registry is not proof of an empty room, and treating it as
      one lost real notifications (ship's whole-branch review). A surface
      registers lazily, on its first report, so a freshly launched app has a
      window and no surface for as long as the renderer takes to mount; and on
      macOS the app outlives its window, at which point the surface is untracked
      while the machine is still very much in front of someone. In both, the
      old behaviour — raise it here — is right, and the queue would have
      swallowed everything outside `TOAST_QUEUE_KINDS` entirely.

      So the queue is for a machine with no window *at all*: a served mini,
      which is the only place "nobody is looking" is a fact rather than an
      inference.
    */
    if (live.length === 0) {
      if (hasWindow()) present({ title, body, onClick });
      else queue({ id, kind, title, body, action });
      return;
    }

    for (const surface of live) {
      /*
        Only a `session` action can be "the thing you are already looking at".
        Every other kind — a PR, an update, an ask — is about something no
        terminal is showing, so no surface can be watching it and none is
        suppressed.
      */
      if (action.type === 'session' && isForegroundFor(surface.id, action.entityId)) continue;
      if (delivered.get(id)?.has(surface.id) === true) continue;

      /*
        An update announcement never leaves the machine it is about (HIVE-151).

        Every other kind describes the *fleet* — a session, an agent, a PR — and
        so is equally true wherever it is read. These two describe **this
        binary**: which release this app found, and whether this app has it
        downloaded. Since HIVE-151 the click is answered by the machine that
        made it, so a toast carried to an attached client would drive that
        client's updater about a version its own checker has not found — a
        silent no-op from `download()`, or `install()` opening a release page
        instead of installing. Before that routing it was worse rather than
        better: the click quit and replaced the *server* the client was
        attached to.

        The **row** still crosses, as every row does. "The mini has an update"
        is worth knowing from the laptop; it is only the interruption, whose
        click promises an action this machine cannot honestly perform, that
        stops here. Acting on it is done at the mini, or from its own row.
      */
      if (surface.kind !== 'window' && UPDATE_KINDS.has(kind)) continue;

      remember(id, surface.id);

      if (surface.kind === 'window') {
        present({ title, body, onClick });
      } else {
        /*
          `onClick` does not cross. The receiving main process raises the
          notification itself and, on a click, sends the same two effects this
          closure has — activate the action, dismiss the row — back over the
          channels that already exist for them.
        */
        surface.send(CH.notificationsToast, { id, kind, title, body, action } satisfies ToastPayload);
      }
    }
  };
}

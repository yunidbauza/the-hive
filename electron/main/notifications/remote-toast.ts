import { app, Notification } from 'electron';

import { CH, type Channel } from '@shared/ipc-contract';
import {
  isNotificationKind,
  isThisMachineAction,
  type ThisMachineAction,
  type ToastPayload,
} from '@shared/notification-contract';

import { focusThisMachine } from './activate-here';
import { recordNotificationRefusal } from './delivery';

/**
 * Raise an attached server's toasts on **this** machine (HIVE-145).
 *
 * ## The half of the link this closes
 *
 * A served Mac decides a session is blocked and raises the toast on its own
 * desktop, where nobody is. The inbox row already crossed the socket — it is an
 * ordinary `event` push — so the laptop's inbox filled up correctly and the
 * interruption, which is the whole point of a notification, did not arrive.
 *
 * The server's router now sends `notifications:toast` instead of raising it,
 * and this is what receives it. Nothing about the *decision* moved: prefs,
 * delivery and suppression are all still the server's, because that is where
 * the hub and the fleet are.
 *
 * ## Why main and not the renderer
 *
 * An Electron `Notification` is a main-process object. The renderer could not
 * raise one if it wanted to, which is also why `notifications:toast` is absent
 * from `EVENT_CHANNELS` — the array of what main pushes to a renderer.
 *
 * ## What a click does, and the one channel it must not use
 *
 * The same two things a local toast's click does: activate the action and
 * dismiss the row — except for an `ask`, whose click reveals the card rather
 * than answering it, and dismissing would delete the thing the click was
 * meant to reveal (HIVE-118).
 *
 * Both go back over the socket through the channels that already exist, because
 * the row and the fleet are on the server. The window focus is the one part
 * that stays here: it is this machine's window the user needs raised.
 */

export interface RemoteToasts {
  /**
   * One toast frame arrived from the server.
   *
   * `unknown`, not {@link ToastPayload}: this is the branch's only inbound
   * payload from the far end, and the type says what the *contract* promises,
   * not what arrived on the socket. Guarded below.
   */
  receive(payload: unknown): void;
  dispose(): void;
}

/**
 * A toast title or body long enough to be a problem rather than a message.
 *
 * Generous — a real one is a sentence — and present because an attached server
 * puts these straight onto the user's desktop. Truncated rather than refused:
 * the interruption is the point, and a clipped title still tells the user
 * which session wants them.
 */
const TOAST_TEXT_MAX = 512;

/** Everything this can act on, checked rather than assumed. */
function asToast(payload: unknown): ToastPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as Partial<ToastPayload>;
  if (typeof candidate.id !== 'string' || candidate.id === '') return null;
  if (typeof candidate.title !== 'string') return null;
  if (typeof candidate.body !== 'string') return null;
  if (!isNotificationKind(candidate.kind)) return null;
  const { action } = candidate;
  if (typeof action !== 'object' || action === null) return null;
  if (typeof (action as { type?: unknown }).type !== 'string') return null;
  return {
    id: candidate.id,
    kind: candidate.kind,
    title: candidate.title.slice(0, TOAST_TEXT_MAX),
    body: candidate.body.slice(0, TOAST_TEXT_MAX),
    action: action as ToastPayload['action'],
  };
}

export interface RemoteToastOptions {
  /** Call a channel on the attached server — `RemoteClient.call`. */
  call: (channel: Channel, payload: unknown) => Promise<unknown>;
  /**
   * Carry out an action that belongs to **this** machine (HIVE-151).
   *
   * `activateOnThisMachine`, injected rather than imported, so this module
   * keeps the one dependency it had and its test can prove which of the two
   * paths a click took without mocking a browser.
   */
  activateHere: (action: ThisMachineAction) => void;
}

export function createRemoteToasts(options: RemoteToastOptions): RemoteToasts {
  const { call, activateHere } = options;
  let disposed = false;

  return {
    receive(incoming) {
      if (disposed) return;

      /*
        Guarded, like every other inbound payload in this codebase —
        `ui:foreground` and `ui:session-name` both reject rather than sanitise,
        the latter explicitly because "without a bound on either half of the
        pair that claim would rest on the renderer behaving". The far end here
        is a paired server rather than a renderer, which is *more* trusted and
        still not a reason to hand whatever arrives to the OS.
      */
      const toast = asToast(incoming);
      if (toast === null) {
        console.warn('[hive] dropped a malformed remote toast');
        return;
      }
      const { id, title, body, action } = toast;

      // False on a Linux box with no notification daemon, and checked per send
      // rather than once at boot: the daemon can come and go while the app runs,
      // and constructing one when unsupported throws.
      if (!Notification.isSupported()) return;

      const notification = new Notification({ title, body });

      notification.on('click', () => {
        /*
          Routed by the action, not by the channel (HIVE-151).

          This used to be an allowlist that *dropped* anything it did not
          recognise, because a `url` sent back over the socket would open a
          browser on the server and an `update.*` would drive the server's
          updater. `ACTION_SCOPE` answers that now, and the answer is better
          than a drop: a `url` clicked here opens a browser here, which is
          what the person who clicked it wanted.

          **The dismiss still crosses.** Only the *action* belongs to this
          machine; the row belongs to the server's hub either way, and a click
          is a click. The two other paths to the same notification both
          dismiss — `hub.ts`'s local presenter, and the inbox row in
          `notification-card.tsx` — so skipping it here would make one
          notification mean two different things depending on where it was
          clicked, which is exactly what `toast-route.ts`'s own contract
          comment forbids. The row would sit unread for ever, and `seen` would
          block any re-raise.

          `activateHere` focuses this machine itself, so there is no focus call
          on this arm.
        */
        if (isThisMachineAction(action)) {
          void call(CH.notificationsDismiss, id).catch(() => undefined);
          activateHere(action);
          return;
        }

        focusThisMachine();
        /*
          Fire-and-forget, and the rejection is swallowed on purpose: a socket
          that dropped between the toast and the click is a click that does
          nothing, which is what the user sees anyway. Throwing out of an
          Electron event listener would be an unhandled rejection in main with
          nobody to catch it.
        */
        if (action.type !== 'ask') {
          void call(CH.notificationsDismiss, id).catch(() => undefined);
        }
        void call(CH.notificationsAct, action).catch(() => undefined);
      });

      /*
        Recorded, not merely logged (HIVE-151).

        This is the **only** presenter that runs while attached —
        `registerIpcHandlers` is not registered in remote mode, so `hub.ts`'s
        `presentLocally`, which used to be the sole writer, never runs. Now
        that `notifications:delivery` is answered by this process rather than
        proxied, a refusal that only reached a console line would leave
        `refused` structurally `null` on every attached client: the settings
        pane would report the right machine's `supported` and be blind about
        the same machine's refusals, which is the dishonesty the move to
        `PROCESS_LOCAL` was meant to end rather than relocate.

        The shared recorder is also what keeps the log once-per-distinct-reason
        without a second copy of that state to disagree with the first.
      */
      notification.on('failed', (_event, error) => {
        const reason = String(error);
        if (!recordNotificationRefusal(reason)) return;
        console.error(
          `[hive] the OS refused a desktop notification from the attached server (${reason})`,
        );
      });

      notification.show();

      /*
        This machine's dock, bounced alongside the toast (HIVE-159).

        The local presenter (`presentLocally` in `ipc/index.ts`) has always
        bounced once after every toast it raises, because the dock still
        reaches someone when the OS refuses the toast. While attached that
        presenter never runs here, and the server's router sends the toast
        across instead of raising it, so its bounce never ran for this machine
        at all. `informational` for that presenter's reason: once, not until
        the app is activated.
      */
      app.dock?.bounce('informational');
    },

    dispose() {
      disposed = true;
    },
  };
}

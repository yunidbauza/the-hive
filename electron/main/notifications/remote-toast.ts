import { BrowserWindow, Notification } from 'electron';

import { CH, type Channel } from '@shared/ipc-contract';
import type { NotificationAction, ToastPayload } from '@shared/notification-contract';

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

/**
 * Actions whose click is answered on the machine that *receives* the call
 * rather than the one that asked (HIVE-151).
 *
 * `url` reaches `shell.openExternal` and `update.*` reach this process's own
 * updater singleton, so sending either over the socket opens a browser on the
 * server or drives the wrong updater. They are unreachable from here today —
 * the toast queue holds only `session.blocked`, `session.input_needed`,
 * `agent.ask` and `agent.permission`, whose actions are `session`, `ask` and
 * `agent`, all legitimately fleet-scoped — but "unreachable by which kinds
 * happen to arrive" is a property of the caller, not of this code.
 *
 * So it is checked rather than assumed. HIVE-151 is what makes the routing
 * right by construction; until it lands, a toast carrying one of these is
 * dropped with a line saying so rather than acted on against the wrong machine.
 */
const SERVER_SCOPED: readonly NotificationAction['type'][] = [
  'session',
  'ask',
  'agent',
  'none',
];

export interface RemoteToasts {
  /** One toast frame arrived from the server. */
  receive(payload: ToastPayload): void;
  dispose(): void;
}

export interface RemoteToastOptions {
  /** Call a channel on the attached server — `RemoteClient.call`. */
  call: (channel: Channel, payload: unknown) => Promise<unknown>;
}

/**
 * Any window of ours, restored and focused — the same thing the local
 * `activate` does, and for the same reason: a minimised window that is merely
 * focused does nothing visible.
 */
function focusThisMachine(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    if (window.isMinimized()) window.restore();
    window.focus();
  }
}

export function createRemoteToasts(options: RemoteToastOptions): RemoteToasts {
  const { call } = options;
  /** Logged once per distinct reason, as the local presenter does. */
  let refusal: string | null = null;
  let disposed = false;

  return {
    receive({ id, title, body, action }) {
      if (disposed) return;

      if (!SERVER_SCOPED.includes(action.type)) {
        console.warn(
          `[hive] dropped a remote toast whose ${action.type} action would act on the ` +
            'wrong machine — see HIVE-151',
        );
        return;
      }

      // False on a Linux box with no notification daemon, and checked per send
      // rather than once at boot: the daemon can come and go while the app runs,
      // and constructing one when unsupported throws.
      if (!Notification.isSupported()) return;

      const notification = new Notification({ title, body });

      notification.on('click', () => {
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

      notification.on('failed', (_event, error) => {
        const reason = String(error);
        if (refusal === reason) return;
        refusal = reason;
        console.error(
          `[hive] the OS refused a desktop notification from the attached server (${reason})`,
        );
      });

      notification.show();
    },

    dispose() {
      disposed = true;
      refusal = null;
    },
  };
}

import { Notification } from 'electron';

import type { NotificationDeliveryStatus } from '@shared/ipc-contract';

/**
 * Whether desktop notifications reach anyone on **this** machine (HIVE-151).
 *
 * Both facts this module holds are about the OS of the process that answers,
 * and the settings pane polls them to decide what its switch may honestly
 * claim. That was unremarkable while the answer always came from the machine
 * the user was sitting at. Since HIVE-145 the toast is raised on the
 * *client's* desktop, so proxying this made the pane describe a machine that
 * is no longer the one raising them — a switch reading "desktop notifications
 * are unavailable" about the wrong desktop.
 *
 * Its own module rather than `ipc/index.ts` module scope, for the reason
 * `electron/main/updates/index.ts` is one: `ipc/remote-proxy.ts` has to answer
 * `notifications:delivery` locally while attached, and it may not import
 * `ipc/index.ts` — that closes a cycle `import/no-cycle` refuses. A leaf both
 * sides import instead, holding no per-registration state, so a mode switch
 * neither resets nor duplicates it.
 */

/**
 * Why the OS turned the last desktop notification down, or `null`.
 *
 * `show()` is fire-and-forget and its refusal arrives on an event nothing was
 * listening to. Measured on macOS 15 / Electron 43.2.0: `isSupported()`
 * returns `true`, the `failed` event fires with `UNErrorDomain error 1` — not
 * authorized — and the app carried on reporting desktop delivery as available
 * while every "System" notification was dropped in silence.
 *
 * Never reset. A refusal is not transient in the case that produces it — an
 * unsigned bundle stays unsigned for the life of the process — and clearing it
 * on the next successful send would mean the settings pane flickered between
 * two accounts of the same system.
 */
let systemNotificationRefusal: string | null = null;

/**
 * What `notifications:delivery` answers, about this machine's OS.
 *
 * `supported` is read live rather than cached at boot: a notification daemon
 * can come and go while the app runs.
 */
export function notificationDelivery(): NotificationDeliveryStatus {
  return {
    supported: Notification.isSupported(),
    refused: systemNotificationRefusal,
  };
}

/**
 * Record a refusal the OS reported.
 *
 * Answers whether it was a *new* reason, so the caller can log once per
 * distinct one rather than once per dropped notification — a fleet of blocked
 * sessions would otherwise fill a terminal with the same line.
 */
export function recordNotificationRefusal(reason: string): boolean {
  if (systemNotificationRefusal === reason) return false;
  systemNotificationRefusal = reason;
  return true;
}

import { app } from 'electron';

/**
 * This machine's dock badge, and the one place that writes it (HIVE-159).
 *
 * ## Two writers, never at once
 *
 * The count is a fleet fact since HIVE-154, but the badge is a fact about one
 * screen: it should say how many unread rows the inbox *on this machine* is
 * showing. Which process can know that depends on the mode.
 *
 * - **Local.** The hub runs here and counts its own buffer, so it writes the
 *   badge directly, exactly as it always has. On a *serving* machine it does
 *   not: every attached client badges its own dock, and the server's dock is
 *   hidden besides (`electron/main/index.ts`, `app.dock?.hide()`).
 * - **Attached.** No hub runs here at all — `registerIpc('remote')` swaps the
 *   whole handler set for the proxy — so the count the server's hub computes
 *   never reaches this process. The renderer derives the same count from the
 *   rows it already receives (`useUnreadCount`) and reports it on
 *   `notifications:badge`, which is `PROCESS_LOCAL` for exactly this reason.
 *
 * ## Electron's contract
 *
 * An empty string clears the badge; `'0'` would not. A badge reading `0` is a
 * worse lie than no badge, because it says the app has something to report and
 * the something is nothing. Off macOS `app.dock` is undefined and every call
 * here is a no-op.
 */

/**
 * Write `count` onto this machine's dock.
 *
 * `unknown`, because one caller is an IPC payload from a renderer: a count that
 * is not a non-negative integer is dropped rather than coerced, the way
 * `ui:foreground` and `ui:session-name` refuse rather than sanitise.
 */
export function badgeDock(count: unknown): void {
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return;
  app.dock?.setBadge(count > 0 ? String(count) : '');
}

/** Take the badge off this machine's dock. */
export function clearDockBadge(): void {
  app.dock?.setBadge('');
}

/**
 * Clear the badge when the last window closes, until the returned function is
 * called (HIVE-159).
 *
 * Attached mode only. macOS keeps the app alive with no window, and with the
 * renderer gone nothing is left to keep the reported count current, so it
 * would stand unchanged while the server's inbox moved on. No inbox on screen
 * is no count to show; reopening a window mounts a renderer that reports again.
 *
 * Local mode needs none of this: the hub outlives the window and goes on
 * counting, which is the standalone behaviour the badge has always had.
 */
export function clearDockBadgeWithLastWindow(): () => void {
  app.on('window-all-closed', clearDockBadge);
  return () => {
    app.removeListener('window-all-closed', clearDockBadge);
  };
}

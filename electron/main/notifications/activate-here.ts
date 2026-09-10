import { BrowserWindow, shell } from 'electron';

import type { ThisMachineAction } from '@shared/notification-contract';

import { isSafeExternalUrl } from '../external-links';
import { downloadUpdate, installUpdate } from '../updates';

/**
 * The half of a notification's activation that belongs to the machine whose
 * user clicked (HIVE-151).
 *
 * `notifications:act` carries seven verbs on one channel. Three of them reach
 * *hardware* — a browser, this process's updater — so whichever process runs
 * them is the machine they happen on. While attached that was the server, and
 * the click was on the client: a `url` opened a browser on a Mac mini in
 * another room, and `update.install` would have quit the wrong app.
 *
 * Its own module rather than a closure inside `registerIpcHandlers`, for the
 * reason `electron/main/updates/index.ts` is one: `ipc/remote-proxy.ts` has to
 * run these while attached, and it may not import `ipc/index.ts` — that closes
 * a cycle `import/no-cycle` refuses. Nothing here is per-registration state
 * (`BrowserWindow` and `shell` are Electron's, the updater is a module
 * singleton), so a leaf both sides import is the honest shape rather than a
 * value handed down through `router.ts` the way `localAppInfo` must be.
 */

/**
 * Any window of ours, restored and focused.
 *
 * A minimised window that is merely focused does nothing visible, so the
 * restore comes first — otherwise a click on a notification lands nowhere the
 * user can see. Shared by the local activation and the remote toast rather
 * than written twice, which is what it was before this module existed.
 */
export function focusThisMachine(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    if (window.isMinimized()) window.restore();
    window.focus();
  }
}

/**
 * Carry a notification action out on **this** machine.
 *
 * The parameter is {@link ThisMachineAction}, not the whole union, and that is
 * the point of the split rather than tidiness: these branches reach hardware,
 * and a fleet action reaching them would be the very defect this module exists
 * to remove. `ACTION_SCOPE` decides which is which, and the type makes handing
 * in the wrong one a compile error instead of a runtime check that somebody
 * has to remember to write.
 */
export function activateOnThisMachine(action: ThisMachineAction): void {
  /*
    Main focuses the window; the renderer opens the session. Split that way
    because only main can raise a window and only the renderer knows what
    opening a session means. Every branch below wants the window forward, so
    this runs before the switch rather than inside each arm.
  */
  focusThisMachine();

  /**
   * A `url` action goes to the user's browser, through the same allowlist
   * every other outbound link uses (story 081).
   *
   * `isSafeExternalUrl` is not optional politeness here: `shell.openExternal`
   * will happily launch a `file:` URL or a custom scheme registered by some
   * other application, and a notification's URL is data rather than a
   * constant.
   */
  if (action.type === 'url') {
    /*
      Caught rather than left to float. Every one of these is reachable from
      inside an Electron `click` listener (`remote-toast.ts`), where an
      unhandled rejection is an exception in main with nobody to catch it —
      fatal under Node 22's default `--unhandled-rejections=throw`, as
      `updates/index.ts` says of its own. The two `call()`s on the sibling arm
      of that listener are each swallowed for exactly this reason.
    */
    if (isSafeExternalUrl(action.url)) {
      void shell.openExternal(action.url).catch((cause: unknown) => {
        console.error('[hive] could not open an external link:', cause);
      });
    }
    return;
  }

  /**
   * The update actions carry no data at all, which is what makes them safe to
   * accept from a renderer without validating anything beyond the tag. The
   * updater already holds the version it found; these say only "do the thing
   * you offered", and a stale row clicked after the updater has moved on is
   * answered by whatever the updater's state actually is now.
   */
  if (action.type === 'update.download') {
    void downloadUpdate().catch((cause: unknown) => {
      console.error('[hive] could not start the update download:', cause);
    });
    return;
  }

  if (action.type === 'update.install') {
    void installUpdate().catch((cause: unknown) => {
      console.error('[hive] could not install the update:', cause);
    });
    return;
  }

  /*
    Exhaustive, and checked rather than assumed.

    The narrow parameter type stops a *fleet* action being handed in, but it
    does not stop {@link ThisMachineAction} widening underneath this function:
    it is derived from `ACTION_SCOPE`, so a new member of the union classified
    `this-machine` joins it automatically. Without this, that member would fall
    into whichever branch happened to be last and silently do something else —
    for a while, that meant quitting and replacing the app.

    Assigning to `never` is what makes the widening a compile error here, at
    the one place that has to answer for every member.
  */
  const unreachable: never = action;
  void unreachable;
}

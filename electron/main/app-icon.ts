import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { app, nativeImage } from 'electron';

/**
 * The app icon, for the two places Electron will not find it on its own.
 *
 * A **packaged** app never comes through here. macOS reads the `.icns` out of
 * the bundle, Windows reads the `.ico` compiled into the executable, and Linux
 * reads the `.desktop` entry — all three are the installer's job, and none of
 * them can be set from inside a running process. `resources/README.md` holds
 * the electron-builder block that does it.
 *
 * A **dev** run has no bundle, so `pnpm desktop:dev` shows Electron's own
 * default icon in the dock and the taskbar. That is what this file fixes, and
 * the whole of what it fixes.
 */

/** The 1024 master, relative to `out/main/` — or `undefined` when packaged. */
export function devIconPath(dirname: string = import.meta.dirname): string | undefined {
  if (app.isPackaged) return undefined;
  const path = join(dirname, '../../resources/icon.png');
  /*
   * Absent is not a failure worth crashing a launch over: the file is a
   * committed asset, so a miss means someone is running from a tree where it
   * was moved, and the honest outcome is the default icon.
   */
  return existsSync(path) ? path : undefined;
}

/**
 * Give the dock its icon during development (macOS only).
 *
 * `app.dock` is undefined elsewhere, and must be called after `whenReady` —
 * before that there is no dock to set.
 */
export function applyDevDockIcon(): void {
  const path = devIconPath();
  if (!path || !app.dock) return;
  const image = nativeImage.createFromPath(path);
  // An unreadable PNG yields an empty image, and `setIcon` throws on one.
  if (image.isEmpty()) return;
  app.dock.setIcon(image);
}

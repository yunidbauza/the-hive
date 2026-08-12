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

/**
 * A master in `resources/`, relative to `out/main/` — or `undefined` when
 * packaged.
 *
 * Two masters, because the platforms disagree about the canvas. Windows and
 * Linux draw the file as given, so they take the full-bleed `icon.png`. macOS
 * arranges the dock on a grid where the icon occupies 824 of 1024 points and
 * the margin is the alignment: hand it a full-bleed tile and it stands visibly
 * taller than every neighbour. That is what `icon-macos.png` is for.
 */
export function devIconPath(
  file: 'icon.png' | 'icon-macos.png' = 'icon.png',
  dirname: string = import.meta.dirname,
): string | undefined {
  if (app.isPackaged) return undefined;
  const path = join(dirname, '../../resources', file);
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
  const path = devIconPath('icon-macos.png');
  if (!path || !app.dock) return;
  const image = nativeImage.createFromPath(path);
  // An unreadable PNG yields an empty image, and `setIcon` throws on one.
  if (image.isEmpty()) return;
  app.dock.setIcon(image);
}

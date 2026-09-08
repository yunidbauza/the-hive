import {
  Menu,
  Tray,
  clipboard,
  dialog,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';

import type { ServerDevice } from '@shared/config-contract';

import { devIconPath } from './app-icon';

/**
 * The server-mode tray (HIVE-142) — the whole console on a machine that opens
 * no window.
 *
 * Built the way `menu.ts` is: a pure `buildTrayTemplate` the tray's *content*
 * can be unit-tested against, and a thin `createServerTray` that is the only
 * piece touching real Electron (`Tray`, `Menu`, `dialog`, `clipboard`).
 *
 * **A proper packaged-build tray icon is still owed** (HIVE-142 review): no
 * black-and-transparent template PNG exists in `resources/` today, and
 * shipping one as a runtime resource would need an `electron-builder.yml`
 * `extraResources` entry — both outside this module's own file list. See
 * `trayIcon`'s doc comment for exactly what is missing and why, and
 * `createServerTray`'s text-title fallback for what stands in for it until
 * that asset exists.
 */

export interface TrayDeps {
  /** Read fresh on every open, so a `--pair` or `--revoke` in another process shows up with no restart. */
  devices: () => readonly ServerDevice[];
  /**
   * Mints and stores a device named `name`, returning the plaintext token —
   * once, never stored — or `null` when a unique device id could not be
   * minted after every retry (`mintUniqueDevice` in `server/devices.ts`; a
   * 16-bit id space and a real if vanishingly unlikely collision, HIVE-142
   * review). Nothing is stored on `null` — the caller refuses rather than
   * silently pairing a device whose id shadows an existing one.
   */
  onPair: (name: string) => string | null;
  onRevoke: (name: string) => void;
  onOpenConsole: () => void;
  /** What `listener.start()` actually bound, or `null` before it has. */
  boundAddress: () => string | null;
}

/**
 * A pairing name with no human typing it.
 *
 * Electron's `dialog` has no text-input surface — `showMessageBox` offers
 * buttons, not a field — so the tray's "Pair a device…" cannot collect a name
 * the way `--pair "<name>"` does from a terminal (spec §5.2, §9's "Pairing
 * surface" decision: tray *and* CLI, not tray reimplementing the CLI). A
 * timestamp is unique by construction, which is all a name minted from a menu
 * click needs to be — a device paired this way can always be given a better
 * name later by revoking it and re-pairing from a terminal.
 */
function autoPairingName(now: Date = new Date()): string {
  return `Device ${now.toISOString().slice(0, 19).replace('T', ' ')}`;
}

/**
 * The menu's content, independent of any real `Tray` — so a test can assert
 * "Pair a device…" is there, that a paired device's entry revokes it, and
 * that the bound address renders, without booting Electron at all.
 */
export function buildTrayTemplate(deps: TrayDeps): MenuItemConstructorOptions[] {
  const devices = deps.devices();

  const pairedSubmenu: MenuItemConstructorOptions[] =
    devices.length === 0
      ? [{ label: 'No devices paired', enabled: false }]
      : devices.map((device) => ({
          label: device.revoked ? `${device.name} (revoked)` : device.name,
          // A revoked device has nothing left to revoke — the item exists so
          // the roster is still legible, not so it can be clicked again.
          enabled: !device.revoked,
          click: () => deps.onRevoke(device.name),
        }));

  const address = deps.boundAddress();

  return [
    {
      label: 'Pair a device…',
      click: () => {
        const name = autoPairingName();
        const token = deps.onPair(name);
        /*
          No `BrowserWindow` argument on either dialog below: server mode's
          premise is that no renderer runs, so there is no window to parent
          this to, and a detached dialog is the correct (only) shape here —
          see the module doc comment.
        */
        if (token === null) {
          // `onPair` refused rather than pairing a device whose id shadows
          // an existing one (HIVE-142 review) — nothing was stored, and the
          // dialog says so plainly rather than showing a broken token.
          void dialog.showMessageBox({
            type: 'error',
            title: 'Could not pair a device',
            message: 'This Hive could not mint a unique device credential. Try again.',
          });
          return;
        }
        void dialog
          .showMessageBox({
            type: 'info',
            title: 'Device paired',
            message: `"${name}" can now reach this Hive.`,
            detail: token,
            buttons: ['Copy', 'Done'],
            defaultId: 0,
            noLink: true,
          })
          .then((result) => {
            if (result.response === 0) clipboard.writeText(token);
          });
      },
    },
    {
      label: `Paired devices (${devices.length})`,
      submenu: pairedSubmenu,
    },
    { type: 'separator' },
    {
      label: address === null ? 'Not yet listening' : `Serving ${address}`,
      enabled: false,
    },
    { label: 'Open The Hive', click: () => deps.onOpenConsole() },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ];
}

/**
 * The icon shown in the menu bar.
 *
 * `devIconPath` answers `undefined` once packaged (see its own doc comment),
 * and a packaged build has nothing else to load: `nativeImage.createFromPath`
 * supports only PNG and JPEG (checked against Electron's own docs, HIVE-142
 * review) — the `.icns` electron-builder copies to `Contents/Resources/icon.icns`
 * for the app's own Dock/Finder icon cannot be decoded by it, and no PNG is
 * shipped as a runtime resource today (`electron-builder.yml` sets no
 * `extraResources`). So this resolves an icon in dev and an empty
 * `nativeImage` when packaged — a real gap, tracked rather than silently
 * shipped broken (see `createServerTray`'s title fallback, which is what
 * keeps a packaged tray from being invisible).
 *
 * `setTemplateImage(true)` on whatever does load: a menu-bar icon should be a
 * template image so macOS re-tints it for light and dark menu bars rather
 * than showing whatever colours the source PNG happens to carry. The app's
 * icon art was drawn for the Dock, not as a monochrome silhouette, so this is
 * an improvement over showing it untouched rather than a properly-designed
 * template asset — that asset is still owed (see the module doc comment).
 */
function trayIcon(): NativeImage {
  const path = devIconPath('icon.png');
  if (!path) return nativeImage.createEmpty();
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) return image;
  image.setTemplateImage(true);
  return image;
}

/**
 * Installs the tray. Only ever called in server mode (`index.ts`), and only
 * after `app.whenReady()`.
 *
 * The menu is rebuilt from `deps` on every open rather than set once at
 * construction — `Menu.buildFromTemplate` is called fresh inside `showMenu`
 * rather than `tray.setContextMenu` at the top of this function — because
 * `deps.devices()` and `deps.boundAddress()` are getters for exactly this
 * reason: a `--pair` or `--revoke` run from a terminal in a *different*
 * process must be visible the next time this menu opens, with no restart.
 * `setContextMenu` would freeze that content at whatever it was the instant
 * this function ran.
 */
export function createServerTray(deps: TrayDeps): { destroy: () => void } {
  const icon = trayIcon();
  const tray = new Tray(icon);
  tray.setToolTip('The Hive · serving');
  /*
    On the Mac mini this deployment targets there is no window and no dock
    icon (HIVE-142 review) — the tray is the *only* way a human reaches Pair,
    Open or Quit. An empty icon renders as an invisible menu-bar item, which
    would make a served machine unreachable from its own screen even though
    everything behind it works. A text title is a strictly worse look than a
    real icon but a strictly better one than nothing, so it is the fallback
    exactly when `trayIcon()` could not resolve a real one — see that
    function's doc comment for what is still owed.
  */
  if (icon.isEmpty()) tray.setTitle('Hive');

  const showMenu = (): void => {
    tray.popUpContextMenu(Menu.buildFromTemplate(buildTrayTemplate(deps)));
  };
  // Both events, not just one: `click` is the primary button everywhere but
  // some Linux desktop environments only ever deliver `right-click` for a
  // tray icon with no default action of its own.
  tray.on('click', showMenu);
  tray.on('right-click', showMenu);

  return {
    destroy: () => tray.destroy(),
  };
}

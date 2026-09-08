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
 */

export interface TrayDeps {
  /** Read fresh on every open, so a `--pair` or `--revoke` in another process shows up with no restart. */
  devices: () => readonly ServerDevice[];
  /** Mints and stores a device named `name`, returning the plaintext token — once, never stored. */
  onPair: (name: string) => string;
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
          No `BrowserWindow` argument: server mode's premise is that no
          renderer runs, so there is no window to parent this to, and a
          detached dialog is the correct (only) shape here — see the module
          doc comment.
        */
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
 * `devIconPath` answers `undefined` once packaged (see its own doc comment) —
 * a packaged tray icon is a build-resource question this story does not
 * reach, tracked rather than silently shipped broken. An empty image is a
 * valid `nativeImage` Electron accepts without throwing, and macOS still
 * shows a (blank) menu-bar item a user can click — better than a crash, and
 * honest about what remains a gap.
 */
function trayIcon(): NativeImage {
  const path = devIconPath('icon.png');
  if (!path) return nativeImage.createEmpty();
  const image = nativeImage.createFromPath(path);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
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
  const tray = new Tray(trayIcon());
  tray.setToolTip('The Hive · serving');

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

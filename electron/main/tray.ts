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

import { trayIconPath } from './app-icon';

/**
 * The server-mode tray (HIVE-142) — the whole console on a machine that opens
 * no window.
 *
 * Built the way `menu.ts` is: a pure `buildTrayTemplate` the tray's *content*
 * can be unit-tested against, and a thin `createServerTray` that is the only
 * piece touching real Electron (`Tray`, `Menu`, `dialog`, `clipboard`).
 *
 * Its icon is `resources/tray/trayTemplate.png` (HIVE-147), a black-and-
 * transparent template drawn by `scripts/icon/generate-app-icon.py --tray` from
 * the app icon's own geometry — see `trayIcon`.
 */

export interface TrayDeps {
  /**
   * Must actually re-read the config file on every call, not merely be
   * called again — `getConfig()` alone answers a snapshot cached at boot
   * (the file is never watched), so a getter that only wraps `getConfig()`
   * would look fresh while showing the same frozen roster forever.
   * `reloadConfig()` re-reads the file but is also the wrong tool here: it
   * installs its result as this process's shared config cache, which this
   * getter (and `onPair`/`onRevoke` below) must not do — see
   * `readServerDevicesFromDisk()` in `server/file-backed-io.ts`, which
   * `index.ts` uses instead (HIVE-142 review, N1). A `--pair` or `--revoke`
   * one-shot run from a terminal in another process is what this property
   * exists to make visible here with no restart.
   */
  devices: () => readonly ServerDevice[];
  /**
   * Mints and stores a device named `name`, answering the plaintext token —
   * once, never stored — or the reason it refused (HIVE-142 review, N4): a
   * duplicate name (`devices.ts`'s `pairDevice`, shared with `--pair`), a
   * device id that could not be minted uniquely after every retry
   * (`mintUniqueDevice`; a 16-bit id space and a real if vanishingly
   * unlikely collision), or a config write that did not land (HIVE-142
   * review, C1). Nothing is stored on refusal — a discriminated result
   * rather than `string | null` so this menu can show the *accurate*
   * reason, the same one `runPair` already prints for the CLI, instead of
   * one generic message papering over three different causes.
   *
   * `deviceId` rides alongside the token (HIVE-142 review, I5) — the same
   * reason `runPair` and the Settings pane's token panel both show it now:
   * the attach handshake needs both, and the id used to be readable only
   * inside `config.json`.
   */
  onPair: (name: string) => { token: string; deviceId: string } | { error: string };
  /**
   * Revokes the device named `name`, answering whether it actually happened
   * (HIVE-142 review, C1/I4) — a name that matches nothing, or a config
   * write that did not land, both refuse rather than report success; the
   * click handler shows the accurate reason instead of an unconditional
   * "Device revoked".
   */
  onRevoke: (name: string) => { revoked: true } | { error: string };
  onOpenConsole: () => void;
  /** What `listener.start()` actually bound, or `null` before it has. */
  boundAddress: () => string | null;
  /**
   * Why nothing is bound yet, or `null` when it is bound or has never been
   * tried (HIVE-142 review, I3) — the cause `createRemoteListener`'s own
   * bind failure recorded, so an unattended machine's tray can say "Not
   * serving — <reason>" instead of "Not yet listening" forever, which is
   * indistinguishable from "still starting".
   */
  bindError: () => string | null;
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
          label: device.revoked ? `"${device.name}" (revoked)` : `Revoke "${device.name}"…`,
          // A revoked device has nothing left to revoke — the item exists so
          // the roster is still legible, not so it can be clicked again.
          enabled: !device.revoked,
          /*
            Confirmed before it happens, and reported after (HIVE-142 review,
            I4). The bare device name used to be both the label and the whole
            click target: one mis-click on the sole console of an unattended
            machine silently cut a device's access, with no signal beyond
            "(revoked)" the *next* time this menu happened to open. A device
            revoked in error has no undo — `mintUniqueDevice`/`--pair` mints a
            new credential, it does not restore the old one — which is exactly
            why this, unlike pairing, asks first.
          */
          click: () => {
            void dialog
              .showMessageBox({
                type: 'warning',
                title: 'Revoke this device?',
                message: `"${device.name}" will no longer be able to reach this Hive.`,
                detail: 'This cannot be undone. A revoked device must be paired again from a terminal or this menu.',
                buttons: ['Cancel', 'Revoke'],
                defaultId: 0,
                cancelId: 0,
              })
              .then((result) => {
                if (result.response !== 1) return; // Cancel, or dismissed.
                const outcome = deps.onRevoke(device.name);
                // A refusal — no such device any more, or the write did not
                // land (HIVE-142 review, C1/I4) — is shown rather than
                // papered over with the same "Device revoked" every
                // successful click gets; the security-critical answer here
                // is whether it actually happened, not whether the click
                // was received.
                if ('error' in outcome) {
                  void dialog.showMessageBox({
                    type: 'error',
                    title: 'Could not revoke this device',
                    message: outcome.error,
                  });
                  return;
                }
                void dialog.showMessageBox({
                  type: 'info',
                  title: 'Device revoked',
                  message: `"${device.name}" can no longer reach this Hive.`,
                });
              });
          },
        }));

  const address = deps.boundAddress();
  const bindError = deps.bindError();

  return [
    {
      label: 'Pair a device…',
      click: () => {
        const name = autoPairingName();
        const attempt = deps.onPair(name);
        /*
          No `BrowserWindow` argument on either dialog below: server mode's
          premise is that no renderer runs, so there is no window to parent
          this to, and a detached dialog is the correct (only) shape here —
          see the module doc comment.
        */
        if ('error' in attempt) {
          // `onPair` refused — a duplicate name or a minting collision, and
          // `attempt.error` already says which (HIVE-142 review, N4): the
          // accurate cause, not one generic message standing in for both.
          void dialog.showMessageBox({
            type: 'error',
            title: 'Could not pair a device',
            message: attempt.error,
          });
          return;
        }
        const { token, deviceId } = attempt;
        void dialog
          .showMessageBox({
            type: 'info',
            title: 'Device paired',
            message: `"${name}" can now reach this Hive.`,
            // The device id on its own line (HIVE-142 review, I5) — the
            // attach handshake needs both, and "Copy" below only ever copies
            // the token, so a person pairing from this menu needs the id
            // visible here, not just implied by the roster underneath it.
            detail: `${token}\nDevice id: ${deviceId}`,
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
      /*
        Three distinguishable states, not two (HIVE-142 review, I3): a bind
        that failed (port conflict, or a `bind.host` that does not resolve to
        a local interface yet — Tailscale not up) used to render the exact
        same "Not yet listening" a socket that is merely still starting does,
        which makes the two indistinguishable on an unattended machine with
        nobody to notice the difference except by symptom.
      */
      label:
        address !== null
          ? `Serving ${address}`
          : bindError !== null
            ? `Not serving — ${bindError}`
            : 'Not yet listening',
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
 * The purpose-drawn template HIVE-142 left owed, found by `trayIconPath` in
 * dev and packaged alike. Drawn at the 18pt macOS gives a menu-bar item, with
 * an `@2x` sibling, so nothing here resizes it.
 *
 * `setTemplateImage(true)` so macOS re-tints it for light and dark menu bars:
 * only its alpha channel is drawn. The file name's `Template` suffix asks for
 * the same thing, but only when macOS itself loads the file.
 *
 * An empty image when the file is missing, which `createServerTray` answers
 * with a text title rather than an invisible item.
 */
function trayIcon(): NativeImage {
  const path = trayIconPath();
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
    exactly when `trayIcon()` could not resolve a real one — a tree where
    `resources/tray/` went missing.
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

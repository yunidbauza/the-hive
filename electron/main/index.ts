import { join } from 'node:path';

import { app } from 'electron';

import { applyDevDockIcon } from './app-icon';
import { installContentSecurityPolicy } from './csp';
import { registerIpcHandlers } from './ipc';
import { registerLifecycle } from './lifecycle';
import { startUpdateChecks } from './updates';
import { createWindow } from './window';

/**
 * Main process entry (stories 081, 082).
 *
 * Lifecycle only. The window is `window.ts`, the platform handlers are
 * `lifecycle.ts`, the channels are `ipc/`, and teardown registration is
 * `shutdown.ts` — this file decides whether this process should run at all,
 * and then hands off.
 */

/**
 * The app is called The Hive, and says so — in the menu bar and the About box.
 *
 * Without this, `app.getName()` falls back to `package.json`'s `name` field and
 * every role-driven menu item reads `About the-hive`, `Quit the-hive`. The
 * package name is an npm identifier; it was never meant to be shown to anyone.
 *
 * **What this does not fix**, and cannot: the *leftmost* menu title. macOS
 * takes that from `CFBundleName` in the running bundle's `Info.plist`, and
 * under `pnpm desktop:dev` the running bundle is Electron's own — so dev shows
 * `Electron` no matter what any API says. The packaged app sets `CFBundleName`
 * properly through `productName` in `electron-builder.yml`, which is the real
 * fix and the only honest one. Patching Electron's `Info.plist` in
 * `node_modules` would make dev *look* right while changing nothing about what
 * ships. See `docs/packaging-and-updates.md`.
 */
app.setName('The Hive');

/**
 * Development keeps the userData directory it already has.
 *
 * `setName` moves it: `userData` is derived from the app name, so renaming
 * would silently relocate `~/Library/Application Support/the-hive` to
 * `…/The Hive` and leave the window state, the hook settings and — the one that
 * would actually hurt — the encrypted Jira credential behind, with no error and
 * no hint that a re-authentication was caused by a cosmetic rename.
 *
 * Pinning it in dev has a second and larger benefit: the packaged app resolves
 * `userData` to `The Hive`, so the two stay **separate instances**. They can run
 * side by side. Had both landed on one directory, `requestSingleInstanceLock`
 * would treat a development run and the installed app as the same app, and
 * launching one while the other was open would just focus the wrong window.
 *
 * **`--user-data-dir` wins.** An explicit profile is a deliberate choice and
 * this default must not silently overrule it. Learned the hard way: without the
 * switch check, the Playwright suite — which gives every spec its own profile
 * for exactly the isolation reason above — had all five workers land on one
 * directory, so `requestSingleInstanceLock` failed in four of them and they
 * quit before opening a window. Ninety-odd specs failed in about half a second
 * each, none of them saying anything about a profile.
 */
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), 'the-hive'));
}

/**
 * The single-instance lock, first, before anything else is wired.
 *
 * `requestSingleInstanceLock()` returns false in the *second* process, which
 * must exit immediately — the first process gets a `second-instance` event and
 * focuses its window instead (see `lifecycle.ts`).
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  /**
   * Registers every channel, and with them the pty-host supervisor and its
   * teardown. None of it **starts** a process (story 091): the host is forked
   * lazily on the first session, because most launches land on the
   * orchestrator console, which owns no PTY.
   */
  registerIpcHandlers();

  /**
   * The CSP has to be installed before any renderer loads, and
   * `session.defaultSession` is only available once the app is ready.
   */
  void app.whenReady().then(() => {
    installContentSecurityPolicy();
    /**
     * Dev only, and macOS only: without it `pnpm desktop:dev` sits in the dock
     * under Electron's default icon. A packaged app is the installer's job.
     */
    applyDevDockIcon();
    /**
     * After `whenReady`, and non-blocking.
     *
     * The first check is thirty seconds out (see `update-contract.ts`), so this
     * call only *schedules*. It is here rather than in `registerLifecycle`
     * because it is not lifecycle — nothing about the window or the platform
     * depends on it, and a failure to schedule an update check must never be
     * able to stop a window from opening.
     */
    startUpdateChecks();
  });

  registerLifecycle({ createWindow });
}

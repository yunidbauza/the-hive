import { join } from 'node:path';

import { app } from 'electron';

import { applyDevDockIcon } from './app-icon';
import { parseInvocation } from './cli';
import { getConfig, setServer } from './config';
import { startLoginEnvImport } from './config/login-env';
import { installContentSecurityPolicy } from './csp';
import { remoteListenerBoundHost, startRemoteListener } from './ipc';
import { registerIpc } from './ipc/router';
import { registerLifecycle } from './lifecycle';
import { mintUniqueDevice, revokeNamed } from './server/devices';
import { fileBackedIo } from './server/file-backed-io';
import { runOneShot } from './server/one-shot';
import { createServerTray } from './tray';
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

/*
  Before the single-instance lock, and before `whenReady`, deliberately.

  On a served machine the app is always running, so a one-shot that requested
  the lock would lose it and quit before printing anything — and Electron's
  `second-instance` event hands argv to the first instance with no channel to
  answer on. Before `whenReady` because it can be: minting is `randomBytes`, a
  digest and a config write. Measured 2026-09-08 — `safeStorage` is unavailable
  before `whenReady` even in a GUI session, which is the other half of why the
  server stores a digest rather than a secret.
*/
const invocation = parseInvocation(process.argv, app.isPackaged);
if (invocation.kind !== 'app') {
  process.exit(runOneShot(invocation, fileBackedIo()));
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
  /**
   * Ask the login shell what this app's `PATH` should be — first, and without
   * waiting for the answer (HIVE-84).
   *
   * **Before `registerIpcHandlers`** so the probe is already in flight by the
   * time any handler can be called, and **not awaited** so a slow rc file
   * cannot delay the first window. The handlers that actually depend on the
   * repaired `PATH` await the memoised promise themselves; everything else
   * carries on. `void` rather than a `.catch` because `importLoginEnv` never
   * rejects — every failure comes back as a reported status.
   *
   * Inside the single-instance branch: a second launch quits immediately, and
   * running the user's rc file on the way out would be work for a process that
   * is about to stop existing.
   */
  void startLoginEnvImport({
    enabled: getConfig().importLoginEnv,
    /**
     * The **configured** shell, which `loadConfig` has already defaulted to
     * `defaultShell()` when the file names none.
     *
     * Asking `defaultShell()` directly here would ignore a user who set
     * `"shell"` in their config — and that is precisely the shell whose
     * environment their sessions get, so importing from a different one would
     * hand the app a `PATH` no session of theirs actually has.
     */
    shell: getConfig().shell,
  });

  /*
    Through the router rather than straight to `registerIpcHandlers` (HIVE-141).
    `'local'` is the only mode that resolves today; the constant is here so the
    boot path already has the shape server mode needs, and so the day it takes a
    mode from config is a one-line change rather than a rewrite of this function.
  */
  registerIpc('local');

  /**
   * Server mode is `server.enabled` in the config file — set for good on the
   * unattended Mac mini this ships to run on — **or** the one-off `--server`
   * flag, which enables it for this run only and never writes the file
   * (HIVE-142, spec §5.1, §3.4). Computed once, here, rather than inside
   * `whenReady`'s callback below: `registerLifecycle` needs the same answer
   * to decide whether its own `whenReady` handler may open a window, and
   * racing two separate reads of `getConfig()` against two separate
   * `whenReady` callbacks would risk the file changing under it between them.
   */
  const serverMode = invocation.server || getConfig().server.enabled;

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

    if (serverMode) {
      /**
       * No renderer runs in server mode: the console is the tray, not a
       * window (HIVE-142). Hiding the dock icon is what tells a served
       * machine's own screen — reached only by screen-sharing into the mini —
       * that this is a background service, not an app someone forgot to quit.
       * `app.dock` is `undefined` off macOS, which is the only platform this
       * app ships on today; the optional chain is defensive rather than load-
       * bearing.
       */
      app.dock?.hide();
      /*
        Fire-and-forget: a bind failure is not fatal to boot (the tray still
        shows, still lets a human retry after fixing the config), and there is
        nobody at this machine to hand a rejected promise to anyway. The
        result is not needed here — `remoteListenerBoundHost()` below reads
        it back once it lands, exactly as `AppInfo` reads the receiver's own
        `boundHost` rather than the promise `hooks.start()` returned.
      */
      void startRemoteListener();
      createServerTray({
        devices: () => getConfig().server.devices,
        /*
          Mint, then persist: `setServer` spreads onto the current block
          (`electron/main/config/index.ts`'s own rule), so this never rebuilds
          `bind` or drops a device paired by a concurrent `--pair` one-shot —
          the same wholesale-replace-of-`devices`-only shape `fileBackedIo`
          uses for the CLI path.

          `mintUniqueDevice`, not a bare `mintDevice` call — the collision
          check `--pair`'s own `runOneShot` path already has (HIVE-142
          review). Nothing is written on `null`; the tray tells the user to
          try again rather than pairing a device whose id shadows one already
          stored, which `verifyDevice` would then never see past the first.
        */
        onPair: (name) => {
          const devices = getConfig().server.devices;
          const minted = mintUniqueDevice(name, devices);
          if (!minted) return null;
          setServer({ devices: [...devices, minted.device] });
          return minted.token;
        },
        onRevoke: (name) => {
          const result = revokeNamed(getConfig().server.devices, name);
          if (result.revoked) setServer({ devices: result.devices });
        },
        onOpenConsole: () => createWindow({ withSplash: true }),
        /*
          `remoteListenerBoundHost()` answers the host alone — `boundHost`'s
          established meaning across this codebase (`hooks.boundHost()`,
          `Receiver.boundHost`, `RemoteListener.boundHost` all agree: "the
          address the kernel actually bound", not a connectable URL). The
          port is fixed and configured rather than OS-assigned (spec §4 — a
          client's config and a LaunchAgent both have to name it ahead of
          time), so appending it here is safe: it is the same number the
          socket is actually listening on whenever `remoteListenerBoundHost()`
          is non-null.
        */
        boundAddress: () => {
          const host = remoteListenerBoundHost();
          return host === null ? null : `${host}:${String(getConfig().server.bind.port)}`;
        },
      });
    }
  });

  registerLifecycle({ createWindow, serverMode });
}

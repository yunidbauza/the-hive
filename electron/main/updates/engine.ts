import electronUpdater from 'electron-updater';

import type { UpdateEngine } from './updater';

/**
 * The only file that touches `electron-updater`.
 *
 * Everything interesting about updating lives in `updater.ts`, which knows
 * nothing about this library. What is left here is adaptation — three methods
 * over an event emitter — and it is deliberately dull, because it is the part
 * no unit test can reach.
 *
 * ## Two things about the import, both learned the hard way
 *
 * **The default import, not a named one.** `electron-updater` is CommonJS and
 * this package is `"type": "module"`. A named import is resolved by Node's
 * cjs-module-lexer, which reads the *source* for export patterns it recognises
 * and does not always find this library's. The failure is `SyntaxError: Named
 * export 'autoUpdater' not found` at load, naming neither ESM nor CommonJS.
 *
 * **And the property is read inside the factory, never at module scope.**
 * `autoUpdater` is a lazy *getter*: touching it constructs a `MacUpdater`,
 * which reads `app.getVersion()` on the spot. Destructuring it here would move
 * that construction to import time — which is before `app` exists for anything
 * importing this module, and which made three unrelated test suites fail with
 * `Cannot read properties of undefined (reading 'getVersion')` from inside
 * `ElectronAppAdapter`. Measured, not theorised: the suites in question only
 * ever imported `ipc/index.ts`, and paid for an updater nothing had asked for.
 */

/**
 * Whether `checkForUpdates` found something *newer*, rather than merely
 * something.
 *
 * `isUpdateAvailable` is the honest answer and exists on electron-updater 6.2+.
 * The fallback covers an older resolution of the dependency, where the result
 * carries an `updateInfo` regardless and "same version" would read as an
 * available update — which would announce an update to the version already
 * running, forever, every six hours.
 */
function isNewer(
  result: { isUpdateAvailable?: boolean; updateInfo: { version: string } },
  currentVersion: string,
): boolean {
  if (typeof result.isUpdateAvailable === 'boolean') {
    return result.isUpdateAvailable;
  }
  return result.updateInfo.version !== currentVersion;
}

/**
 * @param options.relaunch Whether Squirrel starts the new version itself after
 * the swap. `false` on a server-configured install (HIVE-147): launchd owns that
 * process's lifetime, and a copy Squirrel relaunched would be one launchd does
 * not know about — it would restart its own copy beside it, lose the server
 * lock to it, and keep retrying for as long as both lived.
 */
export function createElectronUpdaterEngine(
  currentVersion: string,
  { relaunch = true }: { relaunch?: boolean } = {},
): UpdateEngine {
  const { autoUpdater } = electronUpdater;

  /**
   * Nothing happens without the user, twice over.
   *
   * `autoDownload: false` is what makes the Inbox row a *question* rather than
   * a report of something already done behind their back. `autoInstallOnAppQuit`
   * is the subtler one: left at its default, a downloaded update would swap
   * itself in the next time the app quit — including the quit that happens
   * because something crashed, and including the case where the user
   * deliberately said "Later". Both defaults exist for consumer apps that
   * update silently. This is a tool people run a fleet of agents in; it changes
   * version when they say so.
   */
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      if (result === null || result === undefined) return null;
      if (!isNewer(result, currentVersion)) return null;
      return { version: result.updateInfo.version };
    },

    download(onProgress) {
      return new Promise<void>((resolve, reject) => {
        const progress = (info: { percent: number }): void => {
          onProgress(info.percent);
        };
        const cleanup = (): void => {
          autoUpdater.removeListener('download-progress', progress);
          autoUpdater.removeListener('update-downloaded', downloaded);
          autoUpdater.removeListener('error', failed);
        };
        /**
         * `error` is a real outcome of downloading, not a stray event.
         *
         * On macOS `downloadUpdate()` resolves once the bytes are on disk, but
         * the *staging* — handing the archive to Squirrel, which verifies the
         * code signature against the running bundle — continues afterwards and
         * reports here. Resolving on `downloadUpdate()` alone would call an
         * update ready that Squirrel has already rejected, and the failure
         * would resurface at `quitAndInstall` as an app that simply does not
         * come back. Waiting for `update-downloaded` is what makes the ad-hoc
         * signature question answerable at all.
         */
        const downloaded = (): void => {
          cleanup();
          resolve();
        };
        const failed = (cause: unknown): void => {
          cleanup();
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        };

        autoUpdater.on('download-progress', progress);
        autoUpdater.once('update-downloaded', downloaded);
        autoUpdater.once('error', failed);

        autoUpdater.downloadUpdate().catch(failed);
      });
    },

    install() {
      /**
       * Returns a promise that **only ever rejects**.
       *
       * On success this process is replaced and nothing here resolves, which is
       * why the caller must not await it as though it were an ordinary async
       * call. On failure Squirrel reports through the `error` event, and this is
       * the only place that failure can be observed.
       *
       * It is observable at all only because the refusal is asynchronous:
       * `quitAndInstall` returns immediately and cheerfully. Measured, with the
       * app's stderr captured:
       *
       *     [Error: Code signature at URL file:///…/The Hive.app/ did not pass
       *      validation: code failed to satisfy specified code requirement(s)]
       *       code: -1, domain: 'SQRLCodeSignatureErrorDomain'
       *
       * An earlier cut wrapped `quitAndInstall` in a `try`/`catch`, which caught
       * nothing — the app simply stayed running, having just told the user it
       * was about to restart on a new version.
       */
      return new Promise<never>((_resolve, reject) => {
        autoUpdater.once('error', (cause: Error) => {
          reject(cause);
        });
        /**
         * `isSilent: false`, `isForceRunAfter: relaunch`.
         *
         * The second matters: without it a macOS update quits the app and
         * leaves the user staring at a desktop, which reads as a crash rather
         * than an update. Except on a server, where launchd relaunches it.
         */
        autoUpdater.quitAndInstall(false, relaunch);
      });
    },
  };
}

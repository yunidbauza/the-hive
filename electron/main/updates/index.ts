import { app, BrowserWindow, dialog, shell } from 'electron';

import { idleUpdateStatus, type UpdateStatus } from '@shared/update-contract';

import { probeUpdateCapability } from './capability';
import { createElectronUpdaterEngine } from './engine';
import { createUpdater, type Updater } from './updater';

/**
 * The updater as the rest of main sees it: one object, always present.
 *
 * ## Why this is a lazily-initialised singleton rather than a parameter
 *
 * Three unrelated places need to reach the updater — the IPC layer (a clicked
 * Inbox row), the menu ("Check for updates…"), and the lifecycle (start the
 * schedule) — and none of them owns the other two. Threading one instance
 * through all three would mean `registerLifecycle` taking an updater it never
 * uses, purely to hand it to the menu.
 *
 * ## Why the capability probe forces the async shape
 *
 * The probe shells out to `codesign`, so the real capability is not knowable
 * synchronously, and the menu item's `click` handler cannot wait. So the module
 * answers immediately with a conservative status and settles into the true one:
 * `ensureUpdater()` is awaited by the paths that can await, and `status()`
 * answers from a placeholder until the probe lands. The placeholder claims
 * nothing it might have to retract — it reports the running version and a
 * capability that has not been established yet.
 */

let updater: Updater | null = null;
let starting: Promise<Updater> | null = null;

/**
 * What `status()` answers before the probe has landed.
 *
 * `canCheck: false` is the honest placeholder: at this instant the app really
 * cannot check, because it does not yet know what it is allowed to do. It is
 * replaced within a second of launch, and the Settings pane re-reads.
 */
function pendingStatus(): UpdateStatus {
  return idleUpdateStatus(app.getVersion(), {
    canCheck: false,
    mode: 'manual',
    reason: 'Working out whether this copy can update itself…',
  });
}

/** The window a modal should hang off, if there is one. */
function parentWindow(): BrowserWindow | undefined {
  const [existing] = BrowserWindow.getAllWindows();
  return existing !== undefined && !existing.isDestroyed() ? existing : undefined;
}

export async function ensureUpdater(): Promise<Updater> {
  if (updater !== null) return updater;
  /**
   * The in-flight promise is cached; a **failed** one is not.
   *
   * `starting ??=` on its own caches the rejection too, so a single failure in
   * the probe, in `app.getVersion()`, or in `createElectronUpdaterEngine` —
   * which touches `electronUpdater.autoUpdater`, a getter that constructs a
   * `MacUpdater` and can throw — would leave every later call rejecting for the
   * life of the process. The menu item, both Inbox actions and the Settings
   * button would all be dead with no way back short of a relaunch.
   */
  starting ??= (async () => {
    const capability = await probeUpdateCapability();
    const currentVersion = app.getVersion();
    const built = createUpdater({
      engine: createElectronUpdaterEngine(currentVersion),
      capability,
      currentVersion,
      /**
       * Wired at call time through the hub the IPC layer owns, rather than
       * captured here. `registerIpcHandlers` builds the hub, and this module is
       * reachable from the menu before that has necessarily happened.
       */
      notify: (input) => {
        notifySink?.(input);
      },
      openExternal: (url) => {
        void shell.openExternal(url);
      },
      confirm: async ({ title, message, detail, confirmLabel }) => {
        const parent = parentWindow();
        const options = {
          type: 'info' as const,
          title,
          message,
          detail,
          buttons: [confirmLabel, 'Later'],
          defaultId: 0,
          /**
           * Escape maps to "Later", explicitly.
           *
           * Without `cancelId` Electron treats index 0 as the cancel action,
           * so dismissing the dialog with Escape would start a download the
           * user was trying to get away from.
           */
          cancelId: 1,
        };
        const { response } =
          parent === undefined
            ? await dialog.showMessageBox(options)
            : await dialog.showMessageBox(parent, options);
        return response === 0;
      },
      inform: ({ message, detail }) => {
        const parent = parentWindow();
        const options = {
          type: 'info' as const,
          title: 'The Hive',
          message,
          detail,
          buttons: ['OK'],
        };
        if (parent === undefined) void dialog.showMessageBox(options);
        else void dialog.showMessageBox(parent, options);
      },
    });
    updater = built;
    return built;
  })().catch((cause: unknown) => {
    starting = null;
    throw cause;
  });
  return starting;
}

/**
 * Where a raised update notification goes.
 *
 * Set by `registerIpcHandlers` once the hub exists. Null until then, and a
 * notification raised into a null sink is dropped rather than queued — the only
 * window in which that can happen is the first moments of launch, before any
 * check has run, so nothing is actually lost.
 */
type NotifySink = (input: {
  kind: 'app.update_available' | 'app.update_ready';
  id: string;
  title: string;
  body: string;
  action:
    | { type: 'update.download' }
    | { type: 'update.install' }
    | { type: 'url'; url: string };
}) => void;

let notifySink: NotifySink | null = null;

export function setUpdateNotificationSink(sink: NotifySink): void {
  notifySink = sink;
}

/**
 * Begin the background schedule. Called once, after `whenReady`.
 *
 * The `catch` is not decoration. This is the one caller with nobody to return a
 * rejection to, and an unhandled rejection on the main process is fatal under
 * Node 22's default `--unhandled-rejections=throw` — so a failure to *schedule
 * an update check* could take the whole app down at launch. Logged and
 * swallowed: the app runs perfectly well without an updater, and the Settings
 * pane still reports what it knows.
 */
export function startUpdateChecks(): void {
  void ensureUpdater()
    .then((instance) => {
      instance.start();
    })
    .catch((cause: unknown) => {
      console.error('[hive] the updater could not start:', cause);
    });
}

/** The menu item and the Settings pane both land here. */
export async function checkForUpdatesInteractively(): Promise<void> {
  const instance = await ensureUpdater();
  await instance.check('menu');
}

/** A clicked "Update available" row. */
export async function downloadUpdate(): Promise<void> {
  const instance = await ensureUpdater();
  await instance.download();
}

/** A clicked "Update ready" row. */
export async function installUpdate(): Promise<void> {
  const instance = await ensureUpdater();
  await instance.install();
}

export function updateStatus(): UpdateStatus {
  return updater === null ? pendingStatus() : updater.status();
}

/** Test-only: drop the singleton so a fresh one is built. */
export function resetUpdater(): void {
  updater = null;
  starting = null;
  notifySink = null;
}

export { createUpdater } from './updater';
export type { Updater, UpdateEngine, UpdaterDeps } from './updater';
export { probeUpdateCapability, demoteToManual } from './capability';

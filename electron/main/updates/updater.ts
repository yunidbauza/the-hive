import {
  RELEASES_URL,
  releaseUrlFor,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  type UpdateCapability,
  type UpdateStatus,
} from '@shared/update-contract';

import { demoteToManual } from './capability';

/**
 * The update cycle, with every platform dependency held at arm's length.
 *
 * Nothing in this file imports `electron` or `electron-updater`. That is not
 * fastidiousness — it is the only way the interesting behaviour is testable at
 * all. What is worth asserting here is the *decision-making*: that a refused
 * install demotes instead of retrying forever, that a menu-initiated check
 * answers even when the answer is "nothing", that a given release announces
 * itself exactly once. None of that needs a bundle, a network
 * or a signature, and all of it would be untestable if this file reached for
 * `autoUpdater` directly. `engine.ts` is the twenty lines that do.
 *
 * ## Two entry points, two kinds of answer
 *
 * A **background** check is speculative — nobody asked, so it may find nothing,
 * and finding nothing must be silent. When it does find something it raises an
 * Inbox row, which is the quietest thing that still gets noticed.
 *
 * A **menu** check is a question from a human, and every question deserves an
 * answer. "You're up to date" is a real answer and the app says it out loud, in
 * a dialog, because a menu item that appears to do nothing is indistinguishable
 * from a menu item that is broken. Finding something raises a confirm dialog
 * rather than an Inbox row: the user is right here, waiting.
 *
 * Both funnel into one `check()`, because the *finding* is identical and only
 * the reporting differs. Two code paths would drift.
 */

/** The bits of a real updater this module needs. See `engine.ts`. */
export interface UpdateEngine {
  /** Resolves with the newer release, or `null` when there is nothing newer. */
  check(): Promise<{ version: string } | null>;
  /**
   * Fetch it and stage it. Rejects if the platform refuses the staged update —
   * on macOS the signature check happens here, not at install time.
   */
  download(onProgress: (percent: number) => void): Promise<void>;
  /**
   * Quit and relaunch onto the staged version.
   *
   * **Only ever rejects.** On success this process is replaced, so nothing
   * resolves. Squirrel validates the signature at the *swap*, long after the
   * download reported success, so this rejection is the only place a refusal
   * can be seen.
   */
  install(): Promise<never>;
}

export interface UpdaterDeps {
  engine: UpdateEngine;
  capability: UpdateCapability;
  currentVersion: string;
  /** Raise an Inbox row. Mirrors the hub's `raise`, narrowed to what is used. */
  notify: (input: {
    kind: 'app.update_available' | 'app.update_ready';
    id: string;
    title: string;
    body: string;
    action:
      | { type: 'update.download' }
      | { type: 'update.install' }
      | { type: 'url'; url: string };
  }) => void;
  /** Send the user to the release page. */
  openExternal: (url: string) => void;
  /** A yes/no the user is waiting on. Resolves true when they said yes. */
  confirm: (options: {
    title: string;
    message: string;
    detail: string;
    confirmLabel: string;
  }) => Promise<boolean>;
  /** Tell the user something with no question attached. */
  inform: (options: { message: string; detail: string }) => void;
  /** Injected so tests drive the schedule with fake timers. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  log?: (message: string) => void;
}

export interface Updater {
  /** Schedule the first check and the recurring one. */
  start(): void;
  /** Look now. `origin` decides how the result is reported. */
  check(origin: 'auto' | 'menu'): Promise<void>;
  /** Begin the download the user just agreed to, or open the page instead. */
  download(): Promise<void>;
  /** Restart onto the staged version, or open the page if that is refused. */
  install(): Promise<void>;
  status(): UpdateStatus;
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const {
    engine,
    currentVersion,
    notify,
    openExternal,
    confirm,
    inform,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    log = (message) => console.error(message),
  } = deps;

  let capability = deps.capability;
  let state: UpdateStatus['state'] = capability.canCheck ? 'idle' : 'unsupported';
  let checked = false;
  let availableVersion: string | null = null;
  let percent: number | null = null;
  let error: string | null = null;

  /**
   * Guards a check against overlapping itself.
   *
   * The six-hour timer and the menu item can collide — a user who picks "Check
   * for updates" at the wrong second would otherwise run two checks, and on
   * macOS two concurrent Squirrel handshakes is a state nobody has tested. The
   * menu check is the one that loses, and it says so rather than appearing to
   * do nothing.
   */
  let inFlight = false;

  /**
   * A download is running.
   *
   * Separate from `inFlight`, which guards *checking*. Both exist because both
   * are reachable from more than one place: `download()` is called by the menu
   * path and by a clicked Inbox row, and nothing between them was stopping a
   * double-click from starting `autoUpdater.downloadUpdate()` twice —
   * electron-updater does not guard that itself.
   *
   * It also closes the nastier hole. `autoUpdater` is a singleton emitter and
   * emits `error` for a failed *check* as well as a failed download, so a
   * background check that fails while a download is in flight would reject the
   * download's promise and permanently demote the capability. Refusing to check
   * while downloading means the two can never overlap, which is a stronger fix
   * than trying to tell one `error` from another after the fact.
   */
  let downloading = false;

  const releaseUrl = (): string =>
    availableVersion === null ? RELEASES_URL : releaseUrlFor(availableVersion);

  const status = (): UpdateStatus => ({
    state,
    checked,
    currentVersion,
    availableVersion,
    percent,
    capability,
    releaseUrl: releaseUrl(),
    error,
  });

  const openReleasePage = (): void => {
    openExternal(releaseUrl());
  };

  /**
   * Announce a found release into the Inbox.
   *
   * The dedup id is the **version**, deliberately — not the moment it was
   * found. The checker runs every six hours and finds the same release every
   * time until it is installed, and an id carrying a timestamp would put a
   * fresh row in the inbox four times a day for one piece of news. Keyed on the
   * version, the hub's own dedup makes the announcement idempotent for free.
   */
  const announceAvailable = (version: string): void => {
    notify({
      kind: 'app.update_available',
      id: `app.update_available:${version}`,
      title: `Update available — ${version}`,
      body:
        capability.mode === 'self-install'
          ? `You're on ${currentVersion}. Click to download and install it.`
          : `You're on ${currentVersion}. Click to open the download page.`,
      action:
        capability.mode === 'self-install'
          ? { type: 'update.download' }
          : { type: 'url', url: releaseUrlFor(version) },
    });
  };

  const announceReady = (version: string): void => {
    notify({
      kind: 'app.update_ready',
      id: `app.update_ready:${version}`,
      title: `Update ready — ${version}`,
      body: 'Click to restart The Hive on the new version.',
      action: { type: 'update.install' },
    });
  };

  /**
   * The one place an in-place install is written off.
   *
   * Called from both the download and the install path, because macOS can
   * refuse at either. It demotes the capability — so nothing retries into the
   * same wall for the rest of the session — records the reason for the Settings
   * pane, and *still gets the user their update* by opening the page. A failed
   * self-install should cost a click, not the feature.
   */
  const fallBackToManual = (cause: unknown): void => {
    const message = cause instanceof Error ? cause.message : String(cause);
    capability = demoteToManual(capability, message.split('\n')[0].trim());
    state = 'available';
    percent = null;
    error = message;
    log(`[hive] in-place update refused, opening the release page: ${message}`);
    openReleasePage();
  };

  const download = async (): Promise<void> => {
    if (availableVersion === null) return;

    if (capability.mode === 'manual') {
      openReleasePage();
      return;
    }

    // Already running, or already finished and waiting on the restart. Either
    // way a second `downloadUpdate()` is not what the click meant.
    if (downloading || state === 'ready') return;

    downloading = true;
    state = 'downloading';
    percent = 0;
    error = null;

    try {
      await engine.download((next) => {
        percent = next;
      });
      state = 'ready';
      percent = 100;
      announceReady(availableVersion);
    } catch (cause) {
      fallBackToManual(cause);
    } finally {
      downloading = false;
    }
  };

  const check = async (origin: 'auto' | 'menu'): Promise<void> => {
    if (!capability.canCheck) {
      if (origin === 'menu') {
        inform({
          message: 'Updates are not available in this build.',
          detail: capability.reason,
        });
      }
      return;
    }

    if (inFlight || downloading) {
      if (origin === 'menu') {
        inform({
          message: downloading
            ? 'An update is already downloading.'
            : 'Already checking for updates.',
          detail: downloading
            ? `${
                availableVersion === null
                  ? 'It'
                  : `The Hive ${availableVersion}`
              } is on its way. You'll be told when it is ready to install.`
            : 'A check is in progress. Give it a moment and try again.',
        });
      }
      return;
    }

    /**
     * A staged update is not re-opened by a later look.
     *
     * The server goes on reporting the newer version until it is *installed*,
     * and nothing is installed until the user restarts — so the six-hourly
     * timer, or a press of "Check now", would find 0.2.0 again after 0.2.0 had
     * already been downloaded and would knock `state` back from `ready` to
     * `available`. The visible damage lands later and looks unrelated: the
     * "Update ready" row's `install()` sees a state that is no longer `ready`,
     * declines, and opens a web page for an update already sitting on disk —
     * while Settings re-offers the whole download.
     */
    if (state === 'ready' && availableVersion !== null) {
      if (origin === 'menu') {
        inform({
          message: `The Hive ${availableVersion} is ready to install.`,
          detail: 'Restart the app to finish updating.',
        });
      }
      return;
    }

    inFlight = true;
    state = 'checking';
    error = null;

    try {
      const found = await engine.check();

      if (found === null) {
        state = 'idle';
        checked = true;
        availableVersion = null;
        if (origin === 'menu') {
          inform({
            message: "You're up to date.",
            detail: `The Hive ${currentVersion} is the latest version.`,
          });
        }
        return;
      }

      availableVersion = found.version;
      checked = true;
      state = 'available';

      if (origin === 'auto') {
        announceAvailable(found.version);
        return;
      }

      /**
       * The menu path asks, and acts on the answer immediately.
       *
       * No Inbox row is raised here on purpose. The user is looking at a dialog
       * about this exact fact; adding a row that says the same thing would be
       * the app telling them twice and leaving one of the two unread.
       */
      const wanted = await confirm({
        title: 'Update The Hive',
        message: `The Hive ${found.version} is available.`,
        detail:
          capability.mode === 'self-install'
            ? `You're running ${currentVersion}. The update downloads in the background; the app restarts when you're ready.`
            : `You're running ${currentVersion}. ${capability.reason}`,
        confirmLabel:
          capability.mode === 'self-install' ? 'Download' : 'Open download page',
      });

      if (!wanted) return;
      /**
       * Started, not awaited.
       *
       * The dialog the user just accepted says the update downloads in the
       * background, and awaiting here would make that a lie in the one place it
       * is visible: Settings' "Check now" button stays disabled reading
       * "Checking…" for the whole multi-hundred-megabyte transfer, because the
       * pane only re-reads once this resolves. `download()` has its own
       * re-entrancy guard, so releasing the check lock underneath it is safe.
       */
      void download();
    } catch (cause) {
      state = 'error';
      error = cause instanceof Error ? cause.message : String(cause);
      log(`[hive] update check failed: ${error}`);
      if (origin === 'menu') {
        inform({
          message: 'Could not check for updates.',
          detail: error,
        });
      }
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      if (!capability.canCheck) return;
      setTimer(() => void check('auto'), UPDATE_FIRST_CHECK_DELAY_MS);
      setTimer(function repeat() {
        void check('auto');
        setTimer(repeat, UPDATE_CHECK_INTERVAL_MS);
      }, UPDATE_CHECK_INTERVAL_MS);
    },
    check,
    download,
    async install() {
      if (state !== 'ready' || capability.mode === 'manual') {
        openReleasePage();
        return;
      }
      /**
       * Awaited, and the await is the whole point.
       *
       * `quitAndInstall` returns immediately whether or not the swap will
       * happen, so a synchronous `try`/`catch` here caught nothing: the app
       * stayed running, having just told the user it was restarting onto a new
       * version, and said nothing further. The engine turns Squirrel's
       * asynchronous refusal into a rejection so it lands in `fallBackToManual`
       * and the user gets the download page instead of silence.
       */
      try {
        await engine.install();
      } catch (cause) {
        fallBackToManual(cause);
      }
    },
    status,
  };
}

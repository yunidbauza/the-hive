// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateCapability } from '../../../../electron/shared/update-contract';

import {
  createUpdater,
  type UpdateEngine,
  type UpdaterDeps,
} from '../../../../electron/main/updates/updater';

/**
 * The update *decisions*, with no bundle, no network and no signature.
 *
 * What is worth asserting here is everything the design turns on: that a
 * background check is silent when it finds nothing and a menu check never is,
 * that a release announces itself once rather than four times a day, and — the
 * one that justifies the whole two-path design — that a build refused at the
 * swap stops trying and starts sending the user to the download page.
 *
 * None of that is reachable through `electron-updater`, which is exactly why
 * `updater.ts` does not import it.
 */

const SELF_INSTALL: UpdateCapability = {
  canCheck: true,
  mode: 'self-install',
  reason: 'Signed with a Developer ID. Updates install themselves.',
};

/**
 * A build the probe cleared for self-install that macOS then refuses anyway.
 *
 * Ad-hoc no longer reaches this state — the probe sends it straight to manual,
 * because a real 0.1.0 → 0.1.1 update proved it can never install. What remains
 * is the case this guards: a Developer ID build refused at the swap for some
 * other reason, which must not leave the user staring at a restart that never
 * comes.
 */
const REFUSED_AT_SWAP: UpdateCapability = SELF_INSTALL;

const MANUAL: UpdateCapability = {
  canCheck: true,
  mode: 'manual',
  reason: 'This copy is not code signed…',
};

const DEV: UpdateCapability = {
  canCheck: false,
  mode: 'manual',
  reason: 'This is a development run.',
};

interface Harness {
  deps: UpdaterDeps;
  engine: { [K in keyof UpdateEngine]: ReturnType<typeof vi.fn> };
  notify: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  inform: ReturnType<typeof vi.fn>;
  timers: (() => void)[];
}

function harness(
  capability: UpdateCapability,
  found: { version: string } | null = { version: '0.2.0' },
): Harness {
  const engine = {
    check: vi.fn().mockResolvedValue(found),
    download: vi.fn().mockResolvedValue(undefined),
    // The real engine's `install` only ever rejects: on success the process is
    // replaced, so nothing resolves. A fake that resolves would let a broken
    // `install` look fine.
    install: vi.fn().mockReturnValue(new Promise(() => undefined)),
  };
  const notify = vi.fn();
  const openExternal = vi.fn();
  const confirm = vi.fn().mockResolvedValue(true);
  const inform = vi.fn();
  const timers: (() => void)[] = [];

  return {
    engine,
    notify,
    openExternal,
    confirm,
    inform,
    timers,
    deps: {
      engine: engine as unknown as UpdateEngine,
      capability,
      currentVersion: '0.1.0',
      notify,
      openExternal,
      confirm,
      inform,
      setTimer: (fn) => {
        timers.push(fn);
        return 0;
      },
      log: () => undefined,
    },
  };
}

describe('createUpdater — background checks', () => {
  it('announces a found release into the inbox, and says nothing when there is none', async () => {
    const withUpdate = harness(SELF_INSTALL);
    await createUpdater(withUpdate.deps).check('auto');
    expect(withUpdate.notify).toHaveBeenCalledTimes(1);
    expect(withUpdate.notify.mock.calls[0][0]).toMatchObject({
      kind: 'app.update_available',
      title: 'Update available — 0.2.0',
      action: { type: 'update.download' },
    });

    // The silence is the feature: nobody asked, so finding nothing is not news.
    const upToDate = harness(SELF_INSTALL, null);
    await createUpdater(upToDate.deps).check('auto');
    expect(upToDate.notify).not.toHaveBeenCalled();
    expect(upToDate.inform).not.toHaveBeenCalled();
  });

  it('keys the notification on the version, so six-hourly checks cannot spam one release', async () => {
    // The hub dedups on id. An id carrying the time of discovery would defeat
    // it and put the same news in the inbox four times a day.
    const h = harness(SELF_INSTALL);
    const updater = createUpdater(h.deps);

    await updater.check('auto');
    await updater.check('auto');

    const ids = h.notify.mock.calls.map((call) => call[0].id as string);
    expect(ids).toEqual([
      'app.update_available:0.2.0',
      'app.update_available:0.2.0',
    ]);
  });

  it('points the row at the release page when the bundle cannot install in place', async () => {
    const h = harness(MANUAL);
    await createUpdater(h.deps).check('auto');

    expect(h.notify.mock.calls[0][0]).toMatchObject({
      action: {
        type: 'url',
        url: 'https://github.com/yunidbauza/the-hive/releases/tag/v0.2.0',
      },
    });
  });

  it('does not claim to be up to date before it has looked', async () => {
    /**
     * `idle` is the state before the first check as well as after a check that
     * found nothing, and the Settings pane rendered both as "up to date" — a
     * claim the app had not established. Caught by opening the pane in the
     * packaged app while a newer release was already published.
     */
    const h = harness(SELF_INSTALL, null);
    const updater = createUpdater(h.deps);

    expect(updater.status()).toMatchObject({ state: 'idle', checked: false });

    await updater.check('auto');

    expect(updater.status()).toMatchObject({ state: 'idle', checked: true });
  });

  it('does not schedule anything at all in a build that cannot check', () => {
    const h = harness(DEV);
    createUpdater(h.deps).start();
    expect(h.timers).toHaveLength(0);
  });
});

describe('createUpdater — the menu', () => {
  it('answers "up to date" out loud, because a menu item that does nothing looks broken', async () => {
    const h = harness(SELF_INSTALL, null);
    await createUpdater(h.deps).check('menu');

    expect(h.inform).toHaveBeenCalledWith({
      message: "You're up to date.",
      detail: 'The Hive 0.1.0 is the latest version.',
    });
  });

  it('asks before downloading, and downloads only on yes', async () => {
    const yes = harness(SELF_INSTALL);
    await createUpdater(yes.deps).check('menu');
    expect(yes.confirm.mock.calls[0][0]).toMatchObject({
      message: 'The Hive 0.2.0 is available.',
      confirmLabel: 'Download',
    });
    expect(yes.engine.download).toHaveBeenCalledTimes(1);

    const no = harness(SELF_INSTALL);
    no.confirm.mockResolvedValue(false);
    await createUpdater(no.deps).check('menu');
    expect(no.engine.download).not.toHaveBeenCalled();
  });

  it('raises no inbox row for a menu check — the dialog already said it', async () => {
    const h = harness(SELF_INSTALL);
    h.confirm.mockResolvedValue(false);
    await createUpdater(h.deps).check('menu');
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('explains itself in a development run rather than failing quietly', async () => {
    const h = harness(DEV);
    await createUpdater(h.deps).check('menu');

    expect(h.inform).toHaveBeenCalledWith({
      message: 'Updates are not available in this build.',
      detail: 'This is a development run.',
    });
    expect(h.engine.check).not.toHaveBeenCalled();
  });

  it('reports a failed check to the person who asked, and stays quiet for the timer', async () => {
    const asked = harness(SELF_INSTALL);
    asked.engine.check.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await createUpdater(asked.deps).check('menu');
    expect(asked.inform.mock.calls[0][0]).toMatchObject({
      message: 'Could not check for updates.',
      detail: 'getaddrinfo ENOTFOUND',
    });

    const background = harness(SELF_INSTALL);
    background.engine.check.mockRejectedValue(new Error('offline'));
    const updater = createUpdater(background.deps);
    await updater.check('auto');
    expect(background.inform).not.toHaveBeenCalled();
    expect(updater.status().state).toBe('error');
  });
});

describe('createUpdater — download and install', () => {
  it('announces a finished download as a restart prompt', async () => {
    const h = harness(SELF_INSTALL);
    const updater = createUpdater(h.deps);

    await updater.check('auto');
    await updater.download();

    expect(h.notify.mock.calls[1][0]).toMatchObject({
      kind: 'app.update_ready',
      title: 'Update ready — 0.2.0',
      action: { type: 'update.install' },
    });
    expect(updater.status().state).toBe('ready');
  });

  it('installs only from `ready`, and never silently no-ops', async () => {
    const h = harness(SELF_INSTALL);
    const updater = createUpdater(h.deps);

    // Nothing downloaded yet: falling through to the release page is the
    // honest answer, and doing nothing would be the dishonest one.
    updater.install();
    expect(h.engine.install).not.toHaveBeenCalled();
    expect(h.openExternal).toHaveBeenCalledTimes(1);

    await updater.check('auto');
    await updater.download();
    updater.install();
    expect(h.engine.install).toHaveBeenCalledTimes(1);
  });

  it('opens the page instead of downloading when the bundle cannot install in place', async () => {
    const h = harness(MANUAL);
    const updater = createUpdater(h.deps);

    await updater.check('auto');
    await updater.download();

    expect(h.engine.download).not.toHaveBeenCalled();
    expect(h.openExternal).toHaveBeenCalledWith(
      'https://github.com/yunidbauza/the-hive/releases/tag/v0.2.0',
    );
  });
});

describe('createUpdater — a staged update is not lost', () => {
  it('does not let a later check knock a ready update back to available', async () => {
    /**
     * The server keeps reporting the newer version until it is *installed*, and
     * nothing is installed until the user restarts — so the six-hourly timer, or
     * a press of "Check now", used to find 0.2.0 again after 0.2.0 had already
     * been staged and reset `state` from `ready` to `available`.
     *
     * The damage lands later and looks unrelated: the "Update ready" row's
     * `install()` sees a state that is no longer `ready`, declines, and opens a
     * web page for an update already sitting on disk.
     */
    const h = harness(SELF_INSTALL);
    const updater = createUpdater(h.deps);

    await updater.check('auto');
    await updater.download();
    expect(updater.status().state).toBe('ready');

    await updater.check('auto');

    expect(updater.status().state).toBe('ready');
    expect(updater.status().availableVersion).toBe('0.2.0');

    void updater.install();
    expect(h.engine.install).toHaveBeenCalledTimes(1);
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it('tells a menu check that the update is already waiting, rather than re-offering it', async () => {
    const h = harness(SELF_INSTALL);
    const updater = createUpdater(h.deps);

    await updater.check('auto');
    await updater.download();
    h.confirm.mockClear();

    await updater.check('menu');

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.inform.mock.calls.at(-1)?.[0]).toMatchObject({
      message: 'The Hive 0.2.0 is ready to install.',
    });
  });

  it('starts one download however many times the row is clicked', async () => {
    // `autoUpdater.downloadUpdate()` is not re-entrant and electron-updater does
    // not guard it, so a double-click on the inbox row was two transfers.
    const h = harness(SELF_INSTALL);
    let finish: () => void = () => undefined;
    h.engine.download.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const updater = createUpdater(h.deps);
    await updater.check('auto');

    const first = updater.download();
    const second = updater.download();

    expect(h.engine.download).toHaveBeenCalledTimes(1);

    finish();
    await Promise.all([first, second]);
    expect(updater.status().state).toBe('ready');
  });

  it('refuses to check while a download is running, so the two cannot collide', async () => {
    /**
     * `autoUpdater` is one emitter and emits `error` for a failed *check* as
     * well as a failed download — so a background check that failed mid-download
     * would reject the download's promise and permanently demote the capability.
     * Keeping them from overlapping is a stronger fix than telling the two
     * errors apart after the fact.
     */
    const h = harness(SELF_INSTALL);
    h.engine.download.mockReturnValue(new Promise<void>(() => undefined));
    const updater = createUpdater(h.deps);
    await updater.check('auto');
    void updater.download();
    h.engine.check.mockClear();

    await updater.check('auto');
    expect(h.engine.check).not.toHaveBeenCalled();

    await updater.check('menu');
    expect(h.engine.check).not.toHaveBeenCalled();
    expect(h.inform.mock.calls.at(-1)?.[0]).toMatchObject({
      message: 'An update is already downloading.',
    });
  });
});

describe('createUpdater — a swap macOS refuses', () => {
  /**
   * The safety net, and the bug it was written for.
   *
   * Squirrel validates the signature at the **swap**, not at the download — so
   * a build can download cleanly, report itself ready, and then be refused. If
   * that refusal is not converted into a working manual path, the app has told
   * the user to expect a restart and delivers nothing.
   */
  it('falls back to the download page when macOS refuses the swap', async () => {
    const h = harness(REFUSED_AT_SWAP);
    h.engine.download.mockRejectedValue(
      new Error('Could not get code signature for running application'),
    );
    const updater = createUpdater(h.deps);

    await updater.check('auto');
    await updater.download();

    expect(h.openExternal).toHaveBeenCalledWith(
      'https://github.com/yunidbauza/the-hive/releases/tag/v0.2.0',
    );
    expect(updater.status().capability).toMatchObject({ mode: 'manual' });
    expect(updater.status().capability.reason).toContain(
      'macOS refused to install the update in place',
    );
  });

  it('stops attempting after one refusal', async () => {
    const h = harness(REFUSED_AT_SWAP);
    h.engine.download.mockRejectedValue(new Error('refused'));
    const updater = createUpdater(h.deps);

    await updater.check('auto');
    await updater.download();
    await updater.download();

    // Once, not twice: the second click took the manual path.
    expect(h.engine.download).toHaveBeenCalledTimes(1);
    expect(h.openExternal).toHaveBeenCalledTimes(2);
  });

  it('turns a refused swap into the download page rather than silence', async () => {
    /**
     * The bug this test exists for, found by driving a real 0.1.0 → 0.1.1
     * update: `quitAndInstall` returns immediately whether or not the swap will
     * happen, so the original synchronous `try`/`catch` caught nothing. The app
     * said "restart to install", the user clicked, and absolutely nothing
     * happened — no error, no restart, no explanation.
     */
    const h = harness(REFUSED_AT_SWAP);
    h.engine.install.mockRejectedValue(
      new Error(
        'Code signature at URL file:///…/The Hive.app/ did not pass validation: code failed to satisfy specified code requirement(s)',
      ),
    );
    const updater = createUpdater(h.deps);

    await updater.check('auto');
    await updater.download();
    expect(updater.status().state).toBe('ready');

    await updater.install();

    expect(h.openExternal).toHaveBeenCalledWith(
      'https://github.com/yunidbauza/the-hive/releases/tag/v0.2.0',
    );
    expect(updater.status().capability.mode).toBe('manual');
    expect(updater.status().capability.reason).toContain(
      'macOS refused to install the update in place',
    );
  });

  it('re-points a subsequent announcement at the page once demoted', async () => {
    const h = harness(REFUSED_AT_SWAP);
    h.engine.download.mockRejectedValue(new Error('refused'));
    const updater = createUpdater(h.deps);

    await updater.check('auto');
    await updater.download();
    await updater.check('auto');

    expect(h.notify.mock.calls.at(-1)?.[0]).toMatchObject({
      action: { type: 'url' },
    });
  });
});

describe('createUpdater — concurrency', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('refuses a second concurrent check rather than running two', async () => {
    const h = harness(SELF_INSTALL);
    let release: (value: { version: string } | null) => void = () => undefined;
    h.engine.check.mockReturnValue(
      new Promise<{ version: string } | null>((resolve) => {
        release = resolve;
      }),
    );
    const updater = createUpdater(h.deps);

    const first = updater.check('auto');
    await updater.check('menu');

    expect(h.inform.mock.calls[0][0]).toMatchObject({
      message: 'Already checking for updates.',
    });
    expect(h.engine.check).toHaveBeenCalledTimes(1);

    release(null);
    await first;
  });
});

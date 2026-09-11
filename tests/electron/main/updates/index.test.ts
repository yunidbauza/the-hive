// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The seam between boot and the updater (HIVE-147): a server's updater is
 * built unattended, and its engine leaves the relaunch to launchd.
 *
 * Everything with a platform behind it is faked; `updater.ts` is real, so
 * "unattended" is proven by what it does rather than by what it was passed.
 */

const exit = vi.fn();
vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', exit },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../../../../electron/main/aux-windows', () => ({ primaryWindow: () => undefined }));

vi.mock('../../../../electron/main/server/server-lock', () => ({
  claimServerLock: () => ({ kind: 'active' }),
  serverLockPath: () => '/tmp/never-used',
}));

vi.mock('../../../../electron/main/updates/capability', () => ({
  probeUpdateCapability: () =>
    Promise.resolve({ canCheck: true, mode: 'self-install', reason: 'Signed.' }),
  demoteToManual: vi.fn(),
}));

const engine = {
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
};
const createElectronUpdaterEngine = vi.fn(() => engine);
vi.mock('../../../../electron/main/updates/engine', () => ({ createElectronUpdaterEngine }));

const updates = await import('../../../../electron/main/updates');

describe('the updater a launch gets', () => {
  beforeEach(() => {
    updates.resetUpdater();
    createElectronUpdaterEngine.mockClear();
    engine.check.mockReset().mockResolvedValue({ version: '0.2.0' });
    engine.download.mockReset().mockResolvedValue(undefined);
    engine.install.mockReset().mockReturnValue(new Promise(() => undefined));
    exit.mockClear();
  });

  it('is attended by default, and Squirrel relaunches it', async () => {
    const updater = await updates.ensureUpdater();
    expect(createElectronUpdaterEngine).toHaveBeenCalledWith('0.1.0', { relaunch: true });

    await updater.check('auto');
    // A laptop asks first: a row, not a download.
    expect(engine.download).not.toHaveBeenCalled();
  });

  it('on a server, downloads and installs by itself once idle, relaunched by launchd', async () => {
    updates.runUnattended(() => true);
    const updater = await updates.ensureUpdater();
    expect(createElectronUpdaterEngine).toHaveBeenCalledWith('0.1.0', { relaunch: false });

    await updater.check('auto');
    expect(engine.download).toHaveBeenCalledTimes(1);
    expect(engine.install).toHaveBeenCalledTimes(1);
  });

  it('forgets the server setting on reset, so one suite cannot leak it into the next', async () => {
    updates.runUnattended(() => true);
    updates.resetUpdater();
    await updates.ensureUpdater();
    expect(createElectronUpdaterEngine).toHaveBeenCalledWith('0.1.0', { relaunch: true });
  });

  it('passes the relaunch choice through to the headless command', async () => {
    await updates.runHeadlessUpdate({ relaunch: false });
    expect(createElectronUpdaterEngine).toHaveBeenCalledWith('0.1.0', { relaunch: false });
    // The faked lock says a server is running, so the command refuses.
    expect(exit).toHaveBeenCalledWith(5);
  });
});

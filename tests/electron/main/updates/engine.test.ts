// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who relaunches the app after an update (HIVE-147).
 *
 * On a laptop, Squirrel does: without it an update quits to an empty desktop.
 * On a server, launchd does, and a copy Squirrel also started would be a second
 * server launchd cannot see. The rest of this file is adaptation no unit test
 * reaches, which is why `engine.ts` is otherwise untested.
 */

const autoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  once: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  quitAndInstall: vi.fn(),
};

vi.mock('electron-updater', () => ({ default: { autoUpdater } }));

const { createElectronUpdaterEngine } = await import(
  '../../../../electron/main/updates/engine'
);

describe('createElectronUpdaterEngine — install', () => {
  beforeEach(() => {
    autoUpdater.quitAndInstall.mockClear();
  });

  it('asks Squirrel to relaunch by default', () => {
    void createElectronUpdaterEngine('0.1.0').install();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('leaves the relaunch to launchd on a server', () => {
    void createElectronUpdaterEngine('0.1.0', { relaunch: false }).install();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, false);
  });

  it('never downloads or installs behind the user', () => {
    createElectronUpdaterEngine('0.1.0');
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });
});

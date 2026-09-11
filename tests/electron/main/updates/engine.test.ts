// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

/**
 * Who relaunches the app after an update (HIVE-147).
 *
 * On a laptop, Squirrel does: without it an update quits to an empty desktop.
 * On a server, launchd does, and a copy Squirrel also started would be a second
 * server launchd cannot see. On macOS that is decided by
 * `autoRunAppAfterInstall`, never by `quitAndInstall`'s arguments, which
 * `MacUpdater` ignores. The rest of this file is adaptation no unit test
 * reaches, which is why `engine.ts` is otherwise untested.
 */

const autoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  autoRunAppAfterInstall: true,
  once: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  quitAndInstall: vi.fn(),
};

vi.mock('electron-updater', () => ({ default: { autoUpdater } }));

const { createElectronUpdaterEngine } = await import(
  '../../../../electron/main/updates/engine'
);

describe('createElectronUpdaterEngine', () => {
  it('on a laptop: Squirrel relaunches, and nothing installs behind the user', () => {
    createElectronUpdaterEngine('0.1.0');
    expect(autoUpdater.autoRunAppAfterInstall).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(autoUpdater.autoDownload).toBe(false);
  });

  it('on a server: launchd relaunches, and Squirrel holds the update before the quit', () => {
    createElectronUpdaterEngine('0.1.0', { relaunch: false });
    expect(autoUpdater.autoRunAppAfterInstall).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(autoUpdater.autoDownload).toBe(false);
  });

  it('installs through quitAndInstall', () => {
    void createElectronUpdaterEngine('0.1.0').install();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

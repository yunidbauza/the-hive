import { test as base, expect } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Geometry survives a real quit and relaunch (story 085).
 *
 * This spec deliberately does **not** use the `hive` fixture: the fixture gives
 * one app per test, and the only honest proof here is two launches against the
 * same profile with a genuine `close()` in between. Anything less asserts that
 * the state file was written, not that the window comes back.
 */
const test = base;

test('resize, move, quit, relaunch — the window returns to the same place', async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath('user-data');
  const configPath = testInfo.outputPath('hive-config.json');
  const target = { x: 240, y: 160, width: 1320, height: 840 };

  const first = await launchHive({ userDataDir, configPath });
  const firstWindow = await first.firstWindow();
  await firstWindow.waitForLoadState('domcontentloaded');

  await first.evaluate(
    ({ BrowserWindow }, bounds) =>
      BrowserWindow.getAllWindows()[0]!.setBounds(bounds),
    target,
  );
  // The write is debounced (story 081); `close` flushes it.
  await firstWindow.waitForTimeout(700);
  await first.close();

  const second = await launchHive({ userDataDir, configPath });
  const secondWindow = await second.firstWindow();
  await secondWindow.waitForLoadState('domcontentloaded');

  const restored = await second.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getBounds(),
  );
  await second.close();

  expect(restored).toEqual(target);
});

test('a fresh profile opens at the default size, not at zero', async ({}, testInfo) => {
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath: testInfo.outputPath('hive-config.json'),
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const bounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getBounds(),
  );
  await app.close();

  expect(bounds.width).toBe(1440);
  expect(bounds.height).toBe(900);
});

test('a saved rect on a disconnected display falls back to a visible window', async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath('user-data');
  const configPath = testInfo.outputPath('hive-config.json');

  // Hand-write state for a monitor that is not attached. This is the failure
  // that looks exactly like a hang: the app runs, and there is nothing on
  // screen (story 081).
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'window-state.json'),
    JSON.stringify({
      rect: { x: 9000, y: 6000, width: 1440, height: 900 },
      maximized: false,
    }),
  );

  const app = await launchHive({ userDataDir, configPath });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const onScreen = await app.evaluate(({ BrowserWindow, screen }) => {
    const bounds = BrowserWindow.getAllWindows()[0]!.getBounds();
    return screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      const overlapWidth =
        Math.min(bounds.x + bounds.width, area.x + area.width) -
        Math.max(bounds.x, area.x);
      const overlapHeight =
        Math.min(bounds.y + bounds.height, area.y + area.height) -
        Math.max(bounds.y, area.y);
      return overlapWidth > 96 && overlapHeight > 48;
    });
  });
  await app.close();

  expect(onScreen).toBe(true);
});

test('each test gets its own profile — the developer’s window is never moved', async ({}, testInfo) => {
  // Running the suite twice must give identical results, which it cannot if
  // specs share ~/Library/Application Support/the-hive.
  const userDataDir = testInfo.outputPath('user-data');
  const app = await launchHive({
    userDataDir,
    configPath: testInfo.outputPath('hive-config.json'),
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const inUse = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath('userData'),
  );
  await app.close();

  expect(inUse).toBe(userDataDir);
});

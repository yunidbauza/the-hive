import { join } from 'node:path';

import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * The Electron fixture — the ONLY place this suite touches Electron-specific
 * Playwright API (story 085).
 *
 * Playwright's Electron support is officially **experimental**. The mitigation
 * is not optimism: `@playwright/test` is pinned exactly, the used surface is
 * kept small (`launch`, `firstWindow`, `evaluate`, `close`), and every call
 * into it is confined here — so a breaking change upstream is a one-file fix
 * rather than a suite-wide one.
 */

const APP_ROOT = join(import.meta.dirname, '../../../..');
const MAIN_ENTRY = join(APP_ROOT, 'out/main/index.js');

/**
 * Launch the built app against a specific profile.
 *
 * Exported because `window-state.spec.ts` needs **two** launches sharing one
 * `userData` directory — a real quit-and-relaunch cycle is the only way to
 * prove geometry survives — and the story requires every Electron-specific
 * call to stay in this file.
 */
export async function launchHive({
  userDataDir,
  configPath,
}: {
  userDataDir: string;
  configPath: string;
}): Promise<ElectronApplication> {
  return electron.launch({
    args: [
      MAIN_ENTRY,
      /**
       * A per-test `userData` directory, via Electron's own switch rather than
       * an environment variable the main process would have to be taught to
       * read.
       *
       * Window state persists (story 081). Sharing the real directory means
       * test order changes results, and a local run moves the developer's
       * actual window.
       */
      `--user-data-dir=${userDataDir}`,
    ],
    env: {
      ...process.env,
      /**
       * Disables the simulation clock and animation-driven timing — the same
       * determinism concern `?sim=0` handles for the web project (story 061).
       */
      HIVE_E2E: '1',
      /**
       * Overrides `~/.hive/config.json` (story 090) so specs point at a scratch
       * fixture repo and never at the developer's real projects. A suite that
       * can spawn `claude` in a real working tree is a suite that can commit
       * to it.
       */
      HIVE_CONFIG_PATH: configPath,
    },
  });
}

export const test = base.extend<{ hive: ElectronApplication; page: Page }>({
  hive: async ({}, use, testInfo) => {
    const app = await launchHive({
      userDataDir: testInfo.outputPath('user-data'),
      configPath: testInfo.outputPath('hive-config.json'),
    });

    await use(app);
    await app.close();
  },

  page: async ({ hive }, use) => {
    const window = await hive.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

export { expect };

/**
 * Read the terminal the only honest way.
 *
 * The gotchas from `docs/terminal-architecture.md` carry over, and cost time
 * when rediscovered: xterm 6 uses the **DOM renderer**, so there is no canvas
 * to screenshot for content, and `.xterm-viewport` reports
 * `scrollHeight === clientHeight` at every scroll position. Which lines are on
 * screen is the only observable, so specs read `.xterm-rows > div` text.
 *
 * With a real PTY (story 096) output is asynchronous and chunked, so this is a
 * polling `expect`, never a single read after a fixed timeout.
 */
export async function waitForTerminalText(
  page: Page,
  pattern: RegExp,
  terminalId?: string,
): Promise<void> {
  const rows: Locator = terminalId
    ? page.locator(`[data-terminal-id="${terminalId}"] .xterm-rows`)
    : page.locator('.xterm-rows').first();

  await expect
    .poll(async () => (await rows.innerText()).replace(/ /g, ' '), {
      timeout: 15_000,
    })
    .toMatch(pattern);
}

import { writeFileSync } from 'node:fs';
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
  env: extraEnv,
}: {
  userDataDir: string;
  configPath: string;
  /**
   * Extra environment for the launched app (HIVE-67).
   *
   * `jira-settings.spec.ts` needs a launch with `JIRA_API_KEY` set, because the
   * `env` credential state is only reachable through the real process
   * environment. Merged last, so a spec can override anything below it, and
   * kept here rather than in the spec so every Electron-specific call stays in
   * this file.
   */
  env?: Record<string, string>;
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
      ...extraEnv,
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

/**
 * A stub that stands in for the agent, and never for a moment the real one.
 *
 * `claudeCommand` defaults to `'claude'` (`config-contract.ts`), and
 * `sessionCommand` bootstraps it as `claude … && exit` **in the mapped
 * directory**. A config that omits it therefore starts a real agent session in
 * whatever directory the spec mapped — which for `chrome.spec.ts` is this
 * repository. That would consume tokens and touch the working tree, which is
 * why every hand-written spec config already stubs it.
 *
 * `; false` is not decoration. The bootstrap is `claude && exit`, so a stub that
 * ends cleanly takes the login shell with it and leaves no shell to type into.
 * Ending badly short-circuits the `&&` and keeps the session open.
 */
const STUB_CLAUDE_COMMAND = 'true; false';

/**
 * Write a config declaring one project, mapped to a directory that exists.
 *
 * The companion to {@link startSession}: a session can only be started on a
 * *mapped* project, and the app no longer arrives with any. Specs that only
 * need "somewhere spawnable" say so with this rather than hand-rolling a
 * config-file literal apiece.
 *
 * `shell` and `claudeCommand` are pinned rather than left to defaults, for the
 * reason {@link STUB_CLAUDE_COMMAND} gives — and `sh`, not the user's `$SHELL`,
 * because zsh and bash differ in prompt behaviour and a suite that passes only
 * on the author's machine is worthless.
 */
export function writeProjectConfig(
  configPath: string,
  { id, path }: { id: string; path: string },
): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 2,
      shell: '/bin/sh',
      claudeCommand: STUB_CLAUDE_COMMAND,
      projects: [{ id, name: id, path, icon: 'ph-cube' }],
    }),
  );
}

/**
 * Start a real session on a mapped project, through the picker, and answer with
 * its id.
 *
 * ## Why the suite needs this now
 *
 * Specs used to open a session by clicking one. Ten sessions were seeded into
 * the store at boot, so `hero-refresh` was simply on screen and a spec could
 * click its rail row and get a live terminal. The app boots with an empty fleet
 * — that seed is what made the header count sessions nobody had started — so a
 * session has to be *created* before it can be opened.
 *
 * This is closer to what these specs always claimed to test. "Opening a session
 * runs a real shell in the mapped project" now begins by starting one, rather
 * than by clicking a fixture the store had pre-arranged.
 *
 * ## The returned id
 *
 * `sess-01`, `sess-02`, … in spawn order. Every spec launches its own app, so
 * the first call in a test is always `sess-01` — but the id is returned rather
 * than assumed, so a spec that starts two sessions need not know the format.
 */
export async function startSession(
  page: Page,
  projectQuery: string,
): Promise<string> {
  await page.getByRole('button', { name: 'New session' }).click();

  const search = page.getByRole('textbox', { name: 'Search all projects' });
  await expect(search).toBeFocused();

  // The keyboard path story 044 specifies: type enough to identify the project,
  // then Enter takes the first match.
  await page.keyboard.type(projectQuery);
  await page.keyboard.press('Enter');

  const terminal = page.locator('[data-terminal-id^="sess-"]').last();
  await expect(terminal).toBeVisible();

  const id = await terminal.getAttribute('data-terminal-id');
  if (id === null) throw new Error('the spawned session has no terminal id');
  return id;
}

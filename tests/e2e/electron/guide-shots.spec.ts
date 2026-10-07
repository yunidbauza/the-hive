import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
} from '../../../electron/shared/hook-contract';
import { LEDGER_POST_PATH } from '../../../electron/shared/ledger-contract';
import { BOOT, goToOvermind, goToPlace, openConsole, overmindNewSession } from '../fixtures/places';

import { launchHive, mainWindow, setContentSize } from './fixtures/hive-app';

/**
 * Retakes the guide screenshots (HIVE-213). Not part of `test:e2e`: skipped unless
 * HIVE_GUIDE_SHOTS=1 (`pnpm docs:shots`, after `desktop:build`). Fixed 1440×900, dark theme
 * (the default), light for shot 22.
 *
 * Each shot is the state its guide's caption describes, reached the way a person would:
 * through the bar, the Overmind and the session panel. The asks in shot 05 are posted from
 * the session's own shell through the receiver, as `ask-card.spec.ts` posts its own.
 */
test.skip(process.env['HIVE_GUIDE_SHOTS'] !== '1', 'set HIVE_GUIDE_SHOTS=1 (pnpm docs:shots)');

const REAL_DIRECTORY = join(import.meta.dirname, '../../..');
const OUT = join(REAL_DIRECTORY, 'docs/assets/guide');
const HERO = join(REAL_DIRECTORY, 'docs/assets/screenshot.png');
const SESSION = 'sess-01';

const readMarker = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8').trim() : null;

async function expectMarker(path: string, contents: string): Promise<void> {
  await expect.poll(() => readMarker(path), { timeout: 15_000 }).toBe(contents);
}

/** Two projects on real directories, and a stub agent that marks its own start. */
function writeConfig(path: string, bootstrapMarker: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      shell: '/bin/sh',
      // `; false` keeps the login shell open (see `hive-app.ts`, STUB_CLAUDE_COMMAND).
      claudeCommand: `printf bootstrapped > '${bootstrapMarker}'; false`,
      projects: [
        { id: 'nova-web', name: 'nova-web', path: REAL_DIRECTORY, icon: 'ph-cube' },
        { id: 'hive-docs', name: 'hive-docs', path: join(REAL_DIRECTORY, 'docs'), icon: 'ph-book' },
      ],
    }),
  );
}

/** Send a line to the session's pty, as a keystroke would. */
async function shell(page: Page, command: string): Promise<void> {
  await page.evaluate(
    ([sessionId, data]) => {
      window.hive!.pty.write({ sessionId: sessionId!, data: data! });
    },
    [SESSION, `${command}\n`],
  );
}

/** The curl the session's own hooks would run, with the HTTP status written to `statusMarker`. */
function postAsk(ask: Record<string, unknown>, statusMarker: string): string {
  return (
    `curl -sS -m 5 -o /dev/null -w '%{http_code}' -X POST "$${HOOK_ENV_RECEIVER_URL}${LEDGER_POST_PATH}"` +
    ` -H "${HOOK_HEADER_SESSION}: $${HOOK_ENV_SESSION}"` +
    ` -H "${HOOK_HEADER_TOKEN}: $${HOOK_ENV_TOKEN}"` +
    ` -H "content-type: application/json"` +
    ` --data-binary '${JSON.stringify({ to: 'overmind', kind: 'ask', ...ask })}'` +
    ` > '${statusMarker}'`
  );
}

/**
 * A neutral prompt over `ls`: the shell's own prompt and the commands typed so far would
 * print this machine's name and paths into a published image.
 */
async function cleanScreen(page: Page, marker: string): Promise<void> {
  await shell(page, `PS1='nova-web $ '; clear; ls; printf cleared > '${marker}'`);
  await expectMarker(marker, 'cleared');
  // The terminal draws to a canvas, so there is no text to wait on: give it a frame or two.
  await page.waitForTimeout(500);
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, name) });

test('guide shots', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapMarker = testInfo.outputPath('bootstrap.marker');
  writeConfig(configPath, bootstrapMarker);

  const app = await launchHive({ userDataDir: testInfo.outputPath('user-data'), configPath });
  const page = await mainWindow(app);
  await page.waitForSelector(BOOT);
  await setContentSize(app, 1440, 900);
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([1440, 900]);

  // 01: the Overmind with two projects mapped and nothing running.
  await goToOvermind(page);
  await shot(page, '01-empty-overmind.png');

  // 02: the new-session picker.
  await overmindNewSession(page).click();
  const search = page.getByRole('textbox', { name: 'Search all projects' });
  await expect(search).toBeFocused();
  await shot(page, '02-new-session-picker.png');

  // 03: a live session on the stage, the session panel beside it.
  await page.keyboard.type('nova');
  await page.keyboard.press('Enter');
  await expect(page.locator(`[data-terminal-id="${SESSION}"]`)).toBeVisible();
  await expectMarker(bootstrapMarker, 'bootstrapped');
  // The stub never reports ready, so lift the boot cover the way a person would: one keystroke.
  await page.keyboard.press('Shift');
  await expect(page.getByText('press any key to watch it boot')).toBeHidden();
  const panel = page.getByRole('complementary', { name: 'Session panel' });
  await expect(panel).toBeVisible();
  await cleanScreen(page, testInfo.outputPath('cleared.marker'));
  await shot(page, '03-session.png');

  // Two asks for the Inbox: a permission request with its scope ladder, and a question.
  const permission = testInfo.outputPath('permission.status');
  const question = testInfo.outputPath('question.status');
  await shell(
    page,
    postAsk(
      { body: 'Allow Bash?', meta: { kind: 'permission', tool: 'Bash', input: { command: 'pnpm test' } } },
      permission,
    ),
  );
  await expectMarker(permission, '200');
  await shell(
    page,
    postAsk({ body: 'Deploy nova-web to staging?', meta: { options: ['Deploy', 'Wait'] } }, question),
  );
  await expectMarker(question, '200');

  await cleanScreen(page, testInfo.outputPath('cleared-again.marker'));

  // The README's hero: a real Claude Code session, its panel, and the pill counting what
  // needs you. The stub above only bootstraps; the hero starts the real `claude` on PATH
  // and gives it a few seconds to draw, since the canvas has no text to wait on.
  await shell(page, 'clear; claude');
  await page.waitForTimeout(5_000);
  const pill = page.getByRole('button', { name: /^Inbox, / });
  await expect(pill).toBeVisible();
  await page.screenshot({ path: HERO });

  // 05: the drawer with both cards, which the split pill's Open all opens (HIVE-228).
  await page.getByRole('button', { name: 'Open all' }).click();
  const drawer = page.getByRole('dialog', { name: 'Needs you' });
  await expect(drawer.getByText('Deploy nova-web to staging?')).toBeVisible();
  await shot(page, '05-inbox-asks.png');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  // 04: the Files tab with README.md open in the editor.
  await panel.getByRole('tab', { name: /^Files/ }).click();
  await panel.locator('[data-panel="explorer"]').getByText('README.md', { exact: true }).click();
  await expect(page.locator('.cm-editor')).toBeVisible();
  await shot(page, '04-explorer-editor.png');
  await page.getByRole('button', { name: 'Close README.md' }).click();

  // 08: the Overmind with its console open and the help output.
  await openConsole(page);
  await page.getByRole('textbox', { name: 'Overmind command' }).fill('help');
  await page.keyboard.press('Enter');
  await shot(page, '08-overmind-console.png');

  // 09: the Agents place, its lanes in the list panel.
  await goToPlace(page, 'Agents');
  const agents = page.getByRole('region', { name: 'Agents list' });
  await expect(agents).toBeVisible();
  await shot(page, '09-agents-tab.png');

  // 10: one agent's page, on Activity.
  await agents.getByRole('button', { name: /^[a-z][a-z0-9-]*, / }).first().click();
  await expect(page.getByRole('main').getByRole('radio', { name: 'Activity' })).toBeVisible();
  await shot(page, '10-agent-view.png');

  // 22: Home in the Hive theme's light mode.
  await page.getByRole('navigation', { name: 'Places' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Appearance', exact: true })
    .click();
  await page.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name: 'Light' }).click();
  await page.keyboard.press('Escape');
  await goToPlace(page, 'Home');
  await shot(page, '22-light-theme.png');

  await app.close();
});

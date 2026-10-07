import { existsSync, readFileSync } from 'node:fs';
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
import { launchHive, writeProjectConfig } from './fixtures/hive-app';

/**
 * Round two's Inbox pill in the built app (HIVE-198).
 *
 * An ask posted from a real session's shell, through the receiver, as
 * `ask-card.spec.ts` posts one. What only the built app shows: the quiet rule
 * reading the real focused element, the card rising without taking it, the
 * card still up on the real clock past the old 5-second fold (HIVE-228), the
 * split pill, and answers from the drawer and the stack closing ledger threads.
 */

const PROJECT = 'nova-web';
const REAL_DIRECTORY = join(import.meta.dirname, '../../..');

const readMarker = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8').trim() : null;

async function expectMarker(path: string, contents: string): Promise<void> {
  await expect.poll(() => readMarker(path), { timeout: 15_000 }).toBe(contents);
}

/** Start a session from the filtered Overmind and answer with its id, as `session-panel.spec.ts` does. */
async function startRoundTwoSession(page: Page): Promise<string> {
  await page
    .getByRole('navigation', { name: 'Places' })
    .getByRole('button', { name: 'Sessions', exact: true })
    .click();
  await page
    .getByRole('region', { name: 'Sessions list' })
    .getByRole('button', { name: new RegExp(`^${PROJECT}`) })
    .click();
  await page
    .getByRole('main')
    .getByRole('button', { name: `New session in ${PROJECT}`, exact: true })
    .click();
  const terminal = page.locator('[data-terminal-id^="sess-"]').last();
  await expect(terminal).toBeVisible();
  const id = await terminal.getAttribute('data-terminal-id');
  if (id === null) throw new Error('the spawned session has no terminal id');
  return id;
}

async function shell(page: Page, sessionId: string, command: string): Promise<void> {
  await page.evaluate(
    ([id, data]) => {
      window.hive!.pty.write({ sessionId: id!, data: data! });
    },
    [sessionId, `${command}\n`],
  );
}

/** The ask a session's own hook would post, from the environment the app injected. */
function postAskCommand(body: string, options: string[], statusMarker: string): string {
  const payload = JSON.stringify({ to: 'overmind', kind: 'ask', body, meta: { options } });
  return (
    `curl -sS -m 5 -o /dev/null -w '%{http_code}' -X POST "$${HOOK_ENV_RECEIVER_URL}${LEDGER_POST_PATH}"` +
    ` -H "${HOOK_HEADER_SESSION}: $${HOOK_ENV_SESSION}"` +
    ` -H "${HOOK_HEADER_TOKEN}: $${HOOK_ENV_TOKEN}"` +
    ` -H "content-type: application/json"` +
    ` --data-binary '${payload}'` +
    ` > '${statusMarker}'`
  );
}

test('an ask rises without taking the keyboard, stays until handled, and is answered from the drawer and the stack', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeProjectConfig(configPath, { id: PROJECT, path: REAL_DIRECTORY });
  const app = await launchHive({ userDataDir: testInfo.outputPath('user-data'), configPath });
  const page = await app.firstWindow();

  try {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('nav[aria-label="Places"]');
    const session = await startRoundTwoSession(page);

    // The keyboard is in the session's terminal: the quiet rule.
    await page.locator(`[data-terminal-id="${session}"]`).click();
    const first = testInfo.outputPath('posted-1.txt');
    await shell(page, session, postAskCommand('Run the ledger tests?', ['yes', 'no'], first));
    await expectMarker(first, '200');

    await expect(page.getByRole('button', { name: 'Inbox, 1 needs you' })).toBeVisible();
    await expect(page.getByRole('article', { name: /^Ask from / })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('inbox-pill-quiet.png') });

    // The keyboard off the terminal (on Home, which has none): this one rises.
    await page
      .getByRole('navigation', { name: 'Places' })
      .getByRole('button', { name: 'Home', exact: true })
      .click();
    const second = testInfo.outputPath('posted-2.txt');
    await shell(page, session, postAskCommand('Ship it?', ['Merge', 'Not yet'], second));
    await expectMarker(second, '200');

    const card = page.getByRole('article', { name: /^Ask from .*: Ship it\?/ });
    await expect(card).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('inbox-pill-card.png') });
    expect(await page.evaluate(() => document.activeElement?.closest('article') ?? null)).toBeNull();

    // Untouched, it stays: nothing folds it on a timer (HIVE-228).
    await page.mouse.move(0, 0);
    await page.waitForTimeout(6000);
    await expect(card).toBeVisible();
    const pill = page.getByRole('button', { name: 'Inbox, 2 need you' });
    await expect(pill).toHaveAttribute('aria-expanded', 'true');

    // ✕ folds the stack into the pill, and the count stays: nothing was answered.
    await card.getByRole('button', { name: 'Fold into the pill' }).click();
    await expect(card).toBeHidden();
    await expect(pill).toHaveAttribute('aria-expanded', 'false');

    // The count brings the stack back, newest on top.
    await pill.click();
    await expect(card).toBeVisible();

    // Answered from the drawer, which Open all opens.
    await page.getByRole('button', { name: 'Open all' }).click();
    const drawer = page.getByRole('dialog', { name: 'Needs you' });
    await expect(drawer).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('inbox-drawer.png') });
    await drawer.getByRole('button', { name: 'Merge' }).click();
    await expect(drawer.getByText('1 ask · 0 sessions')).toBeVisible();

    // The answered card leaves with its reason for one beat, then goes (HIVE-218).
    // Answered in this window, on a machine that is not serving: plain "answered".
    const leaving = drawer.locator('[data-leaving="answered"]');
    await expect(leaving).toBeVisible();
    await expect(leaving).not.toContainText(' on ');
    await page.screenshot({ path: testInfo.outputPath('inbox-drawer-leaving.png') });
    await expect(leaving).toBeHidden({ timeout: 4000 });

    // One left: the pill is the count alone, and answering in the stack empties the corner.
    await drawer.getByRole('button', { name: 'Close the inbox' }).click();
    const last = page.getByRole('button', { name: 'Inbox, 1 needs you' });
    await expect(page.getByRole('button', { name: 'Open all' })).toHaveCount(0);
    await last.click();
    const ledgerCard = page.getByRole('article', { name: /^Ask from .*: Run the ledger tests\?/ });
    await expect(ledgerCard).toBeVisible();
    await ledgerCard.getByRole('button', { name: 'yes' }).click();
    await expect(page.getByTestId('arrival-stack')).toBeHidden({ timeout: 4000 });
    await expect(last).toBeHidden();
  } finally {
    await app.close();
  }
});

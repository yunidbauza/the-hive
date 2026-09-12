import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
  HOOK_PATH,
} from '../../../electron/shared/hook-contract';
import { PLAN_GRACE_MS } from '../../../electron/shared/plan-contract';
import { launchHive } from './fixtures/hive-app';

/**
 * The plan rail in the real app (HIVE-181).
 *
 * A session's own task-tool hooks are posted from inside its shell, the way
 * `ask-card.spec.ts` posts a ledger ask: `curl` with the session id and token
 * the app put in that shell's environment, to the real receiver. What is
 * proven here and nowhere else is the layout claim — peeking the drawer never
 * resizes the terminal, and pinning it refits the terminal exactly once — so
 * the terminal's own `.xterm-screen` is watched by a page-side
 * `ResizeObserver` rather than trusted to a unit test (happy-dom lays nothing
 * out).
 *
 * Reduced motion is emulated so the pin is one width change, not a transition
 * of many: `motion-safe:` is what the rail animates under, and the claim is
 * about how many times the terminal refits, not how smoothly.
 */

const REAL_DIRECTORY = join(import.meta.dirname, '../../..');
const SESSION = 'sess-01';
const PROJECT = 'nova-web';

function writeConfig(path: string, bootstrapMarker: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      shell: '/bin/sh',
      claudeCommand: `printf bootstrapped > '${bootstrapMarker}'; false`,
      projects: [{ id: PROJECT, path: REAL_DIRECTORY }],
    }),
  );
}

const readMarker = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8').trim() : null;

async function expectMarker(path: string, contents: string): Promise<void> {
  await expect.poll(() => readMarker(path), { timeout: 15_000 }).toBe(contents);
}

async function shell(page: Page, command: string): Promise<void> {
  await page.evaluate(
    ([sessionId, data]) => {
      window.hive!.pty.write({ sessionId: sessionId!, data: data! });
    },
    [SESSION, `${command}\n`],
  );
}

/** A main-agent `PostToolUse` of a task tool, posted from the session's own shell. */
function postHookCommand(body: Record<string, unknown>, statusMarker: string): string {
  const payload = JSON.stringify({ hook_event_name: 'PostToolUse', ...body });
  return (
    `curl -sS -m 5 -o /dev/null -w '%{http_code}' -X POST "$${HOOK_ENV_RECEIVER_URL}${HOOK_PATH}"` +
    ` -H "${HOOK_HEADER_SESSION}: $${HOOK_ENV_SESSION}"` +
    ` -H "${HOOK_HEADER_TOKEN}: $${HOOK_ENV_TOKEN}"` +
    ` -H "content-type: application/json"` +
    ` --data-binary '${payload}'` +
    ` > '${statusMarker}'`
  );
}

const taskCreate = (id: string, subject: string) => ({
  tool_name: 'TaskCreate',
  tool_input: { subject, description: subject },
  tool_response: { task: { id, subject } },
});

const taskCompleted = (taskId: string) => ({
  tool_name: 'TaskUpdate',
  tool_input: { taskId, status: 'completed' },
  tool_response: { success: true, taskId, updatedFields: ['status'] },
});

test('the plan rail appears, peeks without a refit, pins with one, ticks, and leaves', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeConfig(configPath, bootstrapped);

  const app = await launchHive({ userDataDir: testInfo.outputPath('user-data'), configPath });
  const page = await app.firstWindow();
  let posts = 0;
  const post = async (body: Record<string, unknown>) => {
    posts += 1;
    const marker = testInfo.outputPath(`posted-${String(posts)}.txt`);
    await shell(page, postHookCommand(body, marker));
    await expectMarker(marker, '204');
  };

  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Search all projects' })).toBeFocused();
    await page.keyboard.type(PROJECT);
    await page.keyboard.press('Enter');

    await expect(page.locator(`[data-terminal-id="${SESSION}"]`)).toBeVisible();
    await expectMarker(bootstrapped, 'bootstrapped');

    // Appears.
    await post(taskCreate('1', 'Alpha'));
    await post(taskCreate('2', 'Beta'));
    await post(taskCreate('3', 'Gamma'));
    const rail = page.getByRole('button', { name: 'Plan, 0 of 3 done' });
    await expect(rail).toBeVisible();

    // The terminal's width, watched from inside the page.
    await page.evaluate((session) => {
      const screen = document.querySelector(`[data-terminal-id="${session}"] .xterm-screen`);
      if (screen === null) throw new Error('no .xterm-screen for the session');
      const probe = window as unknown as { __planResizes: number };
      probe.__planResizes = 0;
      let width = screen.getBoundingClientRect().width;
      new ResizeObserver(() => {
        const next = screen.getBoundingClientRect().width;
        if (next !== width) {
          width = next;
          probe.__planResizes += 1;
        }
      }).observe(screen);
    }, SESSION);
    const resizes = () =>
      page.evaluate(() => (window as unknown as { __planResizes: number }).__planResizes);

    await page.screenshot({ path: testInfo.outputPath('plan-rail-dark-rest.png') });

    // Peeks: the drawer shows over the terminal, and the terminal never refits.
    await rail.hover();
    const drawer = page.getByRole('region', { name: 'Plan' });
    await expect(drawer).toBeVisible();
    await page.waitForTimeout(500);
    expect(await resizes()).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('plan-rail-dark-peek.png') });

    // Pins: the rail widens once, and the terminal refits exactly once.
    await page.getByRole('button', { name: 'Pin plan' }).click();
    await page.mouse.move(0, 0);
    await expect(page.getByRole('button', { name: 'Unpin plan' })).toBeVisible();
    await expect(drawer).toBeVisible();
    await expect.poll(resizes, { timeout: 5_000 }).toBe(1);
    await page.waitForTimeout(500);
    expect(await resizes()).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('plan-rail-dark-pinned.png') });

    // The app's own theme attribute, restored after the light shot rather than
    // deleted: deleting it is not the same theme (HIVE-182).
    const theme = await page.evaluate(() => document.body.getAttribute('data-theme'));
    await page.evaluate(() => {
      document.body.dataset.theme = 'light';
    });
    await page.screenshot({ path: testInfo.outputPath('plan-rail-light-pinned.png') });
    await page.evaluate((original) => {
      if (original === null) document.body.removeAttribute('data-theme');
      else document.body.setAttribute('data-theme', original);
      document.body.setAttribute('data-density', 'compact');
    }, theme);
    // Compact narrows both rails, so the stage widens and the terminal refits.
    // The WebGL canvas clears when it is resized and repaints on the next
    // animation frame, so a shot taken straight after the flip caught a blank
    // pane: spec timing, not the app. Wait for the refit, then two frames.
    await expect.poll(resizes, { timeout: 5_000 }).toBeGreaterThan(1);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await page.screenshot({ path: testInfo.outputPath('plan-rail-dark-compact-pinned.png') });
    await page.evaluate(() => {
      document.body.removeAttribute('data-density');
    });

    await page.getByRole('button', { name: 'Unpin plan' }).click();
    await expect(page.getByRole('button', { name: /^Plan, / })).toBeVisible();

    // Ticks.
    await post(taskCompleted('1'));
    await expect(page.getByRole('button', { name: 'Plan, 1 of 3 done' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Task 1, done', includeHidden: true }).first()).toBeAttached();

    // All done, then gone once main's grace period ends.
    await post(taskCompleted('2'));
    await post(taskCompleted('3'));
    await expect(page.getByRole('button', { name: 'Plan, all done' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Plan, / })).toHaveCount(0, {
      timeout: PLAN_GRACE_MS + 2_000,
    });
  } finally {
    await app.close();
  }
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  test as base,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { launchHive, writeProjectConfig } from './fixtures/hive-app';

/**
 * A full fleet table scrolls, and never pushes the console off the stage.
 *
 * ## Why this is an e2e and could never have been a unit test
 *
 * The claim is entirely about **layout**: a scroll container that is allowed to
 * grow to its content height never scrolls, because its scroll box is exactly
 * as tall as what is inside it. happy-dom performs no layout, so a component
 * test can assert `overflow-y-auto` is in the class list and learn nothing at
 * all about whether the region can be scrolled — which is how a table that
 * swallowed the transcript and the prompt beneath it shipped past four thousand
 * green unit tests. That is `table-alignment.spec.ts`'s reason, one axis over:
 * both are a *relationship* between two pieces of markup that no single
 * component owns.
 *
 * Electron rather than the web project: the browser target has no bridge, so no
 * session history and no rows — `tests/e2e/web/` can only ever see the empty
 * fleet.
 */
const test = base;

const PROJECT = 'nova-web';
const REAL_DIRECTORY = join(import.meta.dirname, '../../..');

/**
 * As many rows as can be restored, which is `HISTORY_CAP` — twenty.
 *
 * More records than that in the file changes nothing: main prunes the ended
 * ones to twenty on read, and a record with no `endedAt` is stamped with one at
 * load precisely so a file claiming a session is still running cannot claim it
 * forever. Twenty rows are ~570px of table, which is why the window below is
 * resized: at the default 900 they fit, and a test that passes because its
 * content fits proves nothing about a fleet that does not.
 */
const ROWS = 20;

/**
 * The smallest window the app allows (`MIN_WINDOW_SIZE`, `electron/shared/window.ts`).
 *
 * Not an arbitrary small number — `setBounds` is clamped to it, so a spec that
 * asked for 500 would wait forever for a window that was never going to be
 * that short.
 */
const MIN_HEIGHT = 700;

/**
 * Resize, and **wait for the renderer to agree**.
 *
 * `table-alignment.spec.ts`'s note applies verbatim, one axis over: `setBounds`
 * is a main-process call that resolves when main returns, not when the renderer
 * has relaid out — and at the default 900px height every claim this spec makes
 * is trivially true, because twenty rows fit. That is the worst kind of
 * regression test: green at the size the regression does not happen at, while
 * claiming to have checked the size it does.
 */
async function resizeTo(
  app: ElectronApplication,
  page: Page,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, h: number) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({
        x: 0,
        y: 0,
        /*
          The app's default width. It used to be load-bearing: the console
          row carried a placeholder that soft-wrapped below this width, the
          row grew to three lines, and `↑↓` became caret motion inside the
          textarea rather than fleet navigation. The placeholder is gone and
          an empty row cannot wrap, so the width is now simply the one the
          app opens at — kept so the numbers below describe a real launch.
        */
        width: 1440,
        height: h,
      }),
    height,
  );
  await page.waitForFunction((h: number) => window.innerHeight === h, height);
}

/**
 * A session history of rows the app was quit around.
 *
 * `status: 'working'` with no `endedAt` is the shape a quit leaves behind: main
 * cannot observe an app close, so the record still claims to be running and the
 * renderer infers the ending at hydrate, filing the row as `done` with
 * `endedBy: 'app-closed'`. It is the cheapest fleet to write down, and it is a
 * real one — it is what every launch after a quit reads.
 *
 * `sessionUuid` is what makes each row `resumable`, which is worth having here
 * for a second reason: a resumable row reserves the Resume column, so the table
 * this spec measures is the widest one the app draws.
 */
function writeSessionHistory(userDataDir: string, count: number): void {
  mkdirSync(userDataDir, { recursive: true });
  const now = Date.now();
  const records = Array.from({ length: count }, (_, index) => ({
    id: `hist-${String(index).padStart(2, '0')}`,
    project: PROJECT,
    task: 'a session the app was quit around',
    status: 'working',
    sessionUuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    createdAt: now - (index + 1) * 3_600_000,
  }));
  writeFileSync(
    join(userDataDir, 'sessions.json'),
    `${JSON.stringify(records, null, 2)}\n`,
    'utf8',
  );
}

test('a fleet taller than the stage scrolls, and the console stays on screen', async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath('user-data');
  const configPath = testInfo.outputPath('hive-config.json');
  writeProjectConfig(configPath, { id: PROJECT, path: REAL_DIRECTORY });
  writeSessionHistory(userDataDir, ROWS);

  const app = await launchHive({ userDataDir, configPath });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  try {
    const table = page.getByTestId('session-table');
    /*
      By text rather than by role: this waits for the *hydrate* to have landed,
      and the newest restored row is the cheapest proof it has. Which element
      carries the name is `table-alignment.spec.ts`'s subject, not this one's.
    */
    await expect(table).toContainText(`hist-${ROWS - 1}`);

    await resizeTo(app, page, MIN_HEIGHT);

    /*
      The table is a scroll box, not a column that grew to fit. Asserted as a
      *relationship* between the two heights rather than against a pixel count:
      what matters is that the content is taller than the box it is drawn in,
      whatever the row height and the window come to.
    */
    const scrollable = await table.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    );
    expect(scrollable).toBeGreaterThan(0);

    /*
      And it really scrolls — a box whose overflow is clipped rather than
      scrollable reports the same two heights and moves nowhere.
    */
    const moved = await table.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(moved).toBeGreaterThan(0);

    /*
      The console is the point of the overmind: a table that pushes the prompt
      past the foot of the window takes away the one control on the screen. Its
      footer legend is the last thing on the stage, so it is what proves nothing
      was pushed out from under the clip — `toBeVisible` cannot say so on its
      own, because an element inside an `overflow-hidden` ancestor is still
      "visible" to Playwright when it has been laid out past the bottom edge.
    */
    const legend = page.getByTestId('console-hints');
    await expect(legend).toBeVisible();
    const belowTheFold = await legend.evaluate(
      (element) => element.getBoundingClientRect().bottom - window.innerHeight,
    );
    expect(belowTheFold).toBeLessThanOrEqual(0);

    /*
      And the transcript is still on the stage. The table taking every pixel it
      asks for is the same defect as the table taking the console's: the overmind
      is a table *and* a conversation, and either one at zero height is a broken
      screen.
    */
    const transcript = page.locator('[data-terminal-id="orch"]');
    const transcriptHeight = await transcript.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(transcriptHeight).toBeGreaterThan(0);

    /*
      And the caret drags the scroll box after it.

      The console prints what the arrow keys do, so a caret that walks off the
      bottom of the scroll box and stays there is the console telling the user
      something the screen does not do. Fifteen rows is past the fold at this
      window and short of the end of the list, so the assertion is about the
      scrolling and not about the clamp at the last row.
    */
    await page.getByRole('textbox', { name: 'Overmind command' }).focus();
    for (let step = 0; step < 15; step += 1) {
      await page.keyboard.press('ArrowDown');
    }

    const caret = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="session-row"]')];
      const selected = rows.find((element) =>
        element.className.includes('term-row-active'),
      );
      if (selected === undefined) return null;
      const box = selected.getBoundingClientRect();
      const scroller = document
        .querySelector('[data-testid="session-table"]')!
        .getBoundingClientRect();
      return {
        above: scroller.top - box.top,
        below: box.bottom - scroller.bottom,
      };
    });
    expect(caret).not.toBeNull();
    // Sub-pixel slack: row heights here are fractional.
    expect(caret!.above).toBeLessThanOrEqual(1);
    expect(caret!.below).toBeLessThanOrEqual(1);
  } finally {
    await app.close();
  }
});

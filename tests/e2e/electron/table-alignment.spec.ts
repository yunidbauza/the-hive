import { join } from 'node:path';

import { test as base, expect, type Page } from '@playwright/test';

import {
  launchHive,
  startSession,
  writeProjectConfig,
} from './fixtures/hive-app';

/**
 * The fleet table's `PR` header sits over the `PR` values (HIVE-100).
 *
 * ## Why this is an e2e and could never have been a unit test
 *
 * The column misaligned the moment Resume arrived (HIVE-93) as a sibling of the
 * row's button: it took width from the flex line that the header did not
 * reserve, so every row's cells shifted left of the words naming them, and `PR`
 * — last and narrowest — ended up a whole control adrift. Four thousand unit
 * tests were green throughout. They had to be: happy-dom performs no layout, so
 * a component test can prove the cell *exists* and never that it is under its
 * heading. This is the same reason `rail-alignment.spec.ts` and
 * `chip-alignment.spec.ts` exist, and the defect they were written for is the
 * same defect — a *relationship* between two pieces of markup that no single
 * component owns.
 *
 * ## Why geometry rather than DOM order
 *
 * Asserting the cells are in the right order in the markup would have passed
 * before the fix too. The header and the rows agreeing on an x is the actual
 * claim, and it is the one a user checks by looking at the screen.
 *
 * Electron rather than the web project: the browser target has no project
 * config and therefore no way to start a session, so the table has no rows to
 * align. `tests/e2e/web/` can only ever see the empty fleet.
 */
const test = base;

const PROJECT = 'nova-web';
const REAL_DIRECTORY = join(import.meta.dirname, '../../..');

/**
 * Every cell in the `PR` column — the header's and one per row.
 *
 * They are collected by the `data-col` handle the component carries for exactly
 * this, rather than by text: the header cell reads `PR`, a row's reads `—` or
 * `#123`, and nothing about those three strings says they belong to one column.
 */
async function prColumnXs(page: Page): Promise<number[]> {
  return page.locator('[data-col="pr"]').evaluateAll((cells) =>
    cells.map((cell) => cell.getBoundingClientRect().x),
  );
}

/**
 * Rounded before comparison, for `rail-alignment.spec.ts`'s reason: these are
 * fractional CSS pixels in a flex line whose free space is divided three ways,
 * and demanding an exact match would fail on a rounding difference rather than
 * on a layout regression.
 */
function alignedAt(xs: number[]): number {
  const distinct = new Set(xs.map((x) => Math.round(x)));
  expect(distinct.size).toBe(1);
  return [...distinct][0];
}

test('the PR header sits over the PR cells', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeProjectConfig(configPath, { id: PROJECT, path: REAL_DIRECTORY });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  try {
    await startSession(page, PROJECT);
    // Back to the table — `startSession` leaves the terminal on the stage.
    await page.getByRole('button', { name: 'Back to overmind' }).click();

    const xs = await prColumnXs(page);

    // The header plus the one row that exists.
    expect(xs).toHaveLength(2);
    alignedAt(xs);
  } finally {
    await app.close();
  }
});

/**
 * The case the bug was reported from: a table whose rows offer Resume.
 *
 * The screenshot that opened HIVE-100 is exactly this — five restored rows, each
 * with a `resume` beside it, and `PR` sitting above the resumes rather than
 * above the dashes. It takes a relaunch to reach, because a resumable row is
 * one the app outlived.
 */
test('the PR header still sits over the PR cells beside a resume control', async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath('user-data');
  const configPath = testInfo.outputPath('hive-config.json');
  writeProjectConfig(configPath, { id: PROJECT, path: REAL_DIRECTORY });

  const first = await launchHive({ userDataDir, configPath });
  const firstWindow = await first.firstWindow();
  await firstWindow.waitForLoadState('domcontentloaded');
  await firstWindow.waitForSelector('header');
  await startSession(firstWindow, PROJECT);

  // The ledger write is debounced at 400ms — `session-history.spec.ts` says
  // more about why this waits rather than trusting the shutdown flush.
  await firstWindow.waitForTimeout(700);
  await first.close();

  const second = await launchHive({ userDataDir, configPath });
  const page = await second.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  try {
    await expect(page.getByText('PREVIOUS RUN')).toBeVisible();

    /*
      Only meaningful if a resume control is actually on screen: the restored
      row is resumable **or** `terminated`, depending on a race the ledger
      documents and refuses to arbitrate (`session-history.spec.ts` spells it
      out). Skipping the other half is honest; asserting alignment against a
      table with no Resume column would be asserting the first test again while
      claiming to test this one.
    */
    const resume = page.getByRole('button', { name: /^resume / });
    test.skip(
      (await resume.count()) === 0,
      'the quit produced a terminated row — nothing to resume, so no Resume column',
    );

    const xs = await prColumnXs(page);
    const columnX = alignedAt(xs);

    /*
      And the column really did move left to make room, rather than the header
      and the rows both being wrong in the same way — which a shared x alone
      cannot rule out.
    */
    const resumeBox = await resume.first().boundingBox();
    expect(resumeBox).not.toBeNull();
    expect(columnX).toBeLessThan(resumeBox!.x);
  } finally {
    await second.close();
  }
});

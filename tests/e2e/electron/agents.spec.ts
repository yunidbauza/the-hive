import { writeFileSync } from 'node:fs';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * The Agents tab and the agent view, against the built app (HIVE-116).
 *
 * The unit suites prove each half against a store seeded by hand: a grouped
 * panel from three fixtures, a view from one entity, a run log from a line
 * batch. None of them answers what this file is for:
 *
 * - does a definition on disk reach the **rail**, grouped and labelled, through
 *   the real registry, the real IPC and the real store sync?
 * - does clicking that row put the agent view on the centre stage — and, the
 *   half no jsdom test can see, does it put *no terminal* there?
 * - does the two-column split actually lay out, and does it collapse when the
 *   stage is narrow rather than when the window is?
 *
 * No run is started here. Waking an agent spawns a real `claude`, which is
 * `pnpm test:agent`'s job (`tests/live/agent-conformance.test.ts`) and costs
 * money; this spec is about what the renderer draws around it.
 */

const EMPTY_CONFIG = JSON.stringify({ version: 2, projects: [] }, null, 2);

const DEFINITION = `---
name: slack-watcher
description: Watches the channel
icon: ChatCircleDots
wake:
  every: 5m
autonomy: ask
---
Read your ledger inbox first.
`;

async function launchWithConfig(outputPath: (name: string) => string): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const configPath = outputPath('hive-config.json');

  writeFileSync(configPath, EMPTY_CONFIG);

  const app = await launchHive({
    userDataDir: outputPath('user-data'),
    configPath,
    // Scratch skill roots, for the reason `agents-settings.spec.ts` gives: a
    // name installed on the developer's machine must not decide the result.
    env: { CLAUDE_CONFIG_DIR: outputPath('claude-config') },
  });
  const page = await app.firstWindow();

  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  return { app, page };
}

/** Author one agent through Settings › Agents, then come back out. */
async function authorAgent(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Agents' }).click();

  await page.getByRole('button', { name: '+ New agent' }).click();
  await page.getByRole('tab', { name: 'Source' }).click();
  await page.getByLabel('Agent source').fill(DEFINITION);
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('button', { name: /slack-watcher/ })).toBeVisible();

  await page.getByRole('button', { name: 'Close settings' }).click();
}

test('lists an authored agent in the rail, grouped by state', async ({}, testInfo) => {
  const { app, page } = await launchWithConfig((name) => testInfo.outputPath(name));

  try {
    await authorAgent(page);

    await page.getByRole('tab', { name: /Agents/ }).click();

    const panel = page.locator('[data-panel="agents"]');

    /*
      A definition that has never run rests, so it files under Sleeping — and
      the group header carries the count.

      `exact` on both: `getByText` matches case-insensitively by substring, so
      the header's `Sleeping` and the row meta's `sleeping` are each other's
      false positives.
    */
    await expect(panel.getByText('Sleeping', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: /slack-watcher/ })).toBeVisible();
    // The status is a word on screen, never colour alone.
    await expect(panel.getByText('sleeping', { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('opens the agent view — and no terminal — when the row is clicked', async ({}, testInfo) => {
  const { app, page } = await launchWithConfig((name) => testInfo.outputPath(name));

  try {
    await authorAgent(page);
    await page.getByRole('tab', { name: /Agents/ }).click();
    await page
      .locator('[data-panel="agents"]')
      .getByRole('button', { name: /slack-watcher/ })
      .click();

    const view = page.locator('[data-view="agent"]');

    await expect(view).toBeVisible();

    // The five facts, from a definition that has never run.
    for (const label of ['Status', 'Wake', 'Next', 'Today', 'Session']) {
      await expect(view.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(view.getByText('0 runs · $0.00')).toBeVisible();
    await expect(view.getByText('every 5m')).toBeVisible();

    /*
      The half no unit test can prove: nothing terminal-shaped is on the stage.

      An agent tab used to mount a session meta bar over a read-only xterm with
      a message row beneath it. A jsdom suite can assert those components are
      absent from a tree; only the built app can show that the surface a person
      actually sees is the agent view and nothing else.
    */
    await expect(page.getByTestId('session-meta-bar')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="terminal-surface"]:visible'),
    ).toHaveCount(0);
    await expect(page.getByLabel(/^Message /)).toHaveCount(0);

    // Its own input, which says what it does.
    await expect(view.getByText(/as the overmind/i)).toBeVisible();
    await expect(view.getByText(/not a terminal/i)).toBeVisible();

    /*
      And it fills the stage.

      The view and the (now empty) terminal region are siblings in one flex
      column, both `flex-1`, so leaving the region visible split the height in
      half and left the bottom of the stage blank. The first version of this
      spec asserted the two regions' relative positions and never that the view
      reached the bottom, which is exactly how that shipped past it.
    */
    const stage = page.getByRole('main');
    const stageBox = await stage.boundingBox();
    const viewBox = await view.boundingBox();

    if (stageBox === null || viewBox === null) {
      throw new Error('the stage did not lay out');
    }

    expect(viewBox.height).toBeGreaterThan(stageBox.height * 0.8);
  } finally {
    await app.close();
  }
});

test('lays the run log and the ledger side by side, and stacks them when the stage is narrow', async ({}, testInfo) => {
  const { app, page } = await launchWithConfig((name) => testInfo.outputPath(name));

  try {
    await authorAgent(page);
    await page.getByRole('tab', { name: /Agents/ }).click();
    await page
      .locator('[data-panel="agents"]')
      .getByRole('button', { name: /slack-watcher/ })
      .click();

    const log = page.locator('[data-region="run-log"]');
    const ledger = page.locator('[data-region="ledger"]');

    await expect(log).toBeVisible();
    await expect(ledger).toBeVisible();

    const wide = async () => ({
      log: await log.boundingBox(),
      ledger: await ledger.boundingBox(),
    });

    const before = await wide();

    if (before.log === null || before.ledger === null) {
      throw new Error('regions did not lay out');
    }

    // Side by side: the ledger starts to the right of the log, on the same row.
    expect(before.ledger.x).toBeGreaterThan(before.log.x);
    expect(Math.abs(before.ledger.y - before.log.y)).toBeLessThan(4);
    // And the log is the wider of the two — it is the elastic half.
    expect(before.log.width).toBeGreaterThan(before.ledger.width);

    /*
      Now narrow the *window* until the stage crosses 800px. A media query would
      also pass this; what makes the container query the right tool is that the
      rails are draggable, so the stage can be narrow inside a wide window. This
      asserts the collapse happens at all — `resolve-view` and the component
      tests carry the rest.
    */
    await page.setViewportSize({ width: 1100, height: 800 });

    const after = await wide();

    if (after.log === null || after.ledger === null) {
      throw new Error('regions did not lay out after resize');
    }

    // Stacked: the ledger is now below the log rather than beside it.
    expect(after.ledger.y).toBeGreaterThan(after.log.y);
  } finally {
    await app.close();
  }
});

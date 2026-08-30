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

/**
 * The fleet table's AGENTS group (HIVE-117).
 *
 * Here rather than in `session-table.test.tsx` for the reason
 * `table-alignment.spec.ts` states about its own column: happy-dom performs no
 * layout, so a component test can prove a cell **exists** and never that it
 * sits under the heading that names it. The whole design of this group is that
 * its columns are the *same* columns — an agent spends `PROJECT` and `BRANCH`
 * on its wake, and every column after that has to stay put — which is a claim
 * about geometry that only a real browser can answer.
 *
 * Still no run is started: waking an agent spawns a real `claude`, which is
 * `pnpm test:agent`'s job and costs money.
 */
test('lists agents in the fleet table, under a heading, in the same columns', async ({}, testInfo) => {
  const { app, page } = await launchWithConfig((name) => testInfo.outputPath(name));

  try {
    await authorAgent(page);

    const table = page.getByTestId('session-table');

    await expect(table.getByText(/AGENTS · 1/)).toBeVisible();

    const row = page.getByTestId('agent-row');

    await expect(row).toBeVisible();
    // The wake, in the two cells a session spends on its checkout.
    await expect(row.locator('[data-col="wake"]')).toHaveText('every 5m');
    // The status is a word on screen, never colour alone.
    await expect(row.locator('[data-col="status"]')).toHaveText('sleeping');
    // Never run, so the age cell says so rather than guessing.
    await expect(row.locator('[data-col="last-used"]')).toContainText('—');

    /*
      The columns line up with the header's, which is the claim the group's
      whole layout rests on. Rounded before comparing for
      `table-alignment.spec.ts`'s reason: these are fractional CSS pixels in a
      flex line whose free space is divided three ways, and an exact match would
      fail on a rounding difference rather than on a regression.
    */
    for (const col of ['status', 'last-used', 'pr']) {
      const xs = await page
        .locator(`[data-col="${col}"]`)
        .evaluateAll((cells) =>
          cells.map((cell) => Math.round(cell.getBoundingClientRect().x)),
        );

      // The header's cell and the agent's, at minimum.
      expect(xs.length).toBeGreaterThanOrEqual(2);
      expect(new Set(xs).size).toBe(1);
    }
  } finally {
    await app.close();
  }
});

test('opens the agent view from the fleet table row', async ({}, testInfo) => {
  const { app, page } = await launchWithConfig((name) => testInfo.outputPath(name));

  try {
    await authorAgent(page);

    await page.getByTestId('agent-row').getByRole('button').click();

    await expect(page.locator('[data-view="agent"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

/**
 * The console's `agents` verb, against the real registry and the real IPC.
 *
 * The store suite proves the row's text from a hand-seeded entity. What it
 * cannot prove is that a definition on **disk** reaches the console at all —
 * that is the registry, the `agents:list` channel and the store sync, and this
 * is the only place all three are real.
 */
test('prints the agents table in the console', async ({}, testInfo) => {
  const { app, page } = await launchWithConfig((name) => testInfo.outputPath(name));

  try {
    await authorAgent(page);

    const input = page.getByRole('textbox', { name: 'Overmind command' });

    await input.click();
    await input.fill('agents');
    await input.press('Enter');

    // The transcript is an xterm, read through its DOM renderer.
    const transcript = page.getByRole('main').locator('.xterm');

    await expect(transcript).toContainText('slack-watcher');
    await expect(transcript).toContainText('every 5m');
    await expect(transcript).toContainText('0 runs');
  } finally {
    await app.close();
  }
});

/**
 * Pause and resume, round-tripped through the real channels (HIVE-117).
 *
 * The unit suites drive a mocked bridge. This is the only place the click,
 * `agents:pause`, the write to `agents.json`, the `agents:status` push and
 * every surface that redraws from it are all the real ones. The ticket's
 * criterion is that the status round-trips "in the rail, the table and
 * `agents.json`" — the table is asserted here, and it is drawn from the file.
 */
test('pauses and resumes from the console, and the table agrees', async ({}, testInfo) => {
  const { app, page } = await launchWithConfig((name) => testInfo.outputPath(name));

  try {
    await authorAgent(page);

    const status = page.getByTestId('agent-row').locator('[data-col="status"]');
    const input = page.getByRole('textbox', { name: 'Overmind command' });
    const transcript = page.getByRole('main').locator('.xterm');

    await expect(status).toHaveText('sleeping');

    await input.click();
    await input.fill('pause slack-watcher');
    await input.press('Enter');

    // The table redraws from main's `agents:status` push, not a local guess.
    await expect(status).toHaveText('paused');

    /*
      And a wake is refused — the consequence the status exists to have. The
      refusal comes from `RunTracker.run`, so it proves the pause reached
      `agents.json` rather than only the renderer's copy of it.
    */
    await input.fill('run slack-watcher');
    await input.press('Enter');
    await expect(transcript).toContainText('is paused');

    await input.fill('resume slack-watcher');
    await input.press('Enter');
    await expect(status).toHaveText('sleeping');
  } finally {
    await app.close();
  }
});

/**
 * The agent view's own Pause control, wired in this story.
 *
 * Asserted against the **rail**, which is always on screen: the agent view has
 * no "Back to overmind" button — that control lives on a session's meta bar,
 * and HIVE-116 deliberately mounts no meta bar for an agent — so there is no
 * navigation back to the table from here, and none is needed. What matters is
 * that the click reached main and a second surface redrew from the push.
 */
test('pauses from the agent view, and the rail agrees', async ({}, testInfo) => {
  const { app, page } = await launchWithConfig((name) => testInfo.outputPath(name));

  try {
    await authorAgent(page);
    await page.getByRole('tab', { name: /Agents/ }).click();

    const panel = page.locator('[data-panel="agents"]');

    await expect(panel.getByText('sleeping', { exact: true })).toBeVisible();

    await panel.getByRole('button', { name: /slack-watcher/ }).click();
    await expect(page.locator('[data-view="agent"]')).toBeVisible();
    await page.getByRole('button', { name: /Pause/ }).click();

    await expect(panel.getByText('paused', { exact: true })).toBeVisible();
    // The control names the move, not the state — one button, not two.
    await expect(page.getByRole('button', { name: /Resume/ })).toBeVisible();
  } finally {
    await app.close();
  }
});

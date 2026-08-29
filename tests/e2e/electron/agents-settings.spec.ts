import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Settings › Agents against the built app (HIVE-114).
 *
 * The unit suites prove each half against fakes — a stubbed snapshot renders a
 * row, a mocked bridge routes a verb, a temp directory accepts a write — and
 * none of them answers the questions this file exists for:
 *
 * - does a definition typed in the pane reach `~/.hive/agents` as *bytes main's
 *   own parser accepts*, through the real IPC and the real guards?
 * - does a definition already on disk appear **without a restart**, which is
 *   what the watcher was added for and what no unit test can observe?
 * - does a refusal actually leave the disk alone?
 *
 * The agents root is `dirname(configPath())/agents`, and the harness points
 * `HIVE_CONFIG_PATH` at this test's own output directory — so everything below
 * lands in scratch space and never in the developer's real `~/.hive`. That is
 * the whole reason `agentsRoot()` is derived from the config path rather than
 * from `homedir()`.
 */

const EMPTY_CONFIG = JSON.stringify({ version: 2, projects: [] }, null, 2);

async function launchWithConfig(outputPath: (name: string) => string): Promise<{
  app: ElectronApplication;
  page: Page;
  configPath: string;
}> {
  const configPath = outputPath('hive-config.json');

  writeFileSync(configPath, EMPTY_CONFIG);

  const app = await launchHive({
    userDataDir: outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();

  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  return { app, page, configPath };
}

const openAgents = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Agents' }).click();
};

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

test('authors an agent through the pane and writes it to disk', async ({}, testInfo) => {
  const { app, page, configPath } = await launchWithConfig((name) =>
    testInfo.outputPath(name),
  );

  try {
    await openAgents(page);

    await expect(
      page.getByText(/write one and it will be listed here/i),
    ).toBeVisible();

    await page.getByRole('button', { name: '+ New agent' }).click();
    await page.getByRole('tab', { name: 'Source' }).click();
    await page.getByLabel('Agent source').fill(DEFINITION);
    await page.getByRole('button', { name: 'Save' }).click();

    // The row appears without a reload — the write is followed by a re-list.
    await expect(
      page.getByRole('button', { name: /slack-watcher/ }),
    ).toBeVisible();

    const written = readFileSync(
      join(dirname(configPath), 'agents', 'slack-watcher', 'AGENT.md'),
      'utf8',
    );

    expect(written).toBe(DEFINITION);
  } finally {
    await app.close();
  }
});

test('refuses a sub-minute wake interval and writes nothing', async ({}, testInfo) => {
  /**
   * The acceptance criterion in full: the refusal names the floor, **and** the
   * file is not written. A pane that reported the problem but wrote anyway
   * would pass every assertion but the last one.
   */
  const { app, page, configPath } = await launchWithConfig((name) =>
    testInfo.outputPath(name),
  );
  const target = join(dirname(configPath), 'agents', 'slack-watcher', 'AGENT.md');

  try {
    await openAgents(page);
    await page.getByRole('button', { name: '+ New agent' }).click();
    await page.getByRole('tab', { name: 'Source' }).click();
    await page
      .getByLabel('Agent source')
      .fill(DEFINITION.replace('every: 5m', 'every: 30s'));
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText(/minutes \(5m\)|faster than 1m/i)).toBeVisible();
    expect(existsSync(target)).toBe(false);
  } finally {
    await app.close();
  }
});

test('lists a definition written by hand, and drops it when the folder goes', async ({}, testInfo) => {
  /**
   * The watcher, which is the one thing in this story no unit test can prove:
   * the acceptance criteria say a folder deleted outside the app leaves the
   * list *without a restart*.
   */
  const { app, page, configPath } = await launchWithConfig((name) =>
    testInfo.outputPath(name),
  );
  const folder = join(dirname(configPath), 'agents', 'hand-written');

  try {
    await openAgents(page);

    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'AGENT.md'),
      DEFINITION.replace('slack-watcher', 'hand-written'),
    );

    await expect(
      page.getByRole('button', { name: /hand-written/ }),
    ).toBeVisible();

    const { rmSync } = await import('node:fs');

    rmSync(folder, { recursive: true, force: true });

    await expect(
      page.getByRole('button', { name: /hand-written/ }),
    ).toBeHidden();
  } finally {
    await app.close();
  }
});

test('an agent authored in the pane survives a restart', async ({}, testInfo) => {
  const outputPath = (name: string) => testInfo.outputPath(name);
  const first = await launchWithConfig(outputPath);

  try {
    await openAgents(first.page);
    await first.page.getByRole('button', { name: '+ New agent' }).click();
    await first.page.getByRole('tab', { name: 'Source' }).click();
    await first.page.getByLabel('Agent source').fill(DEFINITION);
    await first.page.getByRole('button', { name: 'Save' }).click();
    await expect(
      first.page.getByRole('button', { name: /slack-watcher/ }),
    ).toBeVisible();
  } finally {
    await first.app.close();
  }

  const app = await launchHive({
    userDataDir: outputPath('user-data'),
    configPath: outputPath('hive-config.json'),
  });

  try {
    const page = await app.firstWindow();

    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');
    await openAgents(page);

    await expect(
      page.getByRole('button', { name: /slack-watcher/ }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

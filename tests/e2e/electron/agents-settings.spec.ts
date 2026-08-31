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
    /*
      Point the *skill* roots at scratch too, not only the config.

      `skillNames` now reads `~/.claude/skills` and the user's installed
      plugins, so without this these specs validate against whatever happens to
      be installed on the machine running them: an agent or skill name that
      collides locally and not on CI passes here and fails there, with nothing
      in the spec to explain why. `CLAUDE_CONFIG_DIR` is Claude Code's own
      override and `claudeRoot()` honours it.

      Set here rather than in `launchHive` on purpose. Other specs in this
      project spawn a **real** `claude`, and relocating that binary's config
      directory out from under them is not this file's business.
    */
    env: { CLAUDE_CONFIG_DIR: outputPath('claude-config') },
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

test('adds a schedule time the presets do not offer, and saves it', async ({}, testInfo) => {
  /**
   * The Form tab driven for real, which is the half no unit test can settle.
   *
   * The pane used to tell the user outright to go and edit the file — "other
   * times can be added in the Source tab" — so this walks the path that
   * sentence stood in for: switch to the calendar mode, type a time no preset
   * offers, and watch it reach `~/.hive/agents` as bytes main's own parser
   * accepted. A jsdom test can assert the buffer; only this can assert that the
   * chip, the patch, the IPC, the validator and the disk all agree.
   */
  const { app, page, configPath } = await launchWithConfig((name) =>
    testInfo.outputPath(name),
  );

  try {
    await openAgents(page);
    await page.getByRole('button', { name: '+ New agent' }).click();
    await page.getByRole('tab', { name: 'Source' }).click();
    await page.getByLabel('Agent source').fill(DEFINITION);
    await page.getByRole('tab', { name: 'Form' }).click();

    await page.getByRole('radio', { name: 'on a schedule' }).click();
    await page.getByRole('button', { name: '+ time' }).click();
    await page.getByRole('textbox', { name: 'time' }).fill('07:30');
    await page.getByRole('textbox', { name: 'time' }).press('Enter');

    // Lit, and alongside the preset the mode switch seeded rather than instead
    // of it — the adder must not be a replacement for the chips.
    await expect(page.getByRole('button', { name: '07:30' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(
      page.getByRole('button', { name: /slack-watcher/ }),
    ).toBeVisible();

    const written = readFileSync(
      join(dirname(configPath), 'agents', 'slack-watcher', 'AGENT.md'),
      'utf8',
    );

    expect(written).toContain('at: [07:30, 09:00]');
    expect(written).not.toContain('every:');
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

/**
 * The form half, driven for real.
 *
 * Every other spec here goes through the Source tab, which means nothing has
 * ever exercised the controls themselves in a browser — and the controls are
 * where this story's work is. A picker that renders no options, a mode toggle
 * that writes both keys, or a grid that cannot be clicked would all leave the
 * unit tests green: they assert on plumbing against a happy-dom that performs
 * no layout, and a control nobody can reach still reports the right value.
 */
test('authors an agent through the form controls', async ({}, testInfo) => {
  const { app, page, configPath } = await launchWithConfig((name) =>
    testInfo.outputPath(name),
  );

  try {
    await openAgents(page);

    await page.getByRole('button', { name: '+ New agent' }).click();

    // The template seeds a roster name, so the form opens valid rather than
    // opening on a refusal the form itself cannot answer.
    const name = page.getByRole('textbox', { name: 'name' });
    await expect(name).toBeVisible();
    await name.fill('build-watcher');

    await page
      .getByRole('textbox', { name: 'description' })
      .fill('Watches the build.');

    // The icon is a picker: pick by the glyph's spoken name, not by typing.
    await page.getByRole('radio', { name: 'envelope' }).click();

    // Swap the interval mode for the calendar one, then choose a second time.
    await page.getByRole('radio', { name: 'on a schedule' }).click();
    await page.getByRole('button', { name: '17:00' }).click();
    await page.getByRole('button', { name: 'sat' }).click();
    await page.getByRole('button', { name: 'sun' }).click();

    await page.getByRole('button', { name: 'Save' }).click();

    await expect(
      page.getByRole('button', { name: /build-watcher/ }),
    ).toBeVisible();

    const written = readFileSync(
      join(dirname(configPath), 'agents', 'build-watcher', 'AGENT.md'),
      'utf8',
    );

    expect(written).toContain('name: build-watcher');
    expect(written).toContain('icon: ph-envelope');
    expect(written).toContain('at: [09:00, 17:00]');
    expect(written).toContain('days: [mon, tue, wed, thu, fri]');
    // The two modes are exclusive, so switching must have taken the other key
    // with it rather than leaving a file the parser refuses.
    expect(written).not.toContain('every:');
  } finally {
    await app.close();
  }
});

/**
 * The two fields HIVE-121 added, through the real form and onto real disk.
 *
 * The unit suite proves the controls render and patch a buffer. What it cannot
 * show is the half that matters here: `check` is drawn *only* in interval mode,
 * and the parser refuses `check:` beside `at:` — so a form that offered the
 * control on a schedule would write a file the very next Save refuses. That is
 * a round trip through the real registry, and only the built app makes it.
 */
test('writes check and a daily cap, and hides check on a schedule', async ({}, testInfo) => {
  const { app, page, configPath } = await launchWithConfig((name) =>
    testInfo.outputPath(name),
  );

  try {
    await openAgents(page);

    await page.getByRole('button', { name: '+ New agent' }).click();

    const name = page.getByRole('textbox', { name: 'name' });
    await expect(name).toBeVisible();
    await name.fill('cap-watcher');
    await page
      .getByRole('textbox', { name: 'description' })
      .fill('Watches, cheaply.');

    // The template opens in interval mode, so the control is there to use.
    const check = page.getByRole('radiogroup', { name: 'Check' });
    await expect(check).toBeVisible();

    await page.getByRole('radio', { name: 'always' }).click();
    await page.getByRole('textbox', { name: 'daily cap $' }).fill('0.50');

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('button', { name: /cap-watcher/ })).toBeVisible();

    const agentMd = join(dirname(configPath), 'agents', 'cap-watcher', 'AGENT.md');

    expect(readFileSync(agentMd, 'utf8')).toContain('check: always');
    expect(readFileSync(agentMd, 'utf8')).toContain('daily_usd: 0.50');

    /*
      Now the half a jsdom test cannot reach: switch to a fixed time and the
      control goes, taking its key with it — then Save, which is the parser
      actually accepting what the form produced. A `check:` left behind here
      would come back as a refusal on a file this pane had just written.
    */
    await page.getByRole('radio', { name: 'on a schedule' }).click();
    await expect(check).toHaveCount(0);

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('button', { name: /cap-watcher/ })).toBeVisible();

    const after = readFileSync(agentMd, 'utf8');

    expect(after).not.toContain('check:');
    expect(after).toContain('at: [09:00]');
    // The cap is not a wake key, so the mode switch must have left it alone.
    expect(after).toContain('daily_usd: 0.50');
  } finally {
    await app.close();
  }
});

/**
 * The bug the picker exists to make unreachable.
 *
 * `GLYPHS` is keyed `ph-robot`; the pane's old template wrote `icon: Robot`,
 * which missed it and drew the fallback question mark on the agent's own row.
 * Anything authored through the form now carries a name the registry resolves.
 */
test('seeds a new agent with an icon the registry can draw', async ({}, testInfo) => {
  const { app, page } = await launchWithConfig((name) =>
    testInfo.outputPath(name),
  );

  try {
    await openAgents(page);
    await page.getByRole('button', { name: '+ New agent' }).click();
    await page.getByRole('tab', { name: 'Source' }).click();

    await expect(page.getByLabel('Agent source')).toHaveValue(
      /icon: ph-[a-z-]+/,
    );
  } finally {
    await app.close();
  }
});

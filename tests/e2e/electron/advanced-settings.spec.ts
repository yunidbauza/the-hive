import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Advanced & diagnostics, driven through the real app (story 107).
 *
 * The unit suite proves the pieces against fakes — a mocked bridge routes a
 * verb, a stubbed snapshot renders a row. What it cannot say is whether main's
 * reset produces a file the reader accepts, or whether `appInfo()` answers with
 * real versions over a real channel. That is what this covers.
 *
 * **Reveal is deliberately not driven.** `shell.showItemInFolder` opens a real
 * Finder window on whatever machine is running the suite, which is not
 * something to do to CI. Its contract is covered where it can be: the preload
 * test asserts the channel and that no argument is forwarded, and
 * `security.spec.ts` asserts it is on the bridge's exact key set.
 *
 * `HIVE_CONFIG_PATH` points at a scratch file, so nothing here touches the
 * developer's own `~/.hive/config.json`.
 */

const openAdvanced = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Advanced' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Advanced', level: 2 }),
  ).toBeVisible();
};

/**
 * A config with one real project, a comment, and an unknown key.
 *
 * All three matter: reset is the one write that must discard *every* one of
 * them, and a seed carrying only projects would pass while the preservation
 * rule silently kept leaking through.
 */
function seed(outputPath: (name: string) => string) {
  const repoDir = outputPath('scratch-repo');
  mkdirSync(join(repoDir, '.git'), { recursive: true });

  const configPath = outputPath('hive-config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        '//mine': 'a comment reset is allowed to eat',
        version: 2,
        shell: '/bin/sh',
        futureKey: 'something this build does not know',
        projects: [
          { id: 'scratch-repo', name: 'scratch-repo', path: repoDir, icon: 'ph-folder' },
        ],
      },
      null,
      2,
    ),
  );

  return { configPath, repoDir };
}

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

test('reports the config path and this build’s versions', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  await expect(page.getByText(configPath)).toBeVisible();

  /*
    Real versions over a real channel — the unit test can only prove plumbing.

    `exact` throughout: unpackaged, `app.getPath('logs')` answers
    `~/Library/Logs/Electron`, so a loose "Electron" also matches the log path
    two groups below and the assertion stops meaning what it says.
  */
  await expect(page.getByText('Electron', { exact: true })).toBeVisible();
  await expect(page.getByText('Chromium', { exact: true })).toBeVisible();
  await expect(page.getByText(/writes no log file/i)).toBeVisible();

  // Nothing has spawned in this window, so the omitted-not-empty distinction
  // main keeps must reach the screen as a sentence.
  await expect(page.getByText(/no session has run yet/i)).toBeVisible();

  await app.close();
});

test('reload re-reads a file edited underneath the running app', async ({}, testInfo) => {
  const { configPath, repoDir } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  /*
    The whole reason this button exists. The epic declined a config watcher, so
    an edit made outside the app reaches it by exactly one route — and if that
    route did not work, the decision to decline the watcher would have left the
    product with no way to pick up a hand edit at all.
  */
  const second = testInfo.outputPath('scratch-repo-two');
  mkdirSync(join(second, '.git'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 2,
        projects: [
          { id: 'scratch-repo', name: 'scratch-repo', path: repoDir, icon: 'ph-folder' },
          { id: 'scratch-two', name: 'scratch-two', path: second, icon: 'ph-folder' },
        ],
      },
      null,
      2,
    ),
  );

  await page.getByRole('button', { name: 'Reload' }).click();

  await expect(page.getByText('Reloaded — 2 projects.')).toBeVisible();

  await app.close();
});

test('reset writes the template and empties the project list', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  // Prove there is something to lose before losing it.
  expect((read(configPath).projects as unknown[]).length).toBe(1);

  await openAdvanced(page);

  await page.getByRole('button', { name: 'Reset to template' }).click();
  await expect(
    page.getByRole('alertdialog', { name: 'Reset the config file?' }),
  ).toBeVisible();
  await expect(page.getByText(/1 project,/)).toBeVisible();

  await page.getByRole('button', { name: 'Reset config' }).click();

  await expect
    .poll(() => (read(configPath).projects as unknown[]).length)
    .toBe(0);

  const written = read(configPath);
  // Still the *commented* template, not a bare `{ projects: [] }`.
  expect(written['//']).toContain('The Hive');
  expect(written.version).toBe(2);
  // The one write that discards what it did not put there.
  expect(written['//mine']).toBeUndefined();
  expect(written.futureKey).toBeUndefined();
  expect(written.shell).toBeUndefined();

  // And the renderer installed the snapshot main returned, without a reload.
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Projects' })
    .click();
  await expect(page.getByText('scratch-repo')).toHaveCount(0);

  await app.close();
});

test('cancelling the confirmation leaves the file alone', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  await page.getByRole('button', { name: 'Reset to template' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByRole('button', { name: 'Reset to template' })).toBeVisible();
  expect(read(configPath)['//mine']).toBe('a comment reset is allowed to eat');
  expect((read(configPath).projects as unknown[]).length).toBe(1);

  await app.close();
});

/**
 * HIVE-131's Containers group.
 *
 * The seed names no `receiver` block, so the value on screen can only have come
 * from `DEFAULT_RECEIVER` travelling the whole read path — parse, resolve,
 * `config:get`, snapshot — which no unit test exercises end to end.
 */
test('the Containers group shows the resolved host alias', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  await expect(
    page.getByRole('heading', { name: 'Containers', level: 3 }),
  ).toBeVisible();

  const field = page.getByLabel('Host alias');
  await expect(field).toBeVisible();
  await expect(field).toHaveValue('host.docker.internal');
  await expect(field).toBeEditable();

  await app.close();
});

/**
 * The write half, and the only test that drives the whole chain: renderer →
 * preload → `config:set-receiver` → `assertHostAlias` → `writeConfig` → disk.
 *
 * The file's other keys are asserted afterwards because this verb spreads the
 * document rather than rebuilding it — a comment and a key this build does not
 * know must both survive a save, which is the promise every settings verb makes.
 */
test('typing an alias writes it to the file and preserves the rest', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  const field = page.getByLabel('Host alias');
  await field.fill('host.containers.internal');
  await field.press('Enter');

  await expect
    .poll(() => (read(configPath).receiver as Record<string, unknown>)?.hostAlias)
    .toBe('host.containers.internal');

  const after = read(configPath);
  expect(after['//mine']).toBe('a comment reset is allowed to eat');
  expect(after.futureKey).toBe('something this build does not know');
  expect((after.projects as unknown[]).length).toBe(1);

  await app.close();
});

/**
 * HIVE-134's bind sub-group, on a config that names no `receiver.bind` at
 * all — so the switch reading **off** can only have come from
 * `DEFAULT_BIND.host` (`127.0.0.1`) travelling the whole read path, the same
 * way the alias test above proves for `hostAlias`.
 *
 * The fields are asserted `toBeHidden()`, not merely unchecked, because
 * `ContainerAliasGroup` renders them conditionally (`open ? <> … </> : null`)
 * — a regression that always rendered them, just visually collapsed, would
 * still pass a plain `not.toBeVisible()` on an element Playwright never found
 * absent, but not this.
 */
test('the off-loopback bind is off, and its fields are hidden, by default', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  const toggle = page.getByRole('switch', { name: /off loopback/i });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByLabel(/bind address/i)).toBeHidden();
  await expect(page.getByLabel(/^port$/i)).toBeHidden();
  await expect(page.getByLabel(/allowed origins/i)).toBeHidden();

  // Nothing is claimed in the header, because nothing is exposed.
  await expect(page.getByTestId('header-chips').getByText('127.0.0.1')).toHaveCount(0);

  await app.close();
});

/**
 * The write half of the bind switch — the only test that drives the whole
 * chain a launch later depends on: switch → revealed field → `TextField`
 * commit → `config:set-receiver` → `parseSetReceiverRequest`'s validation
 * (`electron/shared/guards.ts`) → disk.
 *
 * Asserted against the **file**, not the DOM, because the file is what the
 * next launch binds to — a component that shows `0.0.0.0` in its own state
 * without having written it would leave the app still listening on loopback
 * at the next launch, silently.
 */
test('turning the bind switch on reveals the fields and writes an address', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  await page.getByRole('switch', { name: /off loopback/i }).click();

  const field = page.getByLabel(/bind address/i);
  await expect(field).toBeVisible();
  await field.fill('0.0.0.0');
  await field.blur();

  // The file, not the DOM: this is what the next launch will bind.
  await expect
    .poll(() => (read(configPath).receiver as Record<string, unknown> | undefined)
      ?.bind as Record<string, unknown> | undefined)
    .toMatchObject({ host: '0.0.0.0' });

  await expect(page.getByText(/may attempt to talk to the receiver/i)).toBeVisible();

  await app.close();
});

/**
 * The header chip, on a config that seeds `receiver.bind.host` already
 * non-loopback — proving the chip end to end from a *file* rather than from
 * whatever state the switch test above left behind, since each spec launches
 * its own app against its own seed.
 */
test('the header names the address when the app starts exposed', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 2,
        shell: '/bin/sh',
        projects: [],
        receiver: {
          hostAlias: 'host.docker.internal',
          bind: { host: '0.0.0.0', port: 0, allowedOrigins: [] },
        },
      },
      null,
      2,
    ),
  );

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await expect(page.getByTestId('header-chips').getByText('0.0.0.0')).toBeVisible();

  await app.close();
});

/**
 * The defect HIVE-134's own review found, proven against the **built app**
 * rather than only in unit tests: a receiver reads its bind once, at boot, so
 * a listening socket cannot be moved — which is exactly what "takes effect
 * at next launch" already says. Toggling the settings switch off rewrites the
 * config file and its in-memory snapshot to loopback *instantly*, but the
 * socket this app bound wide at launch keeps listening until the app actually
 * restarts. A chip sourced from that snapshot would vanish the instant the
 * switch is toggled and read as safe; it would not be. So the chip must
 * survive exactly this sequence, still naming the address, because the
 * process is still reachable off loopback for the rest of this run.
 */
test('the chip survives the switch going loopback — it reports the running bind, not the file (HIVE-134)', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 2,
        shell: '/bin/sh',
        projects: [],
        receiver: { bind: { host: '0.0.0.0', port: 0, allowedOrigins: [] } },
      },
      null,
      2,
    ),
  );

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await expect(page.getByTestId('header-chips').getByText('0.0.0.0')).toBeVisible();

  await openAdvanced(page);
  await page.getByRole('switch', { name: /off loopback/i }).click();

  // The file, proving the toggle really did rewrite it to loopback — the
  // half of the story a config-derived chip would have reacted to.
  await expect
    .poll(() => (read(configPath).receiver as Record<string, unknown> | undefined)
      ?.bind as Record<string, unknown> | undefined)
    .toMatchObject({ host: '127.0.0.1' });

  // The chip, proving it did not react to that write: the socket this
  // session opened at boot is still bound to `0.0.0.0` and still reachable,
  // and the header still has to say so.
  await expect(page.getByTestId('header-chips').getByText('0.0.0.0')).toBeVisible();

  await app.close();
});

/**
 * HIVE-142's Server mode group, placed between `ContainerAliasGroup` and
 * Reset (`advanced-section.tsx`). Asserted by heading order rather than by
 * DOM position directly — Playwright has no ordinal locator for "the group
 * between these two" — which is exactly what a component landing in the
 * wrong slot would fail.
 */
test('the Server mode group renders between Containers and Reset', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  const headings = await page.getByRole('heading', { level: 3 }).allTextContents();
  const containers = headings.indexOf('Containers');
  const server = headings.indexOf('Server mode');
  const reset = headings.indexOf('Reset');

  expect(containers).toBeGreaterThanOrEqual(0);
  expect(server).toBeGreaterThan(containers);
  expect(reset).toBeGreaterThan(server);

  await app.close();
});

/**
 * The default: nothing paired, nothing configured, so the switch reads off
 * and the bind fields are absent rather than merely collapsed — the same
 * `toBeHidden()` distinction `the off-loopback bind is off…` above draws for
 * `ContainerAliasGroup`, and for the identical reason: `ServerModeGroup`
 * renders its fields conditionally (`open ? <> … </> : null`).
 */
test('the Server mode switch is off, and its fields are hidden, by default', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  const toggle = page.getByRole('switch', { name: 'Server mode' });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByLabel(/bind address/i)).toBeHidden();
  await expect(page.getByLabel(/^port$/i)).toBeHidden();

  await app.close();
});

/**
 * The write half of this switch: an ordinary settings write, exactly like
 * `configSetReceiver`'s own, and proven against the real bridge — `handle`
 * → `parseSetServerRequest` → `setServer` → disk.
 */
test('turning server mode on reveals the bind fields and writes enabled: true', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  await page.getByRole('switch', { name: 'Server mode' }).click();

  await expect(page.getByLabel(/bind address/i)).toBeVisible();
  await expect(page.getByLabel(/^port$/i)).toBeVisible();

  await expect
    .poll(() => (read(configPath).server as Record<string, unknown> | undefined)?.enabled)
    .toBe(true);

  await app.close();
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Runtime settings, driven through the real app (story 104).
 *
 * The unit suite proves the pieces against fakes — a guard rejects a payload, a
 * mocked bridge routes a verb, a stubbed snapshot renders a row. None of that
 * says whether the renderer's keystroke reaches main, whether main's write
 * produces a file the reader accepts, or whether the PATH diagnostic can see a
 * real filesystem. That is what this covers.
 *
 * `HIVE_CONFIG_PATH` points at a scratch file, so nothing here touches the
 * developer's own `~/.hive/config.json`.
 */

const openRuntime = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Runtime' })
    .click();
  await expect(page.getByRole('heading', { name: 'Runtime', level: 2 })).toBeVisible();
};

/** A config with one real project directory, and a comment the UI must not eat. */
function seed(
  outputPath: (name: string) => string,
  shell = '/bin/sh',
  /**
   * HIVE-133. A plain object rather than an imported `ContainerConfig` — this
   * spec builds every project entry as a literal already, and this is one
   * more optional field on the same literal rather than a new dependency on
   * the renderer's alias map from inside the e2e bundle.
   */
  container?: { workspace: string; hiveDir: string },
) {
  const repoDir = outputPath('scratch-repo');
  mkdirSync(join(repoDir, '.git'), { recursive: true });

  const configPath = outputPath('hive-config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        '//': 'a comment the UI must not eat',
        version: 2,
        shell,
        claudeCommand: 'claude',
        projects: [
          {
            id: 'scratch-repo',
            name: 'scratch-repo',
            path: repoDir,
            icon: 'ph-folder',
            ...(container === undefined ? {} : { container }),
          },
        ],
      },
      null,
      2,
    ),
  );

  return { configPath, repoDir };
}

/**
 * Whether `/bin/bash` exists on this machine.
 *
 * Only the precedence test below actually spawns the seeded shell (through
 * the env diagnostic) and needs the probe args (`-l -i -c`, `config-
 * contract.ts`'s `ENV_PROBE_ARGS`) to be accepted for real, rather than just
 * written to a config file. `/bin/sh` fails that on Debian and Ubuntu, where
 * it is dash — dash has no `-l` option, so the probe would fail, `vars`
 * would come back empty, and the assertion that a value rendered would go
 * red for an environmental reason having nothing to do with a regression.
 * `env-diagnostic.test.ts` guards its own real-shell dependency (`/bin/zsh`)
 * the same way, for the identical reason.
 */
const hasBash = existsSync('/bin/bash');

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('edits the default shell and preserves the file’s comments', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openRuntime(page);

  const shell = page.getByRole('textbox', { name: 'Shell' });
  await expect(shell).toHaveValue('/bin/sh');
  await shell.fill('/bin/zsh');
  await shell.press('Enter');

  await expect
    .poll(() => read(configPath).shell)
    .toBe('/bin/zsh');

  const written = read(configPath);
  // The whole-file write must not eat the comment or restate the other field.
  expect(written['//']).toBe('a comment the UI must not eat');
  expect(written.claudeCommand).toBe('claude');

  await app.close();
});

test('sets and clears a per-project override', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openRuntime(page);
  await page
    .getByRole('combobox', { name: 'Project' })
    .selectOption('scratch-repo');

  const override = page.getByRole('textbox', { name: 'Shell override' });
  // Empty means inherit; the inherited value is only a placeholder.
  await expect(override).toHaveValue('');
  await override.fill('/bin/bash');
  await override.press('Enter');

  await expect
    .poll(() => read(configPath).projects[0].shell)
    .toBe('/bin/bash');

  await override.fill('');
  await override.press('Enter');

  // Cleared means the key is gone — not `""`, which would spawn a shell named
  // `""` and fail with a message no user could act on.
  await expect
    .poll(() => 'shell' in read(configPath).projects[0])
    .toBe(false);

  await app.close();
});

test('saves per-project environment variables', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openRuntime(page);
  await page
    .getByRole('combobox', { name: 'Project' })
    .selectOption('scratch-repo');

  // Scoped to the project's own named group (story 108): the Defaults group
  // now carries its own `EnvEditor` too, so an unscoped query is ambiguous
  // the moment a project is selected — both groups render the identical
  // literal control names "Add variable" and "Save variables".
  const projectGroup = page.getByRole('group', {
    name: 'Project environment variables',
  });
  await projectGroup.getByRole('button', { name: 'Add variable' }).click();
  await projectGroup
    .getByRole('textbox', { name: 'Variable 1 name' })
    .fill('API_URL');
  await projectGroup
    .getByRole('textbox', { name: 'Variable 1 value' })
    .fill('https://example.test');
  await projectGroup.getByRole('button', { name: 'Save variables' }).click();

  await expect
    .poll(() => read(configPath).projects[0].env)
    .toEqual({ API_URL: 'https://example.test' });

  await app.close();
});

test('adds a workspace environment variable and writes a top-level env block', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openRuntime(page);

  // The workspace editor, not the per-project one — no project is selected
  // yet, so `ProjectOverrides` has not mounted and this is the only
  // `EnvEditor` on screen. Scoped anyway, matching the unit suite's style,
  // since an unscoped "Save variables" becomes ambiguous the moment a
  // project *is* selected later in this file.
  const workspaceGroup = page.getByRole('group', {
    name: 'Workspace environment variables',
  });
  await workspaceGroup.getByRole('button', { name: 'Add variable' }).click();
  await workspaceGroup
    .getByRole('textbox', { name: 'Variable 1 name' })
    .fill('HIVE_WORKSPACE_VAR');
  await workspaceGroup
    .getByRole('textbox', { name: 'Variable 1 value' })
    .fill('ws-value-1');
  await workspaceGroup.getByRole('button', { name: 'Save variables' }).click();

  // The write path is a whole-file replace keyed by `SetRuntimeRequest.env`
  // (story 108) — this proves it lands as a top-level sibling of `shell` and
  // `claudeCommand`, not nested under a project or dropped.
  await expect
    .poll(() => read(configPath).env)
    .toEqual({ HIVE_WORKSPACE_VAR: 'ws-value-1' });

  await app.close();
});

test('a per-project override wins over the workspace value for the same key', async ({}, testInfo) => {
  // The only assertion in this file that depends on the seeded shell actually
  // running the probe args for real (see `hasBash`'s doc comment) — skipped
  // with a named reason rather than failing red for an environmental cause
  // on a machine/CI image with no `/bin/bash`.
  test.skip(!hasBash, 'no /bin/bash on this machine to run the env probe with');

  const { configPath } = seed((name) => testInfo.outputPath(name), '/bin/bash');
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openRuntime(page);

  // Same key in both layers, deliberately: the point is precedence, not mere
  // presence. If the two layers were merged in the wrong order, both halves
  // of this test would still see *a* value — only the specific one differs.
  const KEY = 'HIVE_SHARED_VAR';
  const WORKSPACE_VALUE = 'ws-value-1';
  const PROJECT_VALUE = 'project-value-1';

  const workspaceGroup = page.getByRole('group', {
    name: 'Workspace environment variables',
  });
  await workspaceGroup.getByRole('button', { name: 'Add variable' }).click();
  await workspaceGroup
    .getByRole('textbox', { name: 'Variable 1 name' })
    .fill(KEY);
  await workspaceGroup
    .getByRole('textbox', { name: 'Variable 1 value' })
    .fill(WORKSPACE_VALUE);
  await workspaceGroup.getByRole('button', { name: 'Save variables' }).click();

  await expect
    .poll(() => read(configPath).env)
    .toEqual({ [KEY]: WORKSPACE_VALUE });

  await page
    .getByRole('combobox', { name: 'Project' })
    .selectOption('scratch-repo');

  const projectGroup = page.getByRole('group', {
    name: 'Project environment variables',
  });
  await projectGroup.getByRole('button', { name: 'Add variable' }).click();
  await projectGroup
    .getByRole('textbox', { name: 'Variable 1 name' })
    .fill(KEY);
  await projectGroup
    .getByRole('textbox', { name: 'Variable 1 value' })
    .fill(PROJECT_VALUE);
  await projectGroup.getByRole('button', { name: 'Save variables' }).click();

  await expect
    .poll(() => read(configPath).projects[0].env)
    .toEqual({ [KEY]: PROJECT_VALUE });

  /**
   * The file now holds both layers; the question this test exists to answer
   * is which one a session would actually see. `effectiveRuntime` is a
   * main-process function with no renderer-facing export, so the only honest
   * way to observe its output through the real UI is the environment
   * diagnostic — it runs `diagnoseEnv(effectiveRuntime(snapshot, project),
   * ...)` and renders each variable's `configured` value straight from that
   * merge (`env-diagnostic-view.tsx`). Reading that value is reading
   * `effectiveRuntime`'s output, one hop removed.
   */
  await page
    .getByRole('button', { name: 'Check this project’s environment' })
    .click();

  // The project's value must appear...
  await expect(page.getByText(PROJECT_VALUE)).toBeVisible();
  // ...and the workspace's value must not — anywhere text is rendered. A
  // merge with the layers reversed (workspace spread over project) would
  // report the workspace's value here instead, which is exactly the failure
  // this asserts against.
  await expect(page.getByText(WORKSPACE_VALUE, { exact: true })).toHaveCount(
    0,
  );

  await app.close();
});

test('the diagnostic reports the PATH it actually searched', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openRuntime(page);
  await page.getByRole('button', { name: 'Check the default command' }).click();

  /**
   * `claude` is genuinely unlikely to be on the PATH of a CI runner, and that
   * is the case worth proving: the diagnostic must explain *why* rather than
   * assert the command is missing. Either verdict is acceptable here — what is
   * asserted is that a real answer came back from a real filesystem.
   */
  const verdict = page.getByText(/claude/).first();
  await expect(verdict).toBeVisible();
  /*
    `exact`, because `getByText` with a plain string is a case-insensitive
    substring match — and this pane now also carries PATH source, whose
    description contains the word "searched". The claim is about the
    diagnostic's own label, so it says so.
  */
  await expect(page.getByText('Searched', { exact: true })).toBeVisible();

  await app.close();
});

/**
 * The Container group (HIVE-133), driven through the real, built app.
 *
 * The unit suite renders `ContainerGroup` in isolation and proves its own
 * markup; none of it proves the nesting actually resolves once the component
 * is mounted where it really lives — a provider deep in `ProjectOverrides`
 * inside `RuntimeSection`'s own tree — or that a commit survives a real
 * whole-file write and comes back out through `config.reload()`'s parser.
 * Fix round 1, Finding 4.
 */
test('renders the nested Container group, switches freshness, and writes an edit to disk', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name), '/bin/sh', {
    workspace: '/workspace',
    hiveDir: '/hive',
  });
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openRuntime(page);
  await page
    .getByRole('combobox', { name: 'Project' })
    .selectOption('scratch-repo');

  // The nesting claim, verified in situ rather than in a standalone render:
  // `SettingsGroup` only drops to `h4` and suppresses its rule when it reads
  // `useIsNestedGroup() === true` from context — a wrong or missing provider
  // anywhere between here and `ContainerGroup` would render `h3` instead.
  await expect(
    page.getByRole('heading', { name: 'Container', level: 4 }),
  ).toBeVisible();

  // The preview scrolls inside itself; the pane must never scroll
  // horizontally (`container-command-preview.tsx`'s own comment on the
  // element).
  const preview = page.locator('pre', { hasText: '--settings' });
  await expect(preview).toBeVisible();
  await expect(preview).toHaveCSS('overflow-x', 'auto');

  // The freshness control switches, and its trade-off copy changes with it.
  await expect(
    page.getByText(/Nothing secret is written to disk/),
  ).toBeVisible();
  await page.getByRole('radio', { name: 'rewrite' }).click();
  await expect(
    page.getByText(/resolved HIVE_HOOK_TOKEN/),
  ).toBeVisible();
  await expect(
    page.getByText(/Nothing secret is written to disk/),
  ).not.toBeVisible();

  // Editing a field reaches the file — the same round-trip the neighbouring
  // tests in this file make for `shell` and `env`.
  const workspace = page.getByRole('textbox', { name: 'Workspace path' });
  await workspace.fill('/srv');
  await workspace.press('Enter');

  await expect
    .poll(() => read(configPath).projects[0].container.workspace)
    .toBe('/srv');
  // The freshness switch above committed too, through the same write path.
  await expect
    .poll(() => read(configPath).projects[0].container.freshness)
    .toBe('rewrite');
  // `hiveDir` was never touched and must survive the whole-file write
  // untouched — same "one write must not restate every field" property the
  // top-of-file test proves for `shell`/`claudeCommand`.
  expect(read(configPath).projects[0].container.hiveDir).toBe('/hive');

  await app.close();
});

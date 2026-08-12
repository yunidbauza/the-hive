import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Settings: managing projects — rename, re-point, reorder (story 103).
 *
 * The only proof the whole slice works. The unit suite proves the pieces
 * against fakes; none of it says whether a drag in a real Chromium reaches
 * `reorderProjects`, whether the file main writes is one the reader accepts, or
 * whether the left rail — which reads the merged list positionally — actually
 * follows the new order.
 *
 * Drag is driven with real, stepped mouse movement (see `dragRow`), which is
 * what native HTML5 drag-and-drop needs — and what a hand-rolled drag buys:
 * a pointer-event library would need the same stepping *and* a bespoke
 * keyboard path on top.
 *
 * `dialog.showOpenDialog` is stubbed **in main**, not bypassed — the renderer
 * still calls `chooseDirectory` and still echoes the path back, so the round
 * trip under test is the real one.
 */

interface Launched {
  app: ElectronApplication;
  page: Page;
  configPath: string;
}

/** Three real directories, declared in file order a, b, c. */
async function launchWithThree(
  outputPath: (name: string) => string,
): Promise<Launched & { moved: string }> {
  const configPath = outputPath('hive-config.json');
  const dirs = ['alpha', 'bravo', 'charlie'].map((name) => {
    const dir = outputPath(name);
    mkdirSync(join(dir, '.git'), { recursive: true });
    return { id: name, name, path: dir, icon: 'ph-folder', origin: 'local' };
  });

  // A directory nothing is pointing at yet, for the re-point case.
  const moved = outputPath('bravo-moved');
  mkdirSync(join(moved, '.git'), { recursive: true });

  writeFileSync(
    configPath,
    JSON.stringify(
      { '//': 'a comment the UI must not eat', version: 2, projects: dirs },
      null,
      2,
    ),
  );

  const app = await launchHive({
    userDataDir: outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  return { app, page, configPath, moved };
}

const openSettings = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
};

/** The project ids in the file, in the order the file lists them. */
const idsOnDisk = (configPath: string): string[] =>
  (
    JSON.parse(readFileSync(configPath, 'utf8')).projects as { id: string }[]
  ).map((entry) => entry.id);

/** Where `alpha` lands when dragged onto the last row — asserted by two tests. */
const DRAG_RESULT = ['bravo', 'charlie', 'alpha'];

const openRowMenu = (page: Page, name: string) =>
  page.getByRole('button', { name: `Actions for ${name}` }).click();

/**
 * Drag one row onto another with real, stepped mouse movement.
 *
 * Chromium starts a native HTML5 drag only after the pointer has moved some
 * distance while held, and Playwright's `dragTo` jumps straight to the target,
 * which does not reliably cross that threshold — the drag never begins and the
 * assertion fails against an unchanged file. Moving in steps is the sequence
 * Playwright documents for HTML5 drag-and-drop, and it is what a person does.
 */
async function dragRow(page: Page, from: Locator, to: Locator): Promise<void> {
  const source = await from.boundingBox();
  const target = await to.boundingBox();
  if (!source || !target) throw new Error('a row had no box to drag');

  const centre = (box: { x: number; y: number; width: number; height: number }) =>
    [box.x + box.width / 2, box.y + box.height / 2] as const;

  const [fromX, fromY] = centre(source);
  const [toX, toY] = centre(target);

  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  // The first small move is what tips Chromium into a drag; the rest carries it.
  await page.mouse.move(fromX, fromY + 8, { steps: 4 });
  await page.mouse.move(toX, toY, { steps: 12 });
  await page.mouse.up();
}

test('drag reorders the file and the left rail follows', async ({}, testInfo) => {
  const { app, page, configPath } = await launchWithThree((name) =>
    testInfo.outputPath(name),
  );

  try {
    await openSettings(page);

    const rows = page.getByRole('listitem');
    await expect(rows).toHaveCount(3);

    // Drag the first row onto the last.
    //
    // Stepped mouse movement rather than `dragTo`: Chromium only begins a
    // native HTML5 drag once the pointer has actually travelled while held,
    // and `dragTo`'s single jump does not always cross that threshold. This is
    // the sequence Playwright documents for HTML5 drag-and-drop.
    await dragRow(page, rows.nth(0), rows.nth(2));

    await expect
      .poll(() => idsOnDisk(configPath))
      .toEqual(DRAG_RESULT);

    // The comment outlived a reorder, not just an add.
    expect(JSON.parse(readFileSync(configPath, 'utf8'))['//']).toBe(
      'a comment the UI must not eat',
    );

    // The rail reads the merged list positionally, so this is the acceptance
    // criterion the story is named for: the order the user dragged is the order
    // the rail shows, with no reload.
    await page.getByRole('button', { name: 'Close settings' }).click();
    const railNames = await page
      .getByRole('button', { name: /^(alpha|bravo|charlie)/ })
      .allInnerTexts();
    expect(railNames.map((text) => text.split('\n')[0])).toEqual([
      'bravo',
      'charlie',
      'alpha',
    ]);
  } finally {
    await app.close();
  }
});

/**
 * The acceptance criterion is that both input paths produce the same config,
 * so this drives the menu to the *same destination* the drag test reaches and
 * compares against it, rather than merely asserting that a menu click does
 * something.
 */
test('the menu reaches the same order a drag does', async ({}, testInfo) => {
  const { app, page, configPath } = await launchWithThree((name) =>
    testInfo.outputPath(name),
  );

  try {
    await openSettings(page);

    // The drag test moves alpha to the end; two Move downs is the same journey.
    await openRowMenu(page, 'alpha');
    await page.getByRole('menuitem', { name: 'Move down' }).click();
    await expect.poll(() => idsOnDisk(configPath)).toEqual([
      'bravo',
      'alpha',
      'charlie',
    ]);

    await openRowMenu(page, 'alpha');
    await page.getByRole('menuitem', { name: 'Move down' }).click();

    // DRAG_RESULT is what `drag reorders the file and the left rail follows`
    // asserts; the two paths must agree byte for byte.
    await expect.poll(() => idsOnDisk(configPath)).toEqual(DRAG_RESULT);
  } finally {
    await app.close();
  }
});

test('renaming writes the file and never touches the id', async ({}, testInfo) => {
  const { app, page, configPath } = await launchWithThree((name) =>
    testInfo.outputPath(name),
  );

  try {
    await openSettings(page);

    await openRowMenu(page, 'alpha');
    await page.getByRole('menuitem', { name: 'Rename…' }).click();

    const input = page.getByRole('textbox', { name: 'Project name' });
    await expect(input).toBeFocused();
    await input.fill('Alpha Renamed');
    await input.press('Enter');

    await expect(page.getByText('Alpha Renamed')).toBeVisible();

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(written.projects[0].name).toBe('Alpha Renamed');
    // The id is machinery — sessions reference it, so it must not drift.
    expect(written.projects[0].id).toBe('alpha');
    expect(idsOnDisk(configPath)).toEqual(['alpha', 'bravo', 'charlie']);
  } finally {
    await app.close();
  }
});

/**
 * Escape backs out of the rename, not out of Settings.
 *
 * Settings is a Radix dialog and Escape is how a dialog is dismissed, so an
 * Escape left to bubble closed the whole overlay — the user pressed one key to
 * abandon an edit and lost the screen. Only a real dialog can show this: in
 * jsdom the editor has no dialog above it to close.
 */
test('cancelling a rename leaves settings open and the list usable', async ({}, testInfo) => {
  const { app, page, configPath } = await launchWithThree((name) =>
    testInfo.outputPath(name),
  );
  const before = readFileSync(configPath, 'utf8');

  try {
    await openSettings(page);

    await openRowMenu(page, 'alpha');
    await page.getByRole('menuitem', { name: 'Rename…' }).click();
    const input = page.getByRole('textbox', { name: 'Project name' });
    await expect(input).toBeFocused();
    await input.fill('Abandoned');
    await page.keyboard.press('Escape');

    await expect(input).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // And the list still takes input: another row's menu opens.
    await openRowMenu(page, 'bravo');
    await expect(page.getByRole('menuitem', { name: 'Rename…' })).toBeVisible();

    expect(readFileSync(configPath, 'utf8')).toBe(before);
  } finally {
    await app.close();
  }
});

test('re-pointing writes the new folder and leaves the rest of the entry alone', async ({}, testInfo) => {
  const { app, page, configPath, moved } = await launchWithThree((name) =>
    testInfo.outputPath(name),
  );

  try {
    await app.evaluate(({ dialog }, paths) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({
        canceled: false,
        filePaths: paths,
      });
    }, [moved]);

    await openSettings(page);

    await openRowMenu(page, 'bravo');
    await page.getByRole('menuitem', { name: 'Change folder…' }).click();

    await expect.poll(() => {
      const entry = JSON.parse(readFileSync(configPath, 'utf8')).projects[1];
      return entry.path as string;
    }).toBe(moved);

    const entry = JSON.parse(readFileSync(configPath, 'utf8')).projects[1];
    expect(entry.id).toBe('bravo');
    expect(entry.name).toBe('bravo');
    // Order is untouched by a re-point.
    expect(idsOnDisk(configPath)).toEqual(['alpha', 'bravo', 'charlie']);
  } finally {
    await app.close();
  }
});

test('a cancelled re-point writes nothing', async ({}, testInfo) => {
  const { app, page, configPath } = await launchWithThree((name) =>
    testInfo.outputPath(name),
  );
  const before = readFileSync(configPath, 'utf8');

  try {
    await app.evaluate(({ dialog }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({
        canceled: true,
        filePaths: [],
      });
    });

    await openSettings(page);
    await openRowMenu(page, 'bravo');
    await page.getByRole('menuitem', { name: 'Change folder…' }).click();

    // Nothing to write, and nothing to say: the user closed a dialog they
    // opened. The file is byte-identical.
    await expect(page.getByText('bravo').first()).toBeVisible();
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  } finally {
    await app.close();
  }
});

/**
 * The one-click path only.
 *
 * These fixtures own no sessions, so no confirmation appears — which is the
 * behaviour under test here: the quick path stayed quick. The confirmation
 * itself needs a project that owns a *live* session, which in this phase means
 * the renderer's fixture sessions; that is covered against the real store in
 * `tests/features/settings/components/projects-list.test.tsx`.
 */
test('removing a project with no live sessions takes one click', async ({}, testInfo) => {
  const { app, page, configPath } = await launchWithThree((name) =>
    testInfo.outputPath(name),
  );
  try {
    await openSettings(page);

    await openRowMenu(page, 'charlie');
    await page.getByRole('menuitem', { name: 'Remove' }).click();

    await expect
      .poll(() => idsOnDisk(configPath))
      .toEqual(['alpha', 'bravo']);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))['//']).toBe(
      'a comment the UI must not eat',
    );
    // No confirmation was shown on the way — that is the point of this path.
    expect(await page.getByRole('alertdialog').count()).toBe(0);
  } finally {
    await app.close();
  }
});

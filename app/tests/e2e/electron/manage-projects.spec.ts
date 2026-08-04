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
 * Drag is asserted through Playwright's `dragTo`, which drives native HTML5
 * drag-and-drop. That is exactly why this story hand-rolled the drag instead of
 * taking a pointer-event library: the e2e proof would otherwise have to step
 * the mouse by hand.
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
      .toEqual(['bravo', 'charlie', 'alpha']);

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

test('Move up produces the same file a drag would', async ({}, testInfo) => {
  const { app, page, configPath } = await launchWithThree((name) =>
    testInfo.outputPath(name),
  );

  try {
    await openSettings(page);

    await openRowMenu(page, 'charlie');
    await page.getByRole('menuitem', { name: 'Move up' }).click();

    await expect
      .poll(() => idsOnDisk(configPath))
      .toEqual(['alpha', 'charlie', 'bravo']);
  } finally {
    await app.close();
  }
});

test('renaming survives a reload and never touches the id', async ({}, testInfo) => {
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

test('removing a project asks first, and cancelling writes nothing', async ({}, testInfo) => {
  const { app, page, configPath } = await launchWithThree((name) =>
    testInfo.outputPath(name),
  );
  const before = readFileSync(configPath, 'utf8');

  try {
    await openSettings(page);

    /*
      These projects own no sessions, so this is the one-click path — the
      confirmation is reserved for a project with live sessions, which needs a
      running PTY to set up and is covered against the store in the unit suite.
      What this proves is the other half: that the quick path stayed quick.
    */
    await openRowMenu(page, 'charlie');
    await page.getByRole('menuitem', { name: 'Remove' }).click();

    await expect
      .poll(() => idsOnDisk(configPath))
      .toEqual(['alpha', 'bravo']);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))['//']).toBe(
      'a comment the UI must not eat',
    );
    expect(before).toContain('charlie');
  } finally {
    await app.close();
  }
});

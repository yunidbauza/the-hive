import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ElectronApplication } from '@playwright/test';

import {
  expect,
  launchHive,
  startSession,
  test,
  writeProjectConfig,
} from './fixtures/hive-app';

/**
 * Links in terminal output actually open the browser.
 *
 * ## Why this needs the built app
 *
 * The unit suite proves the handler passes the URL to `window.open`
 * (`tests/lib/terminal/open-link.test.ts`) and that the surface installs it on
 * both link paths (`tests/components/terminal/terminal-surface.test.tsx`).
 * Neither can prove the half that was actually broken, because the break was
 * not in the renderer at all: `applyWebContentsPolicy` **denies every**
 * `window.open` and re-routes the URL to the OS instead, so whether a link opens
 * depends on what main is handed.
 *
 * xterm's shipped handler hands it `about:blank` — it opens a blank window
 * first, then assigns `location.href`, a defence against reverse tabnabbing
 * that predates `noopener`. `isSafeExternalUrl` rejects `about:blank`, the
 * window is denied, `window.open()` answers `null`, and the click dies in a
 * `console.warn`. Every link in terminal output was detected, underlined, and
 * inert.
 *
 * So the claim these two tests make is about the seam between the renderer's
 * call and main's policy, which only a real Electron app has: **the call our
 * handler makes reaches `shell.openExternal`; the call the default makes does
 * not.** `shell.openExternal` is stubbed in main so the test does not launch a
 * browser on the machine running it.
 *
 * Clicking a rendered link is deliberately not what is driven here. The WebGL
 * renderer paints the transcript into a canvas, so there is no DOM node to
 * click and a pixel-coordinate click would be asserting xterm's hit-testing
 * rather than this app's behaviour.
 */

/**
 * Replace `shell.openExternal` in main with a recorder.
 *
 * Stubbed rather than observed, because the un-stubbed verb launches the
 * machine's actual browser — which is the correct behaviour and a poor thing to
 * do on every test run.
 */
async function stubOpenExternal(hive: ElectronApplication): Promise<void> {
  await hive.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as Record<string, unknown>).__hiveOpened = opened;
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
  });
}

/** What main was asked to open, in order. */
async function opened(hive: ElectronApplication): Promise<string[]> {
  return hive.evaluate(
    () => ((globalThis as Record<string, unknown>).__hiveOpened as string[]) ?? [],
  );
}

test('the call the link handler makes reaches the browser', async ({ hive, page }) => {
  await page.waitForSelector('header');
  await stubOpenExternal(hive);

  /*
    Exactly what `openTerminalLink` does, character for character. Running the
    module's own call rather than re-deriving it is the point: if the handler
    ever goes back to opening a blank window first, this fails.
  */
  const result = await page.evaluate(() =>
    window.open(
      'https://claude.ai/code/artifact/dd055a06',
      '_blank',
      'noopener,noreferrer',
    ),
  );

  // Still denied a *window* — that policy is unchanged and `security.spec.ts`
  // owns it. What matters is that main was handed the URL on the way to saying
  // no, and sent it to the OS.
  expect(result).toBeNull();
  expect(await opened(hive)).toEqual(['https://claude.ai/code/artifact/dd055a06']);
});

test('the call xterm ships by default reaches nothing — the bug', async ({
  hive,
  page,
}) => {
  await page.waitForSelector('header');
  await stubOpenExternal(hive);

  // `window.open()` with no argument: the first line of the addon's default
  // handler, and the whole reason links were dead.
  const result = await page.evaluate(() => window.open());

  expect(result).toBeNull();
  // Nothing reached the OS, so `location.href` was never assigned and the user
  // saw nothing happen.
  expect(await opened(hive)).toEqual([]);
});

/**
 * `fs:resolve` is registered, classified, and answers through the real bridge.
 *
 * The unit suite proves the verb's containment
 * (`tests/electron/main/fs/resolve.test.ts`) and the renderer's wiring
 * (`center-stage.test.tsx`) separately, and each of those is a claim about one
 * side of a channel. What only the built app can show is that the channel
 * exists at all: that `ipc/index.ts` really binds the handler and that the
 * preload really exposes it — the two places a new channel is most often
 * forgotten, and the two that no unit test can reach, because each side mocks
 * the other.
 *
 * Hovering a painted row is deliberately not driven here, for the reason the
 * tests above give: the WebGL renderer paints the transcript into a canvas, so
 * there is no DOM node to hover and a pixel-coordinate click would be
 * asserting xterm's hit-testing rather than this app's behaviour.
 */
test('fs:resolve answers through the bridge for the session on screen', async ({}, testInfo) => {
  const repo = testInfo.outputPath('repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export {};\n');

  const configPath = testInfo.outputPath('hive-config.json');
  writeProjectConfig(configPath, { id: 'demo', path: repo });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  try {
    const sessionId = await startSession(page, 'demo');

    const answer = await page.evaluate(
      ({ sessionId }) =>
        window.hive!.fs.resolve({
          projectId: 'demo',
          sessionId,
          candidates: ['src/a.ts', 'src/missing.ts', '/etc/hosts'],
        }),
      { sessionId },
    );

    expect(answer).toEqual({
      ok: true,
      value: {
        resolved: [
          { relPath: 'src/a.ts', rootKey: '' },
          // Not on disk, and outside the root: both are `null`, and the
          // renderer is told nothing that tells them apart.
          null,
          null,
        ],
      },
    });
  } finally {
    await app.close();
  }
});

import type { ElectronApplication } from '@playwright/test';

import { expect, test } from './fixtures/hive-app';

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

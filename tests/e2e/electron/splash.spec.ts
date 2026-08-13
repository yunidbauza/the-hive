import { expect, test } from '@playwright/test';

import { SPLASH_MIN_MS, SPLASH_SIZE } from '../../../electron/shared/splash';

import { launchHive, mainWindow, splashWindow, writeProjectConfig } from './fixtures/hive-app';

/**
 * The Overmind Chamber, driven in the built app.
 *
 * The only spec in the suite that launches **without** `HIVE_E2E`. Every other
 * one sets it, which turns the splash off so twenty-five specs do not each wait
 * out the floor and then have to work out which of two windows is the app. That
 * makes this the one place the real cold-start path is exercised, so it asserts
 * the whole of it rather than just that a window appeared.
 *
 * What a unit test cannot reach, and this can: that the document loads at all,
 * that the sprite draws pixels, and that the app window is genuinely hidden
 * behind the splash rather than merely scheduled to appear later.
 */

test.describe('the cold-start splash', () => {
  test('covers the boot, then hands over to the app', async ({}, testInfo) => {
    const configPath = testInfo.outputPath('hive-config.json');
    writeProjectConfig(configPath, { id: 'hive', path: testInfo.outputPath('repo') });

    const started = Date.now();
    const app = await launchHive({
      userDataDir: testInfo.outputPath('user-data'),
      configPath,
      /**
       * Cleared, not absent. `launchHive` sets `HIVE_E2E: '1'` and merges this
       * after it, and `splashEnabled` treats the empty string as "not set" —
       * which is the whole reason it tests truthiness rather than presence.
       */
      env: { HIVE_E2E: '' },
    });

    try {
      const splash = await test.step('the splash appears', async () => {
        await expect
          .poll(() => splashWindow(app) !== undefined, { timeout: 15_000 })
          .toBe(true);
        const page = splashWindow(app);
        if (!page) throw new Error('the splash went before it could be inspected');
        await page.waitForLoadState('domcontentloaded');
        return page;
      });

      await test.step('it is the chamber, at the size both processes agree on', async () => {
        await expect(splash.locator('.chamber')).toBeVisible();
        await expect(splash.locator('.wordmark')).toHaveText(/THE\s*HIVE/);
        await expect(splash.locator('.log li')).toHaveCount(5);
        await expect(splash.locator('.log li.online')).toHaveText('hive cluster online');

        const size = await splash.evaluate(() => ({
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
        }));
        expect(size).toEqual({ width: SPLASH_SIZE.width, height: SPLASH_SIZE.height });
      });

      await test.step('the fallback GIF is a real, loaded image', async () => {
        /**
         * Asserted whether or not it is used, and this is the only place it can
         * be. The fallback is loaded up front and merely hidden, so a GIF that
         * failed to emit, or emitted broken, is silent until the day the video
         * path fails — which is exactly the day nobody is watching.
         *
         * `naturalWidth` is the honest check: it is non-zero only if the file
         * was found, decoded, and is a valid image.
         */
        const image = await splash.locator('#sprite-fallback').evaluate((node) => {
          const img = node as HTMLImageElement;
          return { src: img.currentSrc, width: img.naturalWidth, height: img.naturalHeight };
        });

        expect(image.src).toMatch(/\.gif$/);
        expect(image.width).toBeGreaterThan(0);
        expect(image.height).toBeGreaterThan(0);
      });

      await test.step('the creature is drawn, not missing', async () => {
        /**
         * The creature arrives asynchronously — the video has to decode first —
         * so this polls rather than reading once. Reading once is what the
         * first version of this spec did, and it failed against a canvas that
         * was correct half a second later.
         *
         * Either path counts. The canvas is the one every normal launch takes,
         * but a machine slow enough to miss `DECODE_GRACE_MS` legitimately
         * shows the GIF, and a spec that called that a failure would be
         * asserting the host's speed rather than the app's behaviour. What is
         * not allowed is *neither* — an empty chamber, which is the bug this
         * step exists to catch.
         */
        const showing = async () =>
          splash.evaluate(() => {
            const canvas = document.querySelector<HTMLCanvasElement>('#sprite');
            const img = document.querySelector<HTMLImageElement>('#sprite-fallback');
            if (img && !img.hidden && img.naturalWidth > 0) return 'fallback';
            if (!canvas || canvas.hidden) return 'none';
            const ctx = canvas.getContext('2d');
            if (!ctx) return 'none';
            const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let opaque = 0;
            let clear = 0;
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] > 200) opaque += 1;
              else if (data[i] < 20) clear += 1;
            }
            const total = data.length / 4;
            // Roughly 56% creature against 43% keyed-away ground, measured.
            // Wide enough to survive a re-encode, tight enough to fail on a
            // blank canvas or an unkeyed white block.
            return opaque / total > 0.25 && clear / total > 0.2 ? 'canvas' : 'none';
          });

        await expect.poll(showing, { timeout: 5_000 }).not.toBe('none');
      });

      await test.step('the app window stays hidden underneath it', async () => {
        const visible = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((win) => ({
            url: win.webContents.getURL(),
            visible: win.isVisible(),
          })),
        );
        const main = visible.find((win) => !win.url.includes('splash.html'));
        expect(main?.visible).toBe(false);
      });

      await test.step('it holds the floor, then goes', async () => {
        await expect
          .poll(() => splashWindow(app) === undefined, { timeout: 20_000 })
          .toBe(true);

        // Generous on the lower bound: the floor is counted from when the
        // splash was shown, which is necessarily after the process started.
        expect(Date.now() - started).toBeGreaterThan(SPLASH_MIN_MS * 0.8);
      });

      await test.step('the app is now on screen', async () => {
        const page = await mainWindow(app);
        await expect(page.locator('#root')).toBeVisible();
        const visible = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((win) => win.isVisible()),
        );
        expect(visible).toEqual([true]);
      });
    } finally {
      await app.close();
    }
  });
});

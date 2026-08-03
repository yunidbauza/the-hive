import { expect, test } from './fixtures/hive-app';

/**
 * What only `_electron` can assert (story 085).
 *
 * `app.evaluate()` runs in the **main process**, which is how the security
 * posture from story 082 becomes a test rather than a code-review note. No
 * browser driver can see `webPreferences`.
 */

test('the three non-negotiable webPreferences flags hold', async ({ hive, page }) => {
  await page.waitForSelector('header');

  const prefs = await hive.evaluate(({ BrowserWindow }) => {
    /**
     * `getLastWebPreferences()` exists at runtime in Electron 43 but was
     * dropped from the published typings, so it needs a cast. Verified present
     * before relying on it; the alternative — inferring the flags from what the
     * renderer cannot reach — proves `nodeIntegration` well and the other two
     * only circumstantially. This reads the values the window was actually
     * constructed with.
     */
    const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
      getLastWebPreferences?: () => {
        contextIsolation?: boolean;
        nodeIntegration?: boolean;
        sandbox?: boolean;
      } | null;
    };
    return contents.getLastWebPreferences?.() ?? null;
  });

  // If this ever comes back null the API moved — fail loudly rather than
  // passing three `undefined === undefined` comparisons.
  expect(prefs).not.toBeNull();
  expect(prefs?.contextIsolation).toBe(true);
  expect(prefs?.nodeIntegration).toBe(false);
  expect(prefs?.sandbox).toBe(true);
});

test('the renderer cannot reach Node', async ({ page }) => {
  await page.waitForSelector('header');

  const reachable = await page.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    module: typeof (globalThis as Record<string, unknown>).module,
    Buffer: typeof (globalThis as Record<string, unknown>).Buffer,
    ipcRenderer: typeof (globalThis as Record<string, unknown>).ipcRenderer,
  }));

  expect(reachable).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    Buffer: 'undefined',
    ipcRenderer: 'undefined',
  });
});

test('window.hive exposes only the documented verbs', async ({ page }) => {
  await page.waitForSelector('header');

  const surface = await page.evaluate(() => ({
    top: Object.keys(window.hive!).sort(),
    pty: Object.keys(window.hive!.pty).sort(),
    config: Object.keys(window.hive!.config).sort(),
  }));

  // Widening any of these lists is the alarm this test exists to raise.
  expect(surface.top).toEqual(['appInfo', 'config', 'pty']);
  expect(surface.pty).toEqual([
    'kill',
    'onData',
    'onExit',
    'resize',
    'spawn',
    'write',
  ]);
  // Story 090 added `config`, and it is read-only on purpose — no verb here
  // writes to the user's disk.
  expect(surface.config).toEqual(['get', 'reload']);
});

test('ipcRenderer is not reachable through the bridge at any depth', async ({
  page,
}) => {
  await page.waitForSelector('header');

  const leaked = await page.evaluate(() => {
    const seen = new Set<unknown>();
    const walk = (value: unknown): boolean => {
      if (value === null || typeof value !== 'object') return false;
      if (seen.has(value)) return false;
      seen.add(value);
      const record = value as Record<string, unknown>;
      if (typeof record.invoke === 'function' && typeof record.on === 'function') {
        return true;
      }
      return Object.values(record).some(walk);
    };
    return walk(window.hive);
  });

  expect(leaked).toBe(false);
});

test('the bridge round-trips to the main process', async ({ page }) => {
  await page.waitForSelector('header');

  const info = await page.evaluate(() => window.hive!.appInfo());

  expect(info.platform).toBe(process.platform);
  expect(info.electron).toMatch(/^\d+\.\d+\.\d+/);
});

test('the production CSP is applied, with no unsafe-eval and no wildcard', async ({
  page,
}) => {
  await page.waitForSelector('header');

  const csp = await page.evaluate(async () => {
    const response = await fetch(location.href);
    return response.headers.get('content-security-policy');
  });

  expect(csp).toBeTruthy();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  // `connect-src 'self'` is what stops rendered terminal content from becoming
  // an exfiltration path.
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).not.toContain('*');
});

test('window.open is denied', async ({ page }) => {
  await page.waitForSelector('header');

  const opened = await page.evaluate(() => window.open('https://example.com'));

  expect(opened).toBeNull();
});

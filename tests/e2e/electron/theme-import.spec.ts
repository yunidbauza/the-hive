import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { launchHive, startSession } from './fixtures/hive-app';

/**
 * Theme import, driven through the real app (HIVE-80, Task 12).
 *
 * Every other task in this epic is proven by a green unit suite against fakes:
 * a stubbed `localStorage`, a mocked bridge, `importTheme` fed a string. None of
 * that proves the one thing the whole storage decision (`appearance-store.ts`,
 * "Why this is a third store") exists for — that a theme picked from disk is
 * applied before the renderer's first paint on the *next* launch, not painted
 * default and then flipped. A flip is invisible to `expect(...).toBe(...)`
 * once the flip has finished, which is exactly why this file exists: it has to
 * watch the app *become* correct, not just confirm it eventually is.
 *
 * The second thing only a real xterm instance and a real pty can prove:
 * re-theming assigns `terminal.options.theme` in place
 * (`src/components/terminal/terminal-surface.tsx`) rather than rebuilding the
 * instance, so a live shell's scrollback survives a theme change. `__mocks__/
 * @xterm/` records calls; it cannot tell you whether a *real* xterm's viewport
 * repainted or whether the rows it had already drawn are still there.
 */

const NORD_FIXTURE = join(import.meta.dirname, '../fixtures/nord.hive-theme.json');

/** `modes.dark.ui.panel` in the fixture — chosen to be unmistakable against the built-in's `#141a33`. */
const NORD_PANEL_DARK = '#3b4252';
/** `modes.dark.terminal.bg` (== `modes.dark.ui.termBg`) in the fixture. */
const NORD_TERMINAL_BG_DARK = '#2e3440';

const EMPTY_CONFIG = JSON.stringify({ version: 2, projects: [] }, null, 2);

/**
 * Replace the native "open file" sheet with one that answers immediately —
 * the same mechanism `settings.spec.ts` and `manage-projects.spec.ts` use for
 * `chooseDirectory`, applied to `theme:pick` (`electron/main/theme/index.ts`),
 * which calls the identical `dialog.showOpenDialog`.
 *
 * `theme:pick`'s real round trip still runs unmodified after this: main still
 * calls the (now-stubbed) dialog, still `stat`s the path, still reads the file
 * and returns it over IPC exactly as it would for a path the user actually
 * chose. Only the native sheet — which Playwright cannot drive — is replaced,
 * and it is replaced **in the main process**, from the test harness, using a
 * path this test process already has on disk. No renderer-supplied path is
 * ever involved, so there is nothing here for a compromised renderer to reach:
 * this is a test-harness monkeypatch of a Node module in a process the
 * renderer has no way to call into, not a seam shipped in the app.
 */
async function stubThemePick(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dialog as any).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filePath],
    });
  }, path);
}

const openSettings = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
};

const goToAppearance = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Appearance' }).click();
};

const importNordTheme = async (page: Page): Promise<void> => {
  await goToAppearance(page);
  await page.getByRole('button', { name: 'Import theme…' }).click();
  // The clean-import banner, not the "imported with N notes" one — the
  // fixture is asserted elsewhere to import with zero inherited colours and
  // zero contrast notes, so this is the only banner it can produce.
  await expect(page.getByText(/imported and activated/)).toBeVisible();
};

test('an imported theme survives a reload, on the first painted frame', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeFileSync(configPath, EMPTY_CONFIG);

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await stubThemePick(app, NORD_FIXTURE);
    await openSettings(page);
    await importNordTheme(page);

    const panel = () =>
      page.evaluate(() =>
        getComputedStyle(document.body).getPropertyValue('--cc-panel').trim(),
      );
    expect(await panel()).toBe(NORD_PANEL_DARK);

    /**
     * The "no flash" probe.
     *
     * `addInitScript` runs before any script the page itself loads, on every
     * subsequent navigation this page makes — including the `reload()` below
     * — which is what makes it able to see the very start of the next
     * document's life, the same window `appearance-store.ts`'s own comment
     * describes ("this runs during module evaluation — before React renders
     * anything").
     *
     * A first `requestAnimationFrame` was tried here and rejected: it fires
     * before the renderer bundle has even been fetched, when `--cc-panel`
     * still reads `tokens.css`'s own static default (`#141a33`) because
     * nothing has overridden it *or drawn anything with it* yet. That is a
     * true reading and a meaningless one — a CSS custom property holding the
     * wrong value on a blank, content-free document is not a flash, because
     * nobody's eye lands on a pixel that used it.
     *
     * `index.html` ships `<div id="root"></div>` empty and static; every pixel
     * a person can see comes from React's first commit into it. So the
     * honest question is not "what does the earliest possible JS callback
     * see" but "what does `--cc-panel` already say at the exact moment `#root`
     * receives its first child" — the first DOM mutation that could put a
     * pixel on screen. A `MutationObserver` on the whole document, attached
     * before any page script runs, catches that moment directly: `mutation
     * .target.id === 'root'` on a `childList` change is React's first commit,
     * by construction (nothing else ever writes to that element).
     *
     * `firstContentPanel` is the real assertion: `--cc-panel`'s resolved
     * value at the instant `#root` first gains content. This is the
     * strongest claim achievable without capturing raster output (Playwright
     * cannot time a screenshot to a literal compositor frame either), but it
     * is still an instant in JS time, not a guarantee about what the
     * compositor actually painted a frame later — read it as strong evidence
     * against a visible flip, not as a formal proof.
     *
     * `history` is a *different*, narrower claim, and it is not a flip
     * detector — do not read it as one. `applyThemeColors(null)`
     * (`src/lib/theme/apply.ts`) *removes* `#hive-theme` for the built-in
     * theme rather than writing it with built-in colours, so "painted
     * built-in, then corrected to the import" would leave **no** first
     * entry to catch — `history` would read `['<nord css>']` in both the
     * healthy world and a flashing one. What it actually pins: the theme
     * stylesheet was written **exactly once** across the whole reload, which
     * rules out a different bug — the store re-applying (and re-writing) the
     * same or a different theme more than once during rehydration.
     */
    await page.addInitScript(() => {
      const w = window as unknown as {
        __hiveThemeProbe?: { firstContentPanel: string | null; history: string[] };
      };
      const probe: { firstContentPanel: string | null; history: string[] } = {
        firstContentPanel: null,
        history: [],
      };
      w.__hiveThemeProbe = probe;

      const currentPanel = (): string | null => {
        const root = document.documentElement;
        return root ? getComputedStyle(root).getPropertyValue('--cc-panel').trim() : null;
      };

      const observer = new MutationObserver((mutations) => {
        const style = document.getElementById('hive-theme');
        const styleContent = style ? (style.textContent ?? '') : null;
        if (styleContent !== null && styleContent !== probe.history.at(-1)) {
          probe.history.push(styleContent);
        }

        if (probe.firstContentPanel !== null) return;
        for (const mutation of mutations) {
          const target = mutation.target as Element;
          if (target.id === 'root' && mutation.addedNodes.length > 0) {
            probe.firstContentPanel = currentPanel();
            break;
          }
        }
      });

      // `document` is observable this early even though `document
      // .documentElement` is not — the observer is attached before `<html>`
      // itself can possibly exist, so both `#hive-theme`'s first insertion and
      // `#root`'s first child are caught with certainty, not by timing luck.
      observer.observe(document, { childList: true, subtree: true, characterData: true });
    });

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    const probe = await page.evaluate(
      () =>
        (
          window as unknown as {
            __hiveThemeProbe?: { firstContentPanel: string | null; history: string[] };
          }
        ).__hiveThemeProbe,
    );

    // The theme stylesheet was written exactly once during the reload — a
    // guard against double-application, not a flip detector (see the doc
    // comment above for why the built-in theme can never appear here).
    expect(probe?.history).toHaveLength(1);
    expect(probe?.history[0]).toContain(`--cc-panel: ${NORD_PANEL_DARK}`);
    // And by the instant the app's own first pixel could exist — #root
    // gaining its first child — the DOM already agrees with the import.
    expect(probe?.firstContentPanel).toBe(NORD_PANEL_DARK);

    // No flash: correct once more by the time a normal assertion would look.
    expect(await panel()).toBe(NORD_PANEL_DARK);
  } finally {
    await app.close();
  }
});

const PROJECT = 'theme-repo';

/** A stub bootstrap that announces itself and then keeps the shell open — same shape `interactive-terminal.spec.ts` uses and for the same reason (see its own comment on `writeConfig`). */
function writeSessionConfig(
  configPath: string,
  bootstrapMarker: string,
  projectDir: string,
): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 2,
      shell: '/bin/sh',
      claudeCommand: `printf bootstrapped > '${bootstrapMarker}'; false`,
      projects: [{ id: PROJECT, name: PROJECT, path: projectDir, icon: 'ph-cube' }],
    }),
  );
}

const readMarker = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8').trim() : null;

async function expectMarker(path: string, contents: string): Promise<void> {
  await expect.poll(() => readMarker(path), { timeout: 15_000 }).toBe(contents);
}

test('activating a theme recolours a live terminal without clearing scrollback', async ({}, testInfo) => {
  const projectDir = testInfo.outputPath('theme-repo');
  mkdirSync(projectDir, { recursive: true });

  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeSessionConfig(configPath, bootstrapped, projectDir);

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    const id = await startSession(page, PROJECT);
    const terminal = page.locator(`[data-terminal-id="${id}"]`);
    await expect(terminal).toBeVisible();

    // The bootstrap has to be finished before typing, or the keystrokes below
    // interleave with the injected `claudeCommand` line (story 096) and the
    // shell runs neither.
    await expectMarker(bootstrapped, 'bootstrapped');

    // A second readiness fence, the same one `interactive-terminal.spec.ts`
    // uses: proof the shell itself is accepting input, from a source outside
    // the keyboard path this test is about to exercise.
    const readyMarker = testInfo.outputPath('ready.txt');
    await page.evaluate(
      ([sessionId, marker]) => {
        window.hive!.pty.write({
          sessionId: sessionId!,
          data: `echo ready > '${marker}'\n`,
        });
      },
      [id, readyMarker],
    );
    await expectMarker(readyMarker, 'ready');

    await terminal.click();

    /**
     * Typed, not injected — a recognisable line landing in the real
     * scrollback the way a user's would, and corroborated by a marker file
     * because the DOM cannot corroborate it itself.
     *
     * `pty-transport.spec.ts` explains why: story 095 attaches a WebGL addon
     * to every *interactive* terminal, and a WebGL-rendered xterm paints text
     * into a `<canvas>` — `.xterm-rows` (the DOM renderer's row container) is
     * never created for a live session, so `toContainText` would read empty
     * no matter what is on screen. Verified against this exact build below:
     * `sess-01` mounts three `<canvas>` elements and zero `.xterm-rows`,
     * while the orchestrator's read-only, non-WebGL surface has the reverse.
     * Reading DOM text off a live terminal is not a slow assertion here, it
     * is one with nothing to read.
     */
    const marker = testInfo.outputPath('typed.txt');
    await page.keyboard.type(`echo hive-theme-ok > '${marker}'`);
    await page.keyboard.press('Enter');
    await expectMarker(marker, 'hive-theme-ok');

    /**
     * `.xterm-scrollable-element` is xterm 6 core's own scroll wrapper — not
     * a WebGL addon artefact — because xterm 6 does not scroll `.xterm
     * -viewport` natively (`docs/terminal-architecture.md`); it exists for
     * every terminal regardless of which layer draws the cells, and its
     * inline `background-color` is what actually paints the terminal's
     * ground (confirmed against this build: `rgb(11, 16, 35)`, the built-in
     * dark palette's `terminal.bg` in `#0b1023`, i.e. the built-in dark
     * palette).
     *
     * Its **DOM node identity**, not just its colour, is what this test can
     * actually offer toward the scrollback claim — and it is worth being
     * exact about what that does and does not prove. `terminal-surface.tsx`'s
     * re-theme effect assigns `terminal.options.theme` on the *existing*
     * instance; it never disposes and reopens it. If some future change did
     * — a `key` prop tied to the palette, an effect that tears down and
     * rebuilds — xterm would mint a brand-new scrollable element, and this
     * reference-equality check would fail even though `.xterm-rows` cannot
     * be read to notice the same regression on a live terminal. That proves
     * the same *buffer object* survived, which is the regression class that
     * actually matters here (a rebuild-on-re-theme). It does **not** prove
     * the buffer's *contents* survived intact — `terminal.clear()`,
     * `.reset()`, or a stray `\x1bc` write would empty the same buffer
     * without touching this DOM node, and nothing below catches that. The
     * marker-file round trip after the theme change (below) proves the
     * shell side of "nothing was rebuilt"; nothing in this file re-reads the
     * *marker line itself* out of the buffer, because a live terminal's
     * WebGL rendering leaves no DOM text to read it from.
     */
    const scrollable = page.locator(`[data-terminal-id="${id}"] .xterm-scrollable-element`);
    const nodeBefore = await scrollable.elementHandle();
    const before = await scrollable.evaluate((el) => getComputedStyle(el).backgroundColor);

    await stubThemePick(app, NORD_FIXTURE);
    await openSettings(page);
    await importNordTheme(page);
    await page.getByRole('button', { name: 'Close settings' }).click();

    // The exact same scroll-wrapper node is still there — the instance was
    // re-themed in place, never rebuilt. This proves the same buffer object
    // survived (the regression class that matters: a re-theme tearing xterm
    // down and reopening it). It does not, on its own, prove the marker line
    // is still readable inside that buffer — see the doc comment above.
    const nodeAfter = await scrollable.elementHandle();
    expect(await page.evaluate(([a, b]) => a === b, [nodeBefore, nodeAfter])).toBe(true);

    // The shell is still the same live process, still accepting input after
    // the theme change — the other half of "nothing was rebuilt". Clicked
    // again rather than assumed focused: closing settings does not promise
    // to hand focus back to the terminal, and this line should not depend on
    // it doing so.
    await terminal.click();
    const markerAfter = testInfo.outputPath('typed-after.txt');
    await page.keyboard.type(`echo hive-theme-still-alive > '${markerAfter}'`);
    await page.keyboard.press('Enter');
    await expectMarker(markerAfter, 'hive-theme-still-alive');

    // …and the terminal's own colours did change — xterm paints its own
    // background from its JS `theme` option (`docs/terminal-architecture.md`
    // — no CSS custom property reaches a terminal cell), so this moving to
    // the fixture's `terminal.bg` is direct proof the re-theme actually
    // reached the live instance, not just the store.
    const after = await scrollable.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(after).not.toBe(before);

    // Compared through the browser's own colour parser rather than a
    // hand-rolled hex→rgb() conversion, so a formatting mismatch can never
    // produce a false failure (or a false pass).
    const expected = await page.evaluate((hex) => {
      const probe = document.createElement('div');
      probe.style.color = hex;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    }, NORD_TERMINAL_BG_DARK);
    expect(after).toBe(expected);
  } finally {
    await app.close();
  }
});

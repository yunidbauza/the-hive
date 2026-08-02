import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration (story 070).
 *
 * Playwright exists here to make the two claims Vitest structurally cannot:
 * *the terminal actually renders* and *the keyboard-only loop actually works*.
 * happy-dom cannot run xterm and performs no layout, so unit tests mock the
 * library away entirely (`__mocks__/@xterm/`) and assert plumbing only. A real
 * browser is the only place the core promise gets checked.
 *
 * Today this runs a smoke spec against the shell. The suite story 070
 * specifies — terminal, keyboard, waiting-session, picker, simulation — lands
 * as the surfaces it drives are built (stories 040–061).
 */

/**
 * Preview's port, pinned rather than left to Vite's default so `baseURL` and
 * the `webServer` command cannot drift apart. `--strictPort` makes a busy port
 * fail loudly instead of silently serving the suite from a different one.
 */
const PORT = 4173;

export default defineConfig({
  testDir: './tests/e2e',

  /**
   * Specs run against **production output**, not the dev server: `pnpm build`
   * then `pnpm preview`. The dev server would test code that never ships —
   * different module graph, no minification, HMR client attached. The build
   * cost is paid once per run, and `reuseExistingServer` skips even that when
   * a preview is already up locally.
   *
   * CI always starts its own, so a stale server can never serve a green run.
   */
  webServer: {
    command: `pnpm build && pnpm preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    // A cold type-check-and-build is the long pole, not the serve.
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },

  use: {
    baseURL: `http://localhost:${PORT}`,
    /** Retained on failure only — a green run leaves no artifacts behind. */
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  /**
   * Chromium is the required project. Story 070 makes WebKit and Firefox
   * explicitly optional and non-CI-blocking, and this app targets a desktop
   * command center, not a browser matrix.
   *
   * The viewport is fixed at 1440×900: the shell is desktop-width by design
   * (story 020), with two fixed-width rails and a center column that absorbs
   * every resize. Narrower viewports are not a supported surface, so testing
   * one would assert against behaviour the app never promises.
   */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],

  fullyParallel: true,

  /**
   * No retries, deliberately. Story 070's acceptance criteria require the suite
   * to be deterministic across five consecutive runs — retries would convert
   * exactly the flake that criterion is trying to surface into a green tick.
   */
  retries: 0,

  /** A `.only` left in a spec silently narrows CI to one test. Fail instead. */
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
});

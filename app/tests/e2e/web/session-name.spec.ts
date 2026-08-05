import { expect, test, type Page } from '@playwright/test';

/**
 * Session labels after `entityLabel` (HIVE-61).
 *
 * Every surface that used to render `entity.id` now renders `entity.name ?? id`.
 * The regression that would introduce is invisible to a type-checker and to a
 * unit test that asserts on props: a wrong fallback renders an **empty label**,
 * and every session row in the app goes blank. Only a browser can say that the
 * text a user reads is still there.
 *
 * What this file does *not* cover is a session that has a name. The web target
 * is fixtures-only with no main process, so the only ways to produce one here
 * would be to expose the store on `window` or to give a fixture a name — both
 * production changes made solely to satisfy a test, and the second one would
 * change what the public demo shows. The named case is covered where it can be
 * driven honestly: `entityLabel` in `tests/types/entity.test.ts`, `renameSession`
 * in `tests/features/sessions/hooks/use-session-status.test.ts`, and the two-way
 * path against real `claude` in the HIVE-61 verification transcript.
 */

const APP_URL = '/?sim=0';

/** Fixture sessions, none of which has an agent-reported name. */
const SESSIONS = ['hero-refresh', 'lead-form'];

const rail = (page: Page) =>
  page.getByRole('navigation', { name: 'Projects, work, and agents' });

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
});

test('an unnamed session still reads as its id', async ({ page }) => {
  for (const id of SESSIONS) {
    await expect(rail(page).getByText(id, { exact: true }).first()).toBeVisible();
  }
});

test('the label survives onto the meta bar when a session is opened', async ({
  page,
}) => {
  await rail(page).getByText(SESSIONS[0]!, { exact: true }).first().click();

  // The meta bar names the session you are looking at; a blank one here is the
  // failure this whole file exists to catch.
  await expect(
    page.getByRole('main').getByText(SESSIONS[0]!, { exact: true }).first(),
  ).toBeVisible();
});

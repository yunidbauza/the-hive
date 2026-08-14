import { expect, test } from './fixtures/hive-app';

/**
 * What the desktop app looks like on a machine where nothing has started.
 *
 * ## Why this spec exists
 *
 * Every surface here used to open pre-populated. The store loaded a demo
 * dataset at boot — ten sessions, three agents, five projects, eight tickets —
 * so a fresh install of the *product* showed a fleet that did not exist: the
 * header counted four sessions working, the projects tree listed repositories
 * nobody had mapped, the orchestrator's table had ten rows, and the WORK tab
 * painted eight sample tickets for a frame before the real Jira read replaced
 * them.
 *
 * Unit tests can prove the store is empty. Only the built app can prove nothing
 * *paints* it, which is what this file does — and it screenshots each surface,
 * because "the header reads all zeros" is a claim worth being able to look at.
 *
 * The shared fixture launches with an empty profile and no config, which is
 * exactly the state under test: a first run, before the user has mapped
 * anything.
 */

test('the header counts nothing', async ({ page }) => {
  await page.waitForSelector('header');
  const header = page.getByRole('banner');

  await expect(header.getByText('0 working')).toBeVisible();
  await expect(header.getByText('0 waiting')).toBeVisible();
  await expect(header.getByText(/0 idle · 0 ended/)).toBeVisible();

  await header.screenshot({ path: 'test-results/evidence/header-zero.png' });
});

test('the projects tab explains that nothing is mapped', async ({ page }) => {
  await page.waitForSelector('header');

  const rail = page.getByRole('navigation', {
    name: 'Projects, work, and agents',
  });

  await expect(page.getByText(/No projects mapped/i)).toBeVisible();
  await expect(page.getByText('Settings → Projects')).toBeVisible();

  await rail.screenshot({ path: 'test-results/evidence/projects-empty.png' });
});

test('the orchestrator says its fleet is empty', async ({ page }) => {
  await page.waitForSelector('header');

  /**
   * `toContainText`, not `toHaveText`: the block leads with a drawn flavour
   * line and a creature now, and pinning the whole string would make this spec
   * a coin flip. The sentence telling the user what to do is the part that must
   * not move — `tests/e2e/web/swarm.spec.ts` asserts the flavour half.
   */
  await expect(page.getByTestId('session-table-empty')).toContainText(
    'No sessions running — start one with New session.',
  );

  await page
    .getByRole('main')
    .screenshot({ path: 'test-results/evidence/orchestrator-empty.png' });
});

/**
 * The WORK tab, which is the surface the whole change is named for.
 *
 * ## Deliberately agnostic about whether Jira answers
 *
 * A Jira credential can reach the app from the OS keychain or the environment,
 * neither of which the fixture's scratch profile controls. So this machine may
 * load a real backlog here and CI will not, and a spec that assumed either
 * would pass for the wrong reason on one of them.
 *
 * What is true on both is the assertion that matters: **no seeded ticket key is
 * ever painted** — not in the settled state, and not in the frame before it,
 * which is exactly where the eight `GRAC-` tickets used to flash.
 */
test('the work tab shows no ticket it did not get from Jira', async ({ page }) => {
  await page.waitForSelector('header');

  const rail = page.getByRole('navigation', {
    name: 'Projects, work, and agents',
  });
  await rail.getByRole('tab', { name: /^Work/ }).click();

  const work = page.locator('[data-panel="work"]');
  await expect(work).toBeVisible();

  await expect(page.getByText(/GRAC-\d+/)).toHaveCount(0);
  await expect(
    work.getByText('Hero refresh: migrate to semantic tokens'),
  ).toHaveCount(0);

  await rail.screenshot({ path: 'test-results/evidence/work-tab.png' });
});

/**
 * The skeleton itself, caught before the read answers.
 *
 * `loading` is the store's boot state, so the panel renders its placeholder
 * until the first status read comes back. Whether this wins that race depends
 * on how fast the machine answers, so the screenshot is best-effort — but the
 * two assertions are not: a skeleton is never an `article`, and no seeded key
 * appears while one is up.
 */
test('the work tab opens on a skeleton, not on data', async ({ page }) => {
  await page.waitForSelector('header');

  const rail = page.getByRole('navigation', {
    name: 'Projects, work, and agents',
  });
  await rail.getByRole('tab', { name: /^Work/ }).click();

  const skeleton = page.getByRole('status', { name: 'Loading tickets' });

  if (await skeleton.isVisible()) {
    await skeleton.screenshot({
      path: 'test-results/evidence/work-skeleton.png',
    });

    await expect(page.getByText(/GRAC-\d+/)).toHaveCount(0);
    /**
     * The placeholders must not be counted as tickets. They were `<article
     * aria-hidden>` at first, which passed every role-based check and still
     * made this locator report three cards on an empty panel.
     */
    await expect(page.locator('[data-panel="work"] article')).toHaveCount(0);
  }
});

test('the agents tab is empty and says why', async ({ page }) => {
  await page.waitForSelector('header');

  const rail = page.getByRole('navigation', {
    name: 'Projects, work, and agents',
  });
  await rail.getByRole('tab', { name: /^Agents/ }).click();

  await expect(page.getByText(/No agents running/i)).toBeVisible();
  await expect(page.getByText(/not available yet/i)).toBeVisible();
});

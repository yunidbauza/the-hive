import { expect, test } from '@playwright/test';

import { PHRASES } from '../../../src/lib/swarm/phrases';

/**
 * The swarm layer, in a real browser against production output.
 *
 * Unit tests prove the pools and the hook. They cannot prove that an animated
 * WebP survives the asset pipeline, that the creature is laid out rather than
 * collapsed to nothing, or that a flavour line actually reaches the rail — all
 * three are build-and-layout claims, and happy-dom performs no layout.
 *
 * The app boots empty, which is exactly the state this whole change is about,
 * so every surface asserted here is on screen at load with no setup.
 */

const APP_URL = '/?sim=0';

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
});

test('the dormant orchestrator holds a creature and a line', async ({ page }) => {
  const empty = page.getByTestId('session-table-empty');
  await expect(empty).toBeVisible();

  const creature = empty.locator('[data-creature="overlord"]');
  await expect(creature).toBeVisible();

  /**
   * The asset has to have *decoded*, not merely resolved to a URL. A 404 still
   * produces a visible <img>; a zero natural width is what a broken sprite
   * looks like from the outside.
   */
  const decoded = await creature.evaluate(
    (img) => (img as HTMLImageElement).naturalWidth,
  );
  expect(decoded).toBeGreaterThan(0);

  // Laid out at the size it was asked for, not collapsed.
  const box = await creature.boundingBox();
  expect(box?.height).toBeGreaterThan(50);

  await expect(empty).toContainText('No sessions running — start one with New session.');

  const text = (await empty.textContent()) ?? '';
  const drew = PHRASES['empty.sessions'].some((phrase) => text.includes(phrase));
  expect(drew, `no phrase from empty.sessions in: ${text}`).toBe(true);
});

/**
 * Each rail panel, in its own empty state, carrying a flavour line above copy
 * that is still there. The second half is the point: the change is additive,
 * and a rail that lost its instruction would be a regression this spec should
 * catch before review does.
 *
 * PRs is deliberately absent.
 *
 * Its empty state only renders when the source is `live`, and the browser
 * build has no `gh` to be live against — it shows a "needs the desktop app"
 * message instead, which is a different state with no flavour line. The pool
 * is covered by the unit tests; proving it here would need the Electron
 * project and a signed-in `gh`.
 */
const RAILS = [
  {
    tab: 'Inbox',
    rail: 'Activity',
    pool: 'empty.inbox' as const,
    keeps: 'Nothing needs you.',
  },
  {
    tab: 'Projects',
    rail: 'Projects, work, and agents',
    pool: 'empty.projects' as const,
    keeps: 'No projects mapped.',
  },
  {
    tab: 'Agents',
    rail: 'Projects, work, and agents',
    pool: 'empty.agents' as const,
    keeps: 'No agents running.',
  },
];

for (const { tab, rail, pool, keeps } of RAILS) {
  test(`the ${tab.toLowerCase()} rail leads with a phrase and keeps its copy`, async ({
    page,
  }) => {
    const region = page.getByRole(
      rail === 'Activity' ? 'complementary' : 'navigation',
      { name: rail },
    );

    await region.getByRole('tab', { name: tab }).click();

    await expect(region).toContainText(keeps);

    const line = region.locator('[data-swarm-line]').first();
    await expect(line).toBeVisible();

    const drew = (await line.textContent()) ?? '';
    expect(PHRASES[pool], `"${drew}" is not in ${pool}`).toContain(drew);
  });

  test(`the ${tab.toLowerCase()} rail keeps the creature out`, async ({ page }) => {
    /**
     * The rails get the line and never the illustration. `empty-state.tsx`
     * argues a decorative empty state in a 268px column beside a live terminal
     * takes more attention than the thing it is apologising for, and this is
     * the assertion that keeps a future change from quietly reversing that.
     */
    const region = page.getByRole(
      rail === 'Activity' ? 'complementary' : 'navigation',
      { name: rail },
    );

    await region.getByRole('tab', { name: tab }).click();
    await expect(region.locator('[data-swarm-line]').first()).toBeVisible();

    await expect(region.locator('[data-creature]')).toHaveCount(0);
  });
}

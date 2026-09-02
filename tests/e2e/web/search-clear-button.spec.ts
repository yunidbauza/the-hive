import { expect, test } from '@playwright/test';

import type { CDPSession, Page } from '@playwright/test';

/**
 * One clear button in a search box, not two.
 *
 * ## What this spec exists to catch
 *
 * The Explorer and PRs boxes are `<input type="search">`, and both draw their
 * own themed clear button beside the field so it matches the rest of the rail.
 * Chromium draws one *too*: `::-webkit-search-cancel-button`, a blue X painted
 * into the input's user-agent shadow tree the moment a focused search field has
 * content. The result was two X's a few pixels apart, one of them a colour the
 * theme never chose.
 *
 * Nothing in the DOM says so. The native button is not an element the page can
 * see — `querySelectorAll` never returns it, `getComputedStyle(input, '::-…')`
 * answers about the input rather than the pseudo element, and happy-dom paints
 * nothing at all. The only way to ask whether it is on screen is to pierce the
 * user-agent shadow tree over CDP and measure the box, which is what this does:
 * suppressed, the node still exists and its box is 0×0.
 *
 * The fix is one rule in `global.css` rather than dropping `type="search"`,
 * which keeps the field's `searchbox` role and its native Escape-to-clear. So
 * the assertion is deliberately over *every* search box the page is showing —
 * the rule is global, and a second one added later inherits both the behaviour
 * and this guard.
 */

const APP_URL = '/?sim=0';

/** The pseudo element Chromium hangs on a non-empty, focused search field. */
const CANCEL_BUTTON = '-webkit-search-cancel-button';

interface CdpNode {
  nodeId: number;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

/** Every node in the tree, user-agent shadow roots included. */
function flatten(node: CdpNode, out: CdpNode[] = []): CdpNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  for (const shadow of node.shadowRoots ?? []) flatten(shadow, out);
  return out;
}

/** `['pseudo', '-webkit-…']` is how CDP reports what a shadow node stands for. */
function pseudoOf(node: CdpNode): string | undefined {
  const attrs = node.attributes ?? [];
  const at = attrs.indexOf('pseudo');
  return at === -1 ? undefined : attrs[at + 1];
}

/**
 * The width of every native cancel button currently laid out.
 *
 * A node with no box at all — `DOM.getBoxModel` throws — counts as zero: that
 * is what a `display: none` decoration would look like, and it is just as
 * absent as one sized away.
 */
async function cancelButtonWidths(cdp: CDPSession): Promise<number[]> {
  const { root } = (await cdp.send('DOM.getDocument', {
    depth: -1,
    pierce: true,
  })) as { root: CdpNode };

  const widths: number[] = [];

  for (const node of flatten(root)) {
    if (pseudoOf(node) !== CANCEL_BUTTON) continue;
    try {
      const { model } = await cdp.send('DOM.getBoxModel', {
        nodeId: node.nodeId,
      });
      widths.push(model.width);
    } catch {
      widths.push(0);
    }
  }

  return widths;
}

/**
 * Every search box the browser target can reach, and how to get to it.
 *
 * The two live in different rails — PRS in the activity rail on the right, WORK
 * in the left one — which is why each carries its own way in rather than
 * sharing a tab helper.
 *
 * The Explorer's box is missing on purpose: it needs a session with a
 * repository behind it, and the browser target has no bridge to provide one. It
 * is the same `type="search"` under the same global rule, and the two here
 * prove the rule ships.
 */
const BOXES = [
  {
    label: 'Search pull requests',
    open: (page: Page) =>
      page
        .getByRole('tablist', { name: 'Activity sections' })
        .getByRole('tab', { name: /^PRs/i })
        .click(),
  },
  {
    label: 'Search tickets',
    open: (page: Page) =>
      page
        .getByRole('navigation', { name: 'Projects, work, and agents' })
        .getByRole('tab', { name: /^Work/ })
        .click(),
  },
];

for (const { label, open } of BOXES) {
  test(`${label}: one clear button, not Chromium’s as well`, async ({
    page,
  }) => {
    await page.goto(APP_URL);
    await page.waitForSelector('header');
    await open(page);

    await expectOneClearButton(page, label);
  });
}

async function expectOneClearButton(page: Page, label: string): Promise<void> {
  const box = page.getByLabel(label);

  /*
    Clicked and typed rather than filled. The native button only appears once
    the field is focused *and* non-empty, so a programmatic `fill` — which
    leaves the field unfocused — is a run that can never fail.
  */
  await box.click();
  await box.pressSequentially('migrate');
  await expect(box).toHaveValue('migrate');

  // The box's own clear button is on screen — otherwise the count below is one
  // that nothing was ever offering.
  await expect(
    page.getByRole('button', { name: 'Clear the search' }),
  ).toBeVisible();

  const cdp = await page.context().newCDPSession(page);
  const widths = await cancelButtonWidths(cdp);

  // The pseudo element is still in the shadow tree; what it must not have is a
  // box. An empty list would mean the search field itself stopped rendering.
  expect(widths.length).toBeGreaterThan(0);
  expect(widths).toEqual(widths.map(() => 0));
}

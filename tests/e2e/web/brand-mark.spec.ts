import { expect, test } from '@playwright/test';

/**
 * The header mark's pool sits *behind* the sprite (HIVE-100).
 *
 * ## Why this is an e2e
 *
 * The rule lives in `global.css`, and happy-dom loads no stylesheet — so a
 * component test can prove the mark is wrapped in `.brand-bloom` and can never
 * prove what `.brand-bloom` then does.
 *
 * ## The bug it pins
 *
 * `.brand-bloom::before` is absolutely positioned, which makes it a
 * **positioned** box — and positioned boxes paint *after* non-positioned inline
 * content. So the default paint order puts the pool on top of the very sprite
 * it exists to sit behind, washing the creature blue instead of lifting it off
 * the ground.
 *
 * That failure is nasty precisely because it still looks like "a faint glow".
 * It shipped, and was caught by eye rather than by any gate — reported as "the
 * glow doesn't work too well", which is exactly what a blue film over a dark
 * sprite looks like from the outside.
 *
 * The fix promotes the sprite into the same positioned layer, so DOM order
 * settles it and `::before` is first by definition. `z-index: -1` on the
 * pseudo-element is the usual reflex and is wrong here: neither the header nor
 * the span establishes a stacking context, so it would drop the pool behind the
 * header's own background and hide it completely.
 */
test('the pool paints behind the mark, not over it', async ({ page }) => {
  await page.goto('/?sim=0');
  await page.waitForSelector('header');

  const layering = await page.evaluate(() => {
    const pool = document.querySelector('header .brand-bloom');
    const sprite = pool?.querySelector('img');
    if (!pool || !sprite) return null;

    const before = getComputedStyle(pool, '::before');
    return {
      /*
        Both positioned, so paint order follows the DOM and the pseudo-element
        comes first. A `static` sprite is the regression.
      */
      sprite: getComputedStyle(sprite).position,
      pool: getComputedStyle(pool).position,
      /*
        And the pool is actually drawn. Without this the assertions above are
        vacuously true of an element that paints nothing — a mistyped
        `color-mix` or a `--cc-bloom` that failed to cascade resolves to
        `none`, and every layering claim still passes.
      */
      content: before.content,
      background: before.backgroundImage,
      filter: before.filter,
      width: parseFloat(before.width),
    };
  });

  expect(layering).not.toBeNull();
  expect(layering!.sprite).toBe('relative');
  expect(layering!.pool).toBe('relative');
  expect(layering!.content).not.toBe('none');
  expect(layering!.background).toContain('radial-gradient');
  expect(layering!.filter).toContain('blur');

  /*
    Wider than the 40px mark it sits under, or none of it is ever seen: the
    sprite covers its own centre, so only what spills past the silhouette
    reaches the screen. This is why the pool is sized in fixed pixels rather
    than as a percentage inset of the mark.
  */
  expect(layering!.width).toBeGreaterThan(40);
});

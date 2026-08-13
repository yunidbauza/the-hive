import { describe, expect, it, vi } from 'vitest';

import {
  alphaFor,
  keyFrame,
  KEY_CLEAR,
  KEY_SOLID,
  LOG_SCHEDULE,
  scheduleCopy,
  showFallback,
  WORDMARK_START,
  WORDMARK_STEP,
  type KeyingContext,
} from '@/splash/chamber';

/**
 * The chamber's logic, away from the document that runs it.
 *
 * `splash.ts` cannot be imported here — it reaches for `#sprite` the moment it
 * loads and pulls in a `data:` URI of an mp4 — which is exactly why everything
 * worth asserting was moved into `chamber.ts`. What a real browser has to prove
 * instead (that the video decodes, that the canvas is not tainted, that the
 * creature is actually on screen) is in `tests/e2e/electron/splash.spec.ts`.
 */

describe('alphaFor', () => {
  it('drops the white ground entirely', () => {
    expect(alphaFor(255)).toBe(0);
    expect(alphaFor(KEY_CLEAR)).toBe(0);
  });

  it('keeps the creature fully opaque', () => {
    expect(alphaFor(0)).toBe(255);
    expect(alphaFor(120)).toBe(255);
    expect(alphaFor(KEY_SOLID)).toBe(255);
  });

  it('ramps between the two, rather than cutting', () => {
    const midpoint = Math.round((KEY_CLEAR + KEY_SOLID) / 2);
    const alpha = alphaFor(midpoint);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(255);
  });

  it('is monotonic — darker is never less opaque', () => {
    for (let min = 1; min <= 255; min++) {
      expect(alphaFor(min)).toBeLessThanOrEqual(alphaFor(min - 1));
    }
  });

  it('clears the compression ringing that a 248 cutoff left behind', () => {
    // The fringe this was tuned to remove: near-white, but not white.
    expect(alphaFor(245)).toBe(0);
  });
});

describe('keyFrame', () => {
  /** Four pixels: white ground, mid-ramp, saturated creature, black. */
  const pixels = () =>
    new Uint8ClampedArray([
      255, 255, 255, 255, 232, 232, 232, 255, 140, 90, 40, 255, 0, 0, 0, 255,
    ]);

  const contextWith = (data: Uint8ClampedArray) => {
    const image = { data, width: 4, height: 1, colorSpace: 'srgb' } as ImageData;
    const ctx: KeyingContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => image),
      putImageData: vi.fn(),
    };
    return { ctx, image };
  };

  it('rewrites alpha from the darkest channel and puts the frame back', () => {
    const { ctx, image } = contextWith(pixels());
    const source = {} as CanvasImageSource;

    keyFrame(ctx, source, 4, 1);

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 4, 1);
    expect(ctx.drawImage).toHaveBeenCalledWith(source, 0, 0, 4, 1);
    expect(ctx.putImageData).toHaveBeenCalledWith(image, 0, 0);

    const alphas = [image.data[3], image.data[7], image.data[11], image.data[15]];
    expect(alphas[0]).toBe(0); // white ground
    expect(alphas[1]).toBe(alphaFor(232)); // in the ramp
    expect(alphas[2]).toBe(255); // creature
    expect(alphas[3]).toBe(255); // shadow
  });

  it('leaves colour untouched — only alpha is rewritten', () => {
    const { ctx, image } = contextWith(pixels());
    keyFrame(ctx, {} as CanvasImageSource, 4, 1);
    expect([image.data[8], image.data[9], image.data[10]]).toEqual([140, 90, 40]);
  });

  it('judges a pixel by its darkest channel, not its brightness', () => {
    // Bright green: two channels are pale, one is not. It is the creature.
    const { ctx, image } = contextWith(new Uint8ClampedArray([250, 250, 30, 255]));
    keyFrame(ctx, {} as CanvasImageSource, 1, 1);
    expect(image.data[3]).toBe(255);
  });
});

describe('scheduleCopy', () => {
  const chamber = (letters: number, lines: number) => {
    const root = document.createElement('div');
    const wordmark = document.createElement('p');
    wordmark.className = 'wordmark';
    for (let i = 0; i < letters; i++) wordmark.append(document.createElement('span'));
    const log = document.createElement('ul');
    log.className = 'log';
    for (let i = 0; i < lines; i++) log.append(document.createElement('li'));
    root.append(wordmark, log);
    return root;
  };

  it('walks the wordmark out one letter at a time', () => {
    const root = chamber(3, 0);
    scheduleCopy(root);

    const delays = [...root.querySelectorAll<HTMLElement>('.wordmark span')].map(
      (span) => span.style.animationDelay,
    );
    expect(delays).toEqual([
      `${WORDMARK_START}s`,
      `${WORDMARK_START + WORDMARK_STEP}s`,
      `${WORDMARK_START + WORDMARK_STEP * 2}s`,
    ]);
  });

  it('lands every log line on its scheduled second', () => {
    const root = chamber(0, LOG_SCHEDULE.length);
    scheduleCopy(root);

    const delays = [...root.querySelectorAll<HTMLElement>('.log li')].map(
      (line) => line.style.animationDelay,
    );
    expect(delays).toEqual(LOG_SCHEDULE.map((at) => `${at}s`));
  });

  it('finishes inside the floor the main process holds', async () => {
    const { SPLASH_MIN_MS } = await import('@shared/splash');
    expect(Math.max(...LOG_SCHEDULE) * 1000).toBeLessThan(SPLASH_MIN_MS);
  });

  it('holds an unscheduled extra line with the last one rather than showing it first', () => {
    const root = chamber(0, LOG_SCHEDULE.length + 1);
    scheduleCopy(root);

    const delays = [...root.querySelectorAll<HTMLElement>('.log li')].map(
      (line) => line.style.animationDelay,
    );
    expect(delays.at(-1)).toBe(`${LOG_SCHEDULE.at(-1)}s`);
    expect(delays.at(-1)).not.toBe('0s');
  });
});

describe('showFallback', () => {
  it('swaps the canvas for the image', () => {
    const canvas = document.createElement('canvas');
    const image = document.createElement('img');
    image.hidden = true;

    showFallback(canvas, image);

    expect(canvas.hidden).toBe(true);
    expect(image.hidden).toBe(false);
  });

  it('clears the entrance delay, so a late swap is not late twice', () => {
    const canvas = document.createElement('canvas');
    const image = document.createElement('img');

    showFallback(canvas, image);

    expect(image.style.animationDelay).toBe('0s');
  });
});

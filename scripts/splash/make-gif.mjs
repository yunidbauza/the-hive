/**
 * Convert the Hive sprite from mp4 to a transparent animated GIF.
 *
 * The GIF is the splash's fallback: `src/splash/splash.ts` keys the mp4's white
 * ground to alpha on a canvas every frame, and if the video never yields a
 * frame — no decoder, a codec-stripped build, a corrupt asset — the GIF is what
 * the chamber shows instead. So it has to carry the same transparency the
 * canvas produces, baked in, or the fallback is a white box on a dark screen.
 *
 * ## Why a browser decodes it
 *
 * There is no ffmpeg in this toolchain and adding one for a single asset step
 * is a poor trade. Chromium already decodes H.264 and already has a canvas, so
 * the conversion borrows Playwright's browser — a devDependency this repo has
 * for the e2e suite — seeks frame by frame, keys each one, and hands PNGs to
 * Pillow to pack into a GIF. Same shape as `scripts/icon/generate-app-icon.py`:
 * a one-off asset step, run by hand, with what it writes committed.
 *
 * ## Why the alpha is binary
 *
 * GIF89a has no alpha channel. It has one palette index that means
 * "transparent", so a pixel is either fully there or fully gone. The canvas
 * keyer can ramp; this cannot. The threshold sits where the sprite's own
 * outline stops and its white ground begins.
 *
 *     node scripts/splash/make-gif.mjs
 *
 * Needs Pillow (`pip install pillow`). Says so and exits non-zero if absent
 * rather than writing a broken asset.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = join(appRoot, 'src/splash/hive.mp4');
const TARGET = join(appRoot, 'src/splash/hive.gif');
const SCRATCH = join(appRoot, 'node_modules/.cache/splash-frames');

/**
 * Timestamps sampled across the loop, not frames written.
 *
 * The source is half a second long and holds about five distinct frames, so
 * oversampling it and dropping the duplicates finds them without this script
 * having to know the sprite's frame rate. What survives sets the GIF's timing.
 */
const SAMPLES = 24;
/** Output width. The splash draws the sprite 352px tall; this is headroom. */
const WIDTH = 400;
/**
 * A pixel's darkest channel. White ground is 255 in all three; every part of
 * the sprite has at least one channel well below this.
 */
const KEY_THRESHOLD = 238;

async function extractFrames() {
  const b64 = readFileSync(SOURCE).toString('base64');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(
      async ({ b64, frames, width, threshold }) => {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.src = `data:video/mp4;base64,${b64}`;

        const decoded = await new Promise((resolve) => {
          video.onloadeddata = () => resolve(true);
          video.onerror = () => resolve(false);
          setTimeout(() => resolve(false), 10_000);
        });
        if (!decoded || !video.videoWidth) {
          return { error: 'the browser could not decode the mp4', pngs: [] };
        }

        const height = Math.round((video.videoHeight / video.videoWidth) * width);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const pngs = [];
        for (let i = 0; i < frames; i++) {
          // Seek rather than play: `currentTime` is exact and does not depend
          // on how fast this machine happens to run the loop.
          const t = (i / frames) * video.duration;
          await new Promise((resolve) => {
            video.onseeked = resolve;
            video.currentTime = t;
          });
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(video, 0, 0, width, height);
          const image = ctx.getImageData(0, 0, width, height);
          const p = image.data;
          for (let j = 0; j < p.length; j += 4) {
            let m = p[j] < p[j + 1] ? p[j] : p[j + 1];
            if (p[j + 2] < m) m = p[j + 2];
            p[j + 3] = m >= threshold ? 0 : 255;
          }
          ctx.putImageData(image, 0, 0);
          pngs.push(canvas.toDataURL('image/png').split(',')[1]);
        }
        return { error: null, pngs, width, height, duration: video.duration };
      },
      { b64, frames: SAMPLES, width: WIDTH, threshold: KEY_THRESHOLD },
    );
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    await browser.close();
  }
}

/**
 * Pack the keyed PNGs into one GIF.
 *
 * `colors=255` deliberately leaves index 255 unused so it can mean transparent,
 * and `disposal=2` clears each frame before the next — without it the sprite
 * smears, because a transparent pixel would leave the previous frame showing
 * through rather than the page behind.
 */
const PACK = `
import sys, glob
from PIL import Image

paths = sorted(glob.glob(sys.argv[1] + "/*.png"))
out, duration = sys.argv[2], int(sys.argv[3])

def flatten(rgba):
    alpha = rgba.getchannel("A")
    indexed = rgba.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=255)
    indexed.paste(255, Image.eval(alpha, lambda a: 255 if a <= 128 else 0))
    return indexed

frames = [flatten(Image.open(p).convert("RGBA")) for p in paths]
frames[0].save(out, save_all=True, append_images=frames[1:], transparency=255,
               disposal=2, loop=0, duration=duration, optimize=False)
print("frames", len(frames), "duration", duration)
`;

const { pngs, width, height, duration } = await extractFrames();

/**
 * Drop the duplicates the oversampling produced.
 *
 * Byte equality is enough: every sample came out of the same encoder at the
 * same size, so two identical frames are identical files. Without this the GIF
 * carries twenty-four entries that Pillow silently merges, and the merge sums
 * their durations — which is how a half-second loop turns into six hundred
 * milliseconds.
 */
const unique = pngs.filter((png, i) => i === 0 || png !== pngs[i - 1]);

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
unique.forEach((png, i) => {
  writeFileSync(join(SCRATCH, `${String(i).padStart(3, '0')}.png`), Buffer.from(png, 'base64'));
});

/** The real loop length divided by the frames that actually differ. */
const perFrame = Math.max(20, Math.round((duration * 1000) / unique.length));
try {
  const out = execFileSync(
    'python3',
    ['-c', PACK, SCRATCH, TARGET, String(perFrame)],
    { encoding: 'utf8' },
  );
  console.log(out.trim());
} catch (error) {
  console.error(
    'could not pack the GIF. This step needs Pillow: pip install pillow\n',
    error.stderr ?? error.message,
  );
  process.exit(1);
}
rmSync(SCRATCH, { recursive: true, force: true });
console.log(
  `wrote ${TARGET} — ${width}x${height}, ${unique.length} distinct frames ` +
    `from ${SAMPLES} samples, ${perFrame}ms each`,
);

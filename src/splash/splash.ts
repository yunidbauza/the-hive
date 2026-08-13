import { keyFrame, scheduleCopy, showFallback } from './chamber';
import hiveGif from './hive.gif';
import hiveVideo from './hive.mp4?inline';

import './splash.css';

/**
 * The Overmind Chamber's entry point: assets, the document, and the video.
 *
 * Everything that makes a decision is in `chamber.ts`, which imports nothing
 * and runs nothing, and is tested there. What is left here is the wiring a unit
 * test cannot reach anyway — a real `<video>`, a real canvas context, and the
 * two asset imports that must not be mocked to mean anything.
 *
 * There is no store, no IPC, and no import from `src/` outside this directory.
 * The splash exists to be on screen before any of that has loaded, and the
 * ESLint zone in `eslint.config.mjs` makes that a build failure rather than a
 * convention.
 *
 * ## Why a canvas
 *
 * The sprite is a video of the Hive on a white ground. Nothing removes that
 * ground for us: mp4 carries no alpha channel, and no blend mode drops white
 * without also eating the creature's pale carapace. So every frame is drawn to
 * a canvas and keyed by hand, which is a few milliseconds of pixel work on a
 * document that has nothing else to do.
 *
 * ## Why the video is inlined and the fallback is not
 *
 * `hive.mp4` arrives as a `data:` URI (`?inline`), and that is load-bearing
 * rather than tidy. `getImageData` on a canvas that has drawn a `file://`
 * resource throws `SecurityError` in Chromium — the packaged app loads its
 * renderer over `file://`, so a video referenced by URL would key perfectly in
 * `electron-vite dev` and fail on the built app, which is the worst shape a bug
 * can have. A `data:` URI is same-origin and never taints. It costs one CSP
 * token (`media-src 'self' data:`) and about 93 KB of base64 in the bundle.
 *
 * `hive.gif` stays an ordinary emitted asset because it never touches a canvas
 * — it is an `<img>` — so it cannot taint anything, and inlining half a
 * megabyte of base64 into a document that has to paint immediately would cost
 * the splash the very moment it exists to fill.
 *
 * Its `src` is set at load and the element merely stays hidden, which was not
 * the first design: setting the source only on the failing path saved a decode
 * on every normal launch, and cost the fallback its reason to exist. A swap
 * that begins by *starting* a 512 KB load has to finish it before anything
 * appears, and the window it has to do that in is measured against a floor that
 * is already running. Loading it up front is a local file read the splash has
 * several seconds of nothing else to do during, and it makes the
 * fallback instantaneous instead of merely eventual.
 */

/**
 * How long to wait for a first video frame before showing the GIF instead.
 *
 * Measured, not guessed: on a warm start the first frame lands well inside
 * 600ms, but the first launch after a build misses that and swaps to the
 * fallback for no reason. This sits far enough past the slow case to leave the
 * video its chance, and far enough inside `SPLASH_MIN_MS` that a swap still has
 * more than a second on screen.
 */
const DECODE_GRACE_MS = 1200;

function drawCreature(canvas: HTMLCanvasElement, fallback: HTMLImageElement): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    showFallback(canvas, fallback);
    return;
  }

  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.src = hiveVideo;
  // A rejected play() is not an error worth surfacing: the grace timer below
  // reaches the same conclusion, and the fallback is already the answer.
  void video.play().catch(() => undefined);

  let painted = false;
  const grace = window.setTimeout(() => {
    if (!painted) showFallback(canvas, fallback);
  }, DECODE_GRACE_MS);

  video.addEventListener('error', () => {
    window.clearTimeout(grace);
    showFallback(canvas, fallback);
  });

  const paint = (): void => {
    if (video.readyState < 2 || !video.videoWidth) return;
    keyFrame(ctx, video, canvas.width, canvas.height);
    if (!painted) {
      painted = true;
      window.clearTimeout(grace);
    }
  };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // One frame, held. The preference is about motion, not about the creature.
    video.addEventListener('loadeddata', paint, { once: true });
    return;
  }

  const loop = (): void => {
    paint();
    window.requestAnimationFrame(loop);
  };
  window.requestAnimationFrame(loop);
}

const canvas = document.querySelector<HTMLCanvasElement>('#sprite');
const fallback = document.querySelector<HTMLImageElement>('#sprite-fallback');

scheduleCopy(document);
if (canvas && fallback) {
  // Loaded up front, shown only if the video never paints.
  fallback.src = hiveGif;
  drawCreature(canvas, fallback);
}

/**
 * The chamber's behaviour, with nothing imported and nothing run.
 *
 * Split from `splash.ts` so it can be tested. The entry point has to import the
 * sprite — a `data:` URI of an mp4 and an emitted GIF — and has to touch the
 * document the moment it loads, which is exactly the shape a unit test cannot
 * get inside. Everything that makes a decision lives here instead, takes what
 * it needs as an argument, and returns rather than reaches.
 *
 * What that buys, beyond coverage: the alpha ramp — the one piece of real logic
 * in the splash — becomes checkable at its edges, and those edges are the
 * difference between a creature with a clean outline and one wearing a white
 * halo.
 */

/**
 * Where the sprite's white ground stops and the sprite begins.
 *
 * Tuned against the real asset rather than picked: the mp4 is H.264, so its
 * edges carry compression ringing — pixels that are nearly but not quite the
 * background. A cutoff at 248 left those as a visible speckled fringe around
 * every tentacle. Coming down to 242 takes the ringing with the ground while
 * still leaving the creature's bone plates, which are pale but not that pale,
 * fully opaque.
 */
export const KEY_CLEAR = 242;
export const KEY_SOLID = 222;

/**
 * The alpha for a pixel, from its darkest channel.
 *
 * Darkest rather than average, because the sprite's colours are saturated
 * browns, reds and greens: every one of them has at least one channel well
 * below the ground, while white has none. The ramp between the two thresholds
 * is what keeps the outline from turning into a cut-out.
 */
export function alphaFor(min: number): number {
  if (min >= KEY_CLEAR) return 0;
  if (min <= KEY_SOLID) return 255;
  return Math.round((255 * (KEY_CLEAR - min)) / (KEY_CLEAR - KEY_SOLID));
}

/** The slice of a 2D context this needs — so a test can supply one. */
export interface KeyingContext {
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(source: CanvasImageSource, x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): ImageData;
  putImageData(data: ImageData, x: number, y: number): void;
}

/** Draw one frame of the sprite with its ground keyed away. */
export function keyFrame(
  ctx: KeyingContext,
  source: CanvasImageSource,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  const frame = ctx.getImageData(0, 0, width, height);
  const p = frame.data;
  for (let i = 0; i < p.length; i += 4) {
    let min = p[i] < p[i + 1] ? p[i] : p[i + 1];
    if (p[i + 2] < min) min = p[i + 2];
    p[i + 3] = alphaFor(min);
  }
  ctx.putImageData(frame, 0, 0);
}

/** Where the wordmark's letters land, and how far apart. Seconds. */
export const WORDMARK_START = 0.62;
export const WORDMARK_STEP = 0.045;

/**
 * Where each log line lands. Seconds, and deliberately uneven — a boot that
 * reports at a metronome's pace reads as a progress bar wearing sentences. The
 * last one closes with the ring at ~2.4s, inside `SPLASH_MIN_MS`.
 */
export const LOG_SCHEDULE = [1.05, 1.35, 1.62, 1.92, 2.28];

/**
 * Stagger the wordmark and the log off one clock, so they cannot drift.
 *
 * In script rather than in the stylesheet because the alternative is ten
 * `nth-child` rules carrying hand-written delays, and a line added to the
 * markup would then animate at zero and arrive first.
 */
export function scheduleCopy(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.wordmark span').forEach((glyph, i) => {
    glyph.style.animationDelay = `${WORDMARK_START + i * WORDMARK_STEP}s`;
  });
  root.querySelectorAll<HTMLElement>('.log li').forEach((line, i) => {
    // A line past the end of the schedule holds with the last one rather than
    // animating at 0s and appearing before everything above it.
    line.style.animationDelay = `${LOG_SCHEDULE[i] ?? LOG_SCHEDULE[LOG_SCHEDULE.length - 1]}s`;
  });
}

/**
 * Play the creature into a canvas, keying its ground away frame by frame.
 *
 * Lives here rather than in either entry point because **both** documents draw
 * it — the splash and the About panel — and it was copied wholesale into the
 * second one. The module's own argument against duplicating {@link keyFrame}
 * applies just as well to the loop wrapped around it: two copies means two
 * places to fix the day the asset or the fallback logic changes, and the second
 * is wrong within a release.
 *
 * Still importing nothing. The video source, the grace and both elements arrive
 * as arguments, so this file remains a leaf that a test can reach into.
 *
 * @param graceMs how long to wait for a first frame before showing the GIF.
 *   The splash wants this generous — it runs during a cold start, where the
 *   first launch after a build can miss a short deadline for reasons unrelated
 *   to the video. Nothing is cold by the time About opens, so it wants it short:
 *   a long grace there is only a longer stare at an empty frame on the machines
 *   where the video will never play.
 */
export function drawCreature(
  canvas: HTMLCanvasElement,
  fallback: HTMLImageElement,
  videoSrc: string,
  graceMs: number,
): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    showFallback(canvas, fallback);
    return;
  }

  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.src = videoSrc;
  // A rejected play() is not an error worth surfacing: the grace timer below
  // reaches the same conclusion, and the fallback is already the answer.
  void video.play().catch(() => undefined);

  let painted = false;
  const grace = window.setTimeout(() => {
    if (!painted) showFallback(canvas, fallback);
  }, graceMs);

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

/**
 * Swap to the pre-keyed GIF, which is already loaded and waiting.
 *
 * The entrance delay is cleared on the way in. `.sprite` rises 0.3s after the
 * document loads, but a hidden element runs no animation — so unhiding it at,
 * say, 1.2s would start that 0.3s wait *then*, and the creature would arrive
 * well over a second after the moment it was needed. Zeroing the delay makes
 * the fallback rise from where it was swapped in rather than from the start.
 */
export function showFallback(canvas: HTMLElement, fallback: HTMLElement): void {
  fallback.style.animationDelay = '0s';
  fallback.hidden = false;
  canvas.hidden = true;
}

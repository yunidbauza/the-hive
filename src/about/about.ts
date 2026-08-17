import { pickPhrase } from '@lib/swarm/phrases';
import type { UpdateStatus } from '@shared/update-contract';

import { keyFrame, showFallback } from '../splash/chamber';
import hiveGif from '../splash/hive.gif';
import hiveVideo from '../splash/hive.mp4?inline';

import {
  platformLine,
  runtimeLine,
  scheduleWordmark,
  updateCopy,
  versionLine,
} from './panel';

import './about.css';

/**
 * The About panel's entry point: assets, the document, the video, the bridge.
 *
 * It replaces Electron's default about panel, which named the *framework* and
 * its version — true of the runtime, and not what anybody opens About to learn.
 *
 * ## What it shares with the splash, and why that is an import rather than a copy
 *
 * The creature is the same creature: the same mp4, the same GIF fallback, and
 * the same white-ground keying from `../splash/chamber.ts`. Duplicating the
 * keying would mean two thresholds to tune against one asset, and the second
 * one would be wrong within a release.
 *
 * ## What it does NOT share
 *
 * The splash's constraint is *time* — it must paint before the app's bundle
 * exists, so its lint zone forbids importing from the app at all. This window
 * has no such constraint: it opens on demand, long after the bridge is up. So
 * it may ask `window.hive` for the same `AppInfo` the Advanced pane uses, and
 * take its one line of copy from the app's own phrase pools rather than
 * carrying a second, drifting copy of the voice.
 */

/**
 * How long to wait for a first video frame before showing the GIF instead.
 *
 * The splash's grace, halved. That number is measured against a *cold* start,
 * where the first launch after a build can miss 600ms for reasons that have
 * nothing to do with the video. Nothing is cold by the time this window opens —
 * the app has been running — so a long grace only means a longer stare at an
 * empty frame on the machines where the video will not play at all.
 */
const DECODE_GRACE_MS = 600;

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
  // A rejected play() is not an error worth surfacing: the grace timer reaches
  // the same conclusion, and the fallback is already the answer.
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

/** Paint the update row from a status, and wire the button to the next step. */
function renderUpdate(
  row: HTMLElement,
  button: HTMLButtonElement,
  note: HTMLElement,
): void {
  const bridge = window.hive;
  if (!bridge) return;

  const apply = (status: UpdateStatus): void => {
    const copy = updateCopy(status);
    button.hidden = copy.label === null;
    if (copy.label !== null) button.textContent = copy.label;
    button.disabled = !copy.enabled;
    note.textContent = copy.note;
    /**
     * Revealed only once a status has resolved. A row that appears first and
     * fills in afterwards would flash a claim the app has not established, and
     * "up to date" is the worst possible thing to flash wrongly.
     */
    row.hidden = copy.label === null && copy.note === '';
  };

  const refresh = (): Promise<void> =>
    bridge.updates.status().then(apply, () => undefined);

  button.addEventListener('click', () => {
    /**
     * One verb, deliberately. `check()` reports its own result in a dialog and
     * resolves when it is done, and every actionable state this button offers —
     * look now, retry after an error, act on an available release — is served
     * by running that same interactive check rather than by a second path that
     * could disagree with the menu item.
     */
    button.disabled = true;
    void bridge.updates.check().finally(() => void refresh());
  });

  void refresh();
}

const canvas = document.querySelector<HTMLCanvasElement>('#sprite');
const fallback = document.querySelector<HTMLImageElement>('#sprite-fallback');

scheduleWordmark(document);

if (canvas && fallback) {
  // Loaded up front, shown only if the video never paints — the splash's
  // reasoning, and the reason the swap is instant rather than merely eventual.
  fallback.src = hiveGif;
  drawCreature(canvas, fallback);
}

const phrase = document.querySelector<HTMLElement>('#phrase');
if (phrase) phrase.textContent = pickPhrase('about.tagline');

const version = document.querySelector<HTMLElement>('#version');
const platform = document.querySelector<HTMLElement>('#platform');
const runtime = document.querySelector<HTMLElement>('#runtime');

void window.hive?.appInfo().then((info) => {
  if (version) version.textContent = versionLine(info);
  if (platform) platform.textContent = platformLine(info);
  if (runtime) runtime.textContent = runtimeLine(info);
});

const row = document.querySelector<HTMLElement>('#update');
const cta = document.querySelector<HTMLButtonElement>('#cta');
const note = document.querySelector<HTMLElement>('#update-note');
if (row && cta && note) renderUpdate(row, cta, note);

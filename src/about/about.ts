import { drawCreature } from '@/splash/chamber';
import hiveGif from '@/splash/hive.gif';
import hiveVideo from '@/splash/hive.mp4?inline';

import { pickPhrase } from '@lib/swarm/phrases';
import { checkForUpdates, readUpdateStatus } from '@lib/updates';
import type { UpdateStatus } from '@shared/update-contract';

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
 * the same `drawCreature` from `@/splash/chamber.ts` — the playback loop as
 * well as the keying, since duplicating either would mean two copies to fix the
 * day the asset changes, and the second would be wrong within a release. Only
 * the grace below differs, which is why it is a parameter.
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

/**
 * How often to re-read a status that is still moving. Milliseconds.
 *
 * Only while `checking` or `downloading`, and for a concrete reason: those two
 * states change on main's clock rather than on the user's, so a panel opened
 * mid-download rendered one frozen `Downloading… 40%` for as long as it stayed
 * open. Every other state is settled until the user acts, and polling it would
 * be a timer that learns nothing.
 */
const PROGRESS_POLL_MS = 900;

/** Paint the update row from a status, and wire the button to the next step. */
function renderUpdate(
  row: HTMLElement,
  button: HTMLButtonElement,
  note: HTMLElement,
): void {
  let timer: number | null = null;

  const apply = (status: UpdateStatus | null): void => {
    /**
     * `null` is "cannot ask" — the browser target has no bridge, and a failed
     * IPC answers the same way (see `lib/updates.ts`). Neither is something to
     * state in a window about the app, so the row simply stays hidden.
     */
    if (status === null) {
      row.hidden = true;
      return;
    }

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

    if (timer !== null) window.clearTimeout(timer);
    timer =
      status.state === 'checking' || status.state === 'downloading'
        ? window.setTimeout(() => void refresh(), PROGRESS_POLL_MS)
        : null;
  };

  const refresh = (): Promise<void> => readUpdateStatus().then(apply);

  button.addEventListener('click', () => {
    /**
     * One verb, deliberately. `check()` reports its own result in a dialog and
     * resolves when it is done, and every actionable state this button still
     * offers — look now, retry after an error, act on an available release — is
     * served by running that same interactive check rather than by a second
     * path that could disagree with the menu item.
     *
     * `ready` is deliberately *not* one of those states any more: it has no
     * verb behind it, so `updateCopy` renders it as a sentence instead of a
     * button. See `panel.ts`.
     */
    button.disabled = true;
    void checkForUpdates().then(() => refresh());
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
  drawCreature(canvas, fallback, hiveVideo, DECODE_GRACE_MS);
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

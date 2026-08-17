import type { AppInfo } from '@shared/ipc-contract';
import type { UpdateStatus } from '@shared/update-contract';

/**
 * The About panel's decisions, with nothing imported that runs and nothing run.
 *
 * Split from `about.ts` for the reason `chamber.ts` is split from `splash.ts`:
 * the entry point has to import a `data:` URI of an mp4, touch the document on
 * load, and talk to a bridge that only exists inside Electron — the exact shape
 * a unit test cannot get inside. Everything that *decides* lives here, takes
 * what it needs as an argument, and returns rather than reaches.
 *
 * What that buys beyond coverage: the update copy — the one place this window
 * can tell the user something untrue — becomes checkable at every state.
 */

/** Where the wordmark's letters land, and how far apart. Seconds. */
export const WORDMARK_START = 0.28;
export const WORDMARK_STEP = 0.042;

/**
 * Stagger the wordmark off one clock, so the letters cannot drift.
 *
 * In script rather than the stylesheet for the same reason the splash does it:
 * the alternative is eight `nth-child` rules carrying hand-written delays, and
 * a letter added to the markup would then animate at zero and arrive first.
 */
export function scheduleWordmark(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.wordmark span').forEach((glyph, i) => {
    glyph.style.animationDelay = `${WORDMARK_START + i * WORDMARK_STEP}s`;
  });
}

/** `Version 0.1.6` — the one string people paste into a bug report. */
export const versionLine = (info: AppInfo): string => `Version ${info.version}`;

/**
 * The runtime lines along the bottom — **two of them, and that is not styling.**
 *
 * As one line this read `darwin · electron 43.2.0 · chromium 150.0.7871.129`,
 * which is wider than a 420px panel and wrapped *inside a version number*.
 * A version broken across two lines is worse than no version: it is the string
 * people copy into a bug report, and half of one pasted anywhere is wrong.
 * Splitting it deliberately means each line is short enough to stay whole.
 *
 * The versions Electron's own panel showed are kept rather than dropped: they
 * are genuinely useful in a bug report, and the complaint about the default
 * panel was that it showed *only* them, under the framework's name.
 */
export const platformLine = (info: AppInfo): string => info.platform;

export const runtimeLine = (info: AppInfo): string =>
  `electron ${info.electron} · chromium ${info.chrome}`;

/** What the update row should say and do. */
export interface UpdateCopy {
  /** The button's text, or `null` when there is no button to show. */
  label: string | null;
  /** The line under it. Empty string means "say nothing". */
  note: string;
  /** Whether pressing the button does anything yet. */
  enabled: boolean;
}

/**
 * Turn an {@link UpdateStatus} into the panel's update row.
 *
 * Every branch here exists because collapsing it would make the window state
 * something untrue about itself:
 *
 * - **`checked: false`** is not "up to date". It is the thirty seconds of every
 *   launch before the first check completes, and rendering it as settled tells
 *   the user something the app has not established — a mistake this codebase
 *   already made once, in Settings, with a newer release published. So the
 *   button offers to *look*, rather than reporting a result.
 * - **`unsupported`** is not an error. A development run was never going to be
 *   able to check, and saying "error" about it sends someone hunting a fault
 *   that is not there. The row says so plainly and offers no button.
 * - **`manual` capability** cannot install anything, so the button must not say
 *   "Install". It sends the user to the release page, which is what will
 *   actually happen.
 */
export function updateCopy(status: UpdateStatus): UpdateCopy {
  const { state, checked, capability, availableVersion } = status;

  if (state === 'unsupported' || !capability.canCheck) {
    return { label: null, note: capability.reason, enabled: false };
  }

  switch (state) {
    case 'checking':
      return { label: 'Checking…', note: '', enabled: false };

    case 'available':
      return {
        label:
          capability.mode === 'self-install'
            ? `Update to ${availableVersion ?? 'the latest'}`
            : 'Get the update',
        note:
          capability.mode === 'self-install'
            ? ''
            : 'Opens the release page — this build installs updates by hand.',
        enabled: true,
      };

    case 'downloading':
      return {
        label: `Downloading… ${status.percent ?? 0}%`,
        note: '',
        enabled: false,
      };

    case 'ready':
      /**
       * A **statement, not a button** — because there is no verb behind it.
       *
       * It read `Restart to update` and offered to be pressed, but the only
       * thing this window can call is `updates.check()`, and a check in the
       * `ready` state short-circuits into an informational dialog and returns.
       * The preload exposes no install verb at all. Pressing it produced a
       * modal telling the user to restart and then did not restart — a button
       * naming an action it cannot perform.
       *
       * Settings already renders this same state as a sentence, for the same
       * reason. Saying so here and offering nothing to press is the honest
       * version, and it is what the user does next anyway.
       */
      return {
        label: null,
        note:
          availableVersion === null
            ? 'An update is ready — restart the Hive to install it.'
            : `Version ${availableVersion} is ready — restart the Hive to install it.`,
        enabled: false,
      };

    case 'error':
      return {
        label: 'Check again',
        note: status.error ?? 'The check did not complete.',
        enabled: true,
      };

    case 'idle':
    default:
      return checked
        ? { label: null, note: 'The Hive is up to date.', enabled: false }
        : { label: 'Check for updates', note: '', enabled: true };
  }
}

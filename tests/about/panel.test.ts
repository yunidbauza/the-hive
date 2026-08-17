import { describe, expect, it } from 'vitest';

import {
  WORDMARK_START,
  WORDMARK_STEP,
  platformLine,
  runtimeLine,
  scheduleWordmark,
  updateCopy,
  versionLine,
} from '@/about/panel';

import type { AppInfo } from '@shared/ipc-contract';
import type { UpdateCapability, UpdateStatus } from '@shared/update-contract';

/**
 * The About panel's decisions.
 *
 * Everything here is a pure function over a status or an `AppInfo`, which is
 * the whole reason `panel.ts` is split from `about.ts` — the entry point has to
 * import a `data:` URI of an mp4 and talk to a bridge that only exists inside
 * Electron, and neither is reachable from a unit test.
 *
 * The update copy gets the most attention because it is the one place this
 * window can state something untrue about the app.
 */

const capability = (over: Partial<UpdateCapability> = {}): UpdateCapability => ({
  canCheck: true,
  mode: 'self-install',
  reason: '',
  ...over,
});

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  state: 'idle',
  checked: false,
  currentVersion: '0.1.6',
  availableVersion: null,
  percent: null,
  capability: capability(),
  releaseUrl: 'https://example.invalid/releases',
  error: null,
  ...over,
});

const appInfo = (over: Partial<AppInfo> = {}): AppInfo =>
  ({
    version: '0.1.6',
    electron: '43.2.0',
    chrome: '130.0.6723.191',
    node: '20.18.1',
    platform: 'darwin',
    logPath: '/tmp/logs',
    ...over,
  }) as AppInfo;

describe('versionLine', () => {
  it('names the app version, not the framework’s', () => {
    // The entire complaint about the stock panel: it showed Electron's.
    expect(versionLine(appInfo())).toBe('Version 0.1.6');
  });
});

describe('the build lines', () => {
  it('keeps the runtime versions a bug report needs', () => {
    /**
     * Kept rather than dropped. The problem with Electron's panel was that it
     * showed *only* these, under the framework's name — not that these are
     * useless.
     */
    expect(platformLine(appInfo())).toBe('darwin');
    expect(runtimeLine(appInfo())).toBe('electron 43.2.0 · chromium 130.0.6723.191');
  });

  it('splits them so neither can wrap inside a version number', () => {
    /**
     * Not styling — a correctness rule with a screenshot behind it. As one
     * line this overflowed the 420px panel and wrapped *inside* the Chromium
     * version, and half a version pasted into a bug report is wrong rather
     * than merely untidy. The `nowrap` in `about.css` only holds while each
     * line is short enough to fit, which is what this pins.
     */
    const info = appInfo();
    expect(platformLine(info)).not.toContain('·');
    expect(runtimeLine(info)).not.toContain(info.platform);
    expect(runtimeLine(info).length).toBeLessThan(46);
  });
});

describe('updateCopy', () => {
  it('offers to look rather than claiming to be up to date before any check', () => {
    /**
     * The load-bearing branch. `checked: false` is the thirty seconds of every
     * launch before the first check completes, and `state` is `idle` for all of
     * it — so rendering that as "up to date" states something the app has not
     * established. This codebase already made that mistake once, in Settings,
     * with a newer release published.
     */
    const copy = updateCopy(status({ state: 'idle', checked: false }));

    expect(copy.label).toBe('Check for updates');
    expect(copy.note).toBe('');
    expect(copy.enabled).toBe(true);
  });

  it('says it is up to date only once a check has completed', () => {
    const copy = updateCopy(status({ state: 'idle', checked: true }));

    expect(copy.note).toBe('The Hive is up to date.');
    expect(copy.label).toBeNull();
  });

  it('names the version it would install', () => {
    const copy = updateCopy(status({ state: 'available', availableVersion: '0.1.7' }));

    expect(copy.label).toBe('Update to 0.1.7');
    expect(copy.enabled).toBe(true);
  });

  it('does not promise to install what it can only link to', () => {
    /**
     * A `manual` build cannot swap its own bundle. A button reading "Update
     * to 0.1.7" that opens a web page instead is a lie with a good excuse.
     */
    const copy = updateCopy(
      status({
        state: 'available',
        availableVersion: '0.1.7',
        capability: capability({ mode: 'manual' }),
      }),
    );

    expect(copy.label).toBe('Get the update');
    expect(copy.note).toContain('release page');
  });

  it('reports progress while downloading, and refuses a second press', () => {
    const copy = updateCopy(status({ state: 'downloading', percent: 42 }));

    expect(copy.label).toBe('Downloading… 42%');
    expect(copy.enabled).toBe(false);
  });

  it('states that a ready update needs a restart, rather than offering to do it', () => {
    /**
     * **A button here would name an action nothing can perform.**
     *
     * It read `Restart to update` and was pressable, but the only verb this
     * window has is `updates.check()` — and a check in the `ready` state
     * short-circuits into an informational dialog and returns. The preload
     * exposes no install verb at all, so the restart is unreachable from here:
     * pressing it produced a modal telling the user to restart, and then did
     * not restart.
     *
     * Settings renders this same state as a sentence for the same reason.
     */
    const copy = updateCopy(status({ state: 'ready', availableVersion: '0.1.7' }));

    expect(copy.label).toBeNull();
    expect(copy.enabled).toBe(false);
    expect(copy.note).toContain('0.1.7');
    expect(copy.note).toContain('restart');
  });

  it('still says so when the ready version is unknown', () => {
    // `availableVersion` is nullable on the contract; interpolating it raw
    // would print "Version null is ready".
    const copy = updateCopy(status({ state: 'ready' }));

    expect(copy.note).not.toContain('null');
    expect(copy.note).toContain('restart');
  });

  it('surfaces an error as one line, and offers a retry', () => {
    const copy = updateCopy(status({ state: 'error', error: 'the server said no' }));

    expect(copy.note).toBe('the server said no');
    expect(copy.label).toBe('Check again');
  });

  it('explains an unsupported build instead of calling it an error', () => {
    /**
     * A development run was never going to be able to check. Saying "error"
     * about it sends someone hunting a fault that is not there — which is why
     * the contract keeps `unsupported` and `error` apart in the first place.
     */
    const copy = updateCopy(
      status({
        state: 'unsupported',
        capability: capability({ canCheck: false, reason: 'Updates need a packaged build.' }),
      }),
    );

    expect(copy.label).toBeNull();
    expect(copy.note).toBe('Updates need a packaged build.');
    expect(copy.enabled).toBe(false);
  });

  it('offers no button whenever checking is impossible, whatever the state says', () => {
    // `canCheck: false` wins over an otherwise actionable state: there is no
    // path from here to an install, so there is nothing to press.
    const copy = updateCopy(
      status({
        state: 'available',
        availableVersion: '0.1.7',
        capability: capability({ canCheck: false, reason: 'Not packaged.' }),
      }),
    );

    expect(copy.label).toBeNull();
  });
});

describe('scheduleWordmark', () => {
  it('staggers the letters off one clock', () => {
    /**
     * In script rather than the stylesheet because the alternative is eight
     * `nth-child` rules carrying hand-written delays — and a letter added to
     * the markup would then animate at 0s and arrive before the ones before it.
     */
    const root = document.createElement('div');
    root.innerHTML =
      '<p class="wordmark"><span>T</span><span>H</span><span>E</span></p>';

    scheduleWordmark(root);

    const delays = [...root.querySelectorAll<HTMLElement>('.wordmark span')].map(
      (glyph) => glyph.style.animationDelay,
    );

    expect(delays).toEqual([
      `${WORDMARK_START}s`,
      `${WORDMARK_START + WORDMARK_STEP}s`,
      `${WORDMARK_START + WORDMARK_STEP * 2}s`,
    ]);
  });

  it('does nothing to a document with no wordmark', () => {
    expect(() => scheduleWordmark(document.createElement('div'))).not.toThrow();
  });
});

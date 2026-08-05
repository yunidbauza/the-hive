import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMacPlatform } from '@lib/platform';

/**
 * Moved here from `tests/lib/terminal/keymap.test.ts` when `isMacPlatform` left
 * the keymap: `tests/` mirrors `src/`, so the test follows the module.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isMacPlatform', () => {
  it('prefers userAgentData when the runtime provides it', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' } });
    expect(isMacPlatform()).toBe(true);

    vi.stubGlobal('navigator', { userAgentData: { platform: 'Windows' } });
    expect(isMacPlatform()).toBe(false);
  });

  it('falls back to platform for runtimes without it', () => {
    // Deprecated and still universally implemented — `userAgentData` is
    // Chromium-only, which is fine for Electron and not for the demo surface.
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' });
    expect(isMacPlatform()).toBe(true);

    vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: '' });
    expect(isMacPlatform()).toBe(false);
  });

  it('falls back again to the user agent when platform is empty', () => {
    vi.stubGlobal('navigator', { platform: '', userAgent: 'Mozilla (Macintosh)' });
    expect(isMacPlatform()).toBe(true);
  });

  it('answers false where there is no navigator at all', () => {
    vi.stubGlobal('navigator', undefined);
    expect(isMacPlatform()).toBe(false);
  });
});

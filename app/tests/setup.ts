import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * happy-dom does not implement ResizeObserver, which the terminal surface uses
 * to refit xterm when its container changes size. Stub it so components can
 * mount; observed-size behaviour is asserted in Playwright (story 070).
 */
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as unknown as typeof globalThis.ResizeObserver;
}

/**
 * Unmount anything a test rendered. Without this, `screen` queries in a later
 * test can match a previous test's DOM and pass for the wrong reason.
 */
afterEach(() => {
  cleanup();
});

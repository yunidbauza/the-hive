import { vi } from 'vitest';

/**
 * Recording fake for xterm's `FitAddon`.
 *
 * The real addon measures rendered character cells, which happy-dom cannot do.
 * Tests assert that `fit()` was called — that resize plumbing is wired — and
 * leave the actual geometry to Playwright (story 070).
 */

export const fitAddonInstances: MockFitAddon[] = [];

export class MockFitAddon {
  readonly fit = vi.fn();
  readonly dispose = vi.fn();
  readonly activate = vi.fn();
  readonly proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));

  constructor() {
    fitAddonInstances.push(this);
  }
}

/** Drop every recorded instance. Call between tests. */
export function resetFitAddonInstances() {
  fitAddonInstances.length = 0;
}

export { MockFitAddon as FitAddon };

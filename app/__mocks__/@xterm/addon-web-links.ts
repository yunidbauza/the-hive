import { vi } from 'vitest';

/**
 * Recording fake for xterm's `WebLinksAddon`.
 *
 * The real addon scans rendered rows for URLs and attaches click handlers —
 * both of which need a laid-out terminal that happy-dom cannot produce. Unit
 * tests assert only that the addon is loaded; that links are actually clickable
 * is a Playwright concern (story 070).
 */

export const webLinksAddonInstances: MockWebLinksAddon[] = [];

export class MockWebLinksAddon {
  readonly dispose = vi.fn();
  readonly activate = vi.fn();

  constructor() {
    webLinksAddonInstances.push(this);
  }
}

/** Drop every recorded instance. Call between tests. */
export function resetWebLinksAddonInstances() {
  webLinksAddonInstances.length = 0;
}

export { MockWebLinksAddon as WebLinksAddon };

import { vi } from 'vitest';

/**
 * Recording fake for xterm's `WebLinksAddon`.
 *
 * The real addon scans rendered rows for URLs and attaches click handlers —
 * both of which need a laid-out terminal that happy-dom cannot produce. Unit
 * tests assert only that the addon is loaded and **what handler it was given**;
 * that links are actually clickable is a Playwright concern (story 070).
 *
 * The constructor argument is recorded rather than ignored because it is the
 * whole subject of the link fix: the addon's *default* handler calls
 * `window.open()` with no URL, which this app denies. "An addon was loaded" and
 * "an addon that can open a link was loaded" are different claims, and only the
 * second one is worth a test.
 */

export type WebLinkHandler = (event: MouseEvent, uri: string) => void;

export const webLinksAddonInstances: MockWebLinksAddon[] = [];

export class MockWebLinksAddon {
  readonly dispose = vi.fn();
  readonly activate = vi.fn();
  /** The handler the surface passed, or `undefined` for the broken default. */
  readonly handler: WebLinkHandler | undefined;

  constructor(handler?: WebLinkHandler) {
    this.handler = handler;
    webLinksAddonInstances.push(this);
  }
}

/** Drop every recorded instance. Call between tests. */
export function resetWebLinksAddonInstances() {
  webLinksAddonInstances.length = 0;
}

export { MockWebLinksAddon as WebLinksAddon };

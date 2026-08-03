import { createStaticTransport } from '@lib/terminal/static-transport';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';

/**
 * The desktop transport — a placeholder until story 094 (story 083).
 *
 * It exists as its own module, rather than as an inline branch in
 * `resolve-transport.ts`, for two reasons:
 *
 * - **The routing is testable now.** `resolveTransport` genuinely calls a
 *   different function on desktop, so a test can mock this module and assert
 *   the branch. An inline `isDesktop() ? a(id) : a(id)` would be dead code
 *   wearing a decision's clothes.
 * - **Story 094 has exactly one file to write.** The seam is already the shape
 *   it will need; only the body here changes, and nothing that calls it moves.
 *
 * Until then this returns the recorded transport, so the desktop build shows
 * the same transcripts the browser build does. That is not a degradation —
 * there are no PTYs yet in either target.
 */
export function createPtyTransport(entityId: string): TerminalTransport {
  return createStaticTransport(entityId);
}

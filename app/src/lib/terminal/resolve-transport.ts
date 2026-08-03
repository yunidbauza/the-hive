import { isDesktop } from '@config/runtime';
import { createPtyTransport } from '@lib/terminal/pty-transport';
import {
  ORCHESTRATOR_ID,
  createStaticTransport,
} from '@lib/terminal/static-transport';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';

/**
 * Which transport backs a given surface (story 083).
 *
 * **The branch lives here and nowhere else.** `center-stage.tsx` swaps
 * `createStaticTransport(id)` for this call and is otherwise untouched; its
 * transport cache, its identity discipline and its `readOnly` handling all
 * stand. `src/components/terminal/` does not learn that any of this happened —
 * that is the seam doing its job, and this function is the check it exists for.
 */
export function resolveTransport(entityId: string): TerminalTransport {
  /**
   * The orchestrator console is **always static**, in both targets.
   *
   * It is a command surface, not a shell (story 041): its verbs drive real
   * PTYs (story 097) but it does not own one. Without this branch, giving the
   * desktop build real terminals would silently turn the console into a shell —
   * the regression this line and its test exist to prevent.
   */
  if (entityId === ORCHESTRATOR_ID) return createStaticTransport(entityId);

  return isDesktop() ? createPtyTransport(entityId) : createStaticTransport(entityId);
}

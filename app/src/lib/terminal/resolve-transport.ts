import { isSession, type Session } from '@/types/entity';

import { isDesktop } from '@config/runtime';
import { createPtyTransport } from '@lib/terminal/pty-transport';
import {
  ORCHESTRATOR_ID,
  createStaticTransport,
} from '@lib/terminal/static-transport';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';
import { useHiveStore } from '@stores/hive-store';

/**
 * Which transport backs a given surface (story 083).
 *
 * **The branch lives here and nowhere else.** `center-stage.tsx` swaps
 * `createStaticTransport(id)` for this call and is otherwise untouched; its
 * transport cache, its identity discipline and its `readOnly` handling all
 * stand. `src/components/terminal/` does not learn that any of this happened —
 * that is the seam doing its job, and this function is the check it exists for.
 */
/**
 * The session behind a live terminal, or `null` if this surface is a recording.
 *
 * One predicate, three consumers: the transport factory below, the `readOnly`
 * decision in `center-stage.tsx`, and the key-hint row. Splitting them would let
 * a surface become typable while its transport stayed a recording — a cursor
 * that blinks over a transcript and swallows every keystroke.
 */
function liveSession(entityId: string): Session | null {
  /**
   * The orchestrator console is **always static**, in both targets.
   *
   * It is a command surface, not a shell (story 041): its verbs drive real
   * PTYs (story 097) but it does not own one. Without this branch, giving the
   * desktop build real terminals would silently turn the console into a shell —
   * the regression this line and its test exist to prevent.
   */
  if (entityId === ORCHESTRATOR_ID) return null;
  if (!isDesktop()) return null;

  /**
   * The project id is read here, and **not** inside `PtyTransport`.
   *
   * A PTY needs a `cwd`, so something has to turn an entity into a project.
   * This module is already the store-aware half of the seam — its sibling
   * `StaticTransport` reads the store outright — and keeping the lookup here is
   * what lets `pty-transport.ts` take ids as arguments and touch nothing else.
   * The lint zone permits a store import in either file; only one of them
   * should use it, and this is the one.
   *
   * `getState()` rather than a hook: this is not a render path, and a
   * subscription here would rebuild transports on unrelated store writes.
   */
  const entity = useHiveStore.getState().entities[entityId];

  /**
   * Agents keep their recorded transcripts this epic (story 096's scope note).
   *
   * They are long-lived background workers, not `claude` in a repository — they
   * have no project and no branch, so there is no directory to spawn one in.
   * Falling through to a PTY would spawn a shell in whatever the last resolved
   * path happened to be, which is worse than the recording.
   */
  if (!entity || !isSession(entity)) return null;
  return entity;
}

/**
 * Is this surface a live shell the user can type into?
 *
 * The one question `readOnly` is really asking. Story 095's table phrases it per
 * surface — console always read-only, browser always read-only, desktop session
 * writable — and every row of that table is this predicate.
 */
export const isLiveTerminal = (entityId: string): boolean =>
  liveSession(entityId) !== null;

export function resolveTransport(entityId: string): TerminalTransport {
  const session = liveSession(entityId);
  if (!session) return createStaticTransport(entityId);
  return createPtyTransport(entityId, session.project);
}

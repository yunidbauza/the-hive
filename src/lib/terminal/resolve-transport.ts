import { isSession, terminalOf, type Session } from '@/types/entity';

import { isDesktop } from '@config/runtime';
import { createPtyTransport } from '@lib/terminal/pty-transport';
import {
  ORCHESTRATOR_ID,
  createStaticTransport,
} from '@lib/terminal/static-transport';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';
import { currentTheme } from '@stores/appearance-store';
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

  /**
   * A **cleared** session is not live — its pty belongs to the successor.
   *
   * Returning a live transport here would attach the retired row to the
   * terminal that replaced it, so the user would watch new work appear under a
   * finished session's name and be able to type into it.
   *
   * `terminated` is deliberately **not** included, though it is equally ended.
   * That case is carried by `center-stage.tsx`'s `endedId` and the surface's
   * `ended` prop (story 108), which disable stdin *in place*. Flipping
   * `readOnly` instead would rebuild the xterm instance and wipe the transcript
   * of the session that just died — the one thing the user still wants to read.
   * A cleared session has no such transcript to protect: its row is inert and
   * never shown.
   */
  if (entity.status === 'done') return null;

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
  /**
   * The model and effort travel with the project, for the same reason and by
   * the same route (story 109).
   *
   * This is the lazy spawn path — a session whose surface mounts before anyone
   * asked for a process, which is every session the picker did not create. The
   * entity is where the choice was recorded, this module is the only half of
   * the seam allowed to read it, and passing it as arguments is what lets
   * `pty-transport.ts` go on knowing nothing about a store.
   *
   * Spread rather than assigning `undefined`, so a session with no recorded
   * model sends no key and gets the bare command.
   */
  /**
   * Keyed on the **terminal**, not the row.
   *
   * For every session that has never been cleared these are the same string, so
   * nothing changes. For a successor minted by `/clear` they differ, and the
   * difference is the whole feature: the successor has to attach to the pty
   * that is already running rather than spawn a second one in the same
   * directory. `pty-transport.ts` caches channels by this id and main's
   * registry keys its sessions by it, so passing the row id would be asking for
   * a new process by definition.
   */
  return createPtyTransport(terminalOf(session), session.project, {
    ...(session.model === undefined ? {} : { model: session.model }),
    ...(session.effort === undefined ? {} : { effort: session.effort }),
    /**
     * Read from the app rather than the entity, unlike the two above.
     *
     * The model is a property of the *session* and is recorded on the row; the
     * theme is a property of how the app looks right now, and there is nothing
     * on the row to read. This path is reachable after a restart —
     * `reopenChannel` clears the transport's `spawnRequested` latch, so the
     * next surface remount spawns through here — and without this that spawn
     * would silently fall back to dark inside a light app.
     */
    theme: currentTheme(),
  });
}

import {
  isSession,
  isTerminal,
  terminalOf,
  type Session,
  type Terminal,
} from '@/types/entity';

import { isDesktop } from '@config/runtime';
import {
  createPtyTransport,
  createTerminalTransport,
} from '@lib/terminal/pty-transport';
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
 * The entity behind a live pty, or `null` if this surface is a recording.
 *
 * One predicate, three consumers: the transport factory below, the `readOnly`
 * decision in `center-stage.tsx`, and the key-hint row. Splitting them would let
 * a surface become typable while its transport stayed a recording — a cursor
 * that blinks over a transcript and swallows every keystroke.
 *
 * **A terminal is live for as long as it exists** (terminals). It has no ending
 * that retires its transcript the way `/clear` retires a session's: a shell the
 * user exits is removed outright, and a shell that died unasked keeps its row so
 * the transcript that led there can be read. The surface says so through `ended`
 * rather than `readOnly` — flipping `readOnly` rebuilds the xterm instance, which
 * would wipe the very output the user opened the tab to read.
 */
function liveEntity(entityId: string): Session | Terminal | null {
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

  if (!entity) return null;

  /**
   * A terminal is live and answers no further questions (terminals).
   *
   * It returns *before* the session guards below on purpose: none of them apply.
   * There is no `endedBy`, because a shell is either running or removed, and no
   * `terminalId` indirection, because nothing retires a terminal's row onto a
   * successor's pty.
   */
  if (isTerminal(entity)) return entity;

  /**
   * An agent never reaches this function at all any more (HIVE-116).
   *
   * It used to, and this branch is what kept it honest: an agent is a
   * long-lived background worker rather than `claude` in a repository, with no
   * project and no branch, so falling through to a PTY would have spawned a
   * shell in whatever path resolved last. It got a recording instead.
   *
   * Agents now have a view of their own and are not in `center-stage`'s
   * terminal list, so nothing asks for a transport for one. The guard stays,
   * because this module's contract is "a transport for any id" and a defence
   * removed the moment its caller went away is a defence that has to be
   * rediscovered when the next one arrives.
   */
  if (!isSession(entity)) return null;

  /**
   * A **cleared** session is not live — its pty belongs to the successor.
   *
   * Returning a live transport here would attach the retired row to the
   * terminal that replaced it, so the user would watch new work appear under a
   * finished session's name and be able to type into it.
   *
   * Every other ending is deliberately **not** included, though all of them are
   * equally over. Those are carried by `center-stage.tsx`'s `endedId` and the
   * surface's `ended` prop (story 108), which disable stdin *in place*. Flipping
   * `readOnly` instead would rebuild the xterm instance and wipe the transcript
   * of the session that just died — the one thing the user still wants to read.
   * A cleared session has no such transcript to protect: its row is inert and
   * never shown.
   *
   * **Keyed on `endedBy`, not on the status** (HIVE-93). It was `status ===
   * 'done'` while `/clear` was the only thing that produced `done`. `/done` now
   * produces one too, and its transcript is exactly the kind this guard exists
   * to protect — the user is very likely still reading it, because they were
   * watching the session when it finished.
   */
  if (entity.status === 'done' && entity.endedBy === 'cleared') return null;

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
  liveEntity(entityId) !== null;

export function resolveTransport(entityId: string): TerminalTransport {
  const entity = liveEntity(entityId);
  if (!entity) return createStaticTransport(entityId);

  /**
   * A terminal's own factory, and the difference is the whole feature
   * (terminals): the same pty machinery behind a spawn that types no `claude`
   * into the shell. Its project travels as an argument for the reason every
   * other id here does — `pty-transport.ts` reads no store.
   */
  if (isTerminal(entity)) {
    // An empty `cwd` is a terminal created with no config snapshot to name
    // one; it must not reach main as a path.
    return createTerminalTransport(
      entity.id,
      entity.project,
      entity.cwd === '' ? undefined : entity.cwd,
    );
  }

  /**
   * Narrowed to a {@link Session} by the branch above, which is why the rest of
   * this function reads unchanged.
   */
  const session = entity;

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
     * A conversation being picked up rather than begun (HIVE-88, HIVE-93).
     *
     * Two signals, because there are two ways to arrive here with a transcript
     * worth continuing. `restored` is a row the app outlived, still set at this
     * moment — `reviveIfLive` clears it only once the new process reports a live
     * status. `resumable` is a row that ended *within* this run, which `/done`
     * produces: it never left, so it was never restored.
     *
     * Read here, not in `pty-transport.ts`, for the reason the model is: this is
     * the store-aware half of the seam. Main still has the last word — it
     * honours `resume` only where its session history can actually name the
     * conversation, so a row wrongly marked here spawns fresh rather than failing.
     */
    ...(session.restored === true || session.resumable === true
      ? { resume: true }
      : {}),
  });
}

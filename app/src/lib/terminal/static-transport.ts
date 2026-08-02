import type { TermLine } from '@/types/terminal';

import { colorize } from '@lib/terminal/ansi';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';
import { useHiveStore } from '@stores/hive-store';

/**
 * The prototype's transport: replays an entity's stored transcript as ANSI.
 *
 * This is the half of the seam that is allowed to know about the store — and
 * it lives in `lib/` rather than `components/terminal/` precisely so the
 * component cannot reach it sideways. The import zone in `eslint.config.mjs`
 * makes that a build failure rather than a review note.
 *
 * When the PTY daemon lands this module is what gets replaced, not the
 * surface.
 */

/** The orchestrator console's pseudo-entity id (story 041). */
export const ORCHESTRATOR_ID = 'orch';

type HiveState = ReturnType<typeof useHiveStore.getState>;

/** Clear screen + home cursor — used only on a store reset. */
const CLEAR = '\u001b[2J\u001b[H';

const NO_LINES: TermLine[] = [];

/**
 * The orchestrator's transcript lives in its own field rather than in
 * `entities`, because it is the console's output and not a session's. Both
 * read the same way from here, which is what lets story 041 mount an ordinary
 * `TerminalSurface` for the console.
 */
function selectLines(state: HiveState, id: string): TermLine[] {
  if (id === ORCHESTRATOR_ID) return state.orchLines;
  return state.entities[id]?.lines ?? NO_LINES;
}

/** One transcript line as an ANSI-coloured, newline-terminated chunk. */
function render(lines: TermLine[]): string {
  return lines.map((line) => `${colorize(line.text, line.color)}\n`).join('');
}

export function createStaticTransport(entityId: string): TerminalTransport {
  return {
    /**
     * No-ops, both of them. The prototype's input is a separate DOM row
     * (story 043) and there is no backend to inform of a resize — but the
     * methods exist because the *interface* is the contract, and a
     * `PtyTransport` will implement all three for real.
     */
    write: () => {},
    resize: () => {},

    onData(cb) {
      /**
       * Per-subscription, not per-transport: two surfaces bound to the same
       * entity must each receive the full replay, and a shared counter would
       * let the first subscriber starve the second.
       */
      let emitted = 0;

      const initial = selectLines(useHiveStore.getState(), entityId);
      emitted = initial.length;
      if (initial.length > 0) cb(render(initial));

      return useHiveStore.subscribe((state) => {
        const lines = selectLines(state, entityId);

        if (lines.length > emitted) {
          // The common case: `appendEntityLines` added output. Emit only what
          // is new, so the terminal never re-renders scrollback it already has.
          const fresh = lines.slice(emitted);
          emitted = lines.length;
          cb(render(fresh));
          return;
        }

        if (lines.length < emitted) {
          /**
           * The transcript shrank, which only `reset()` does. Emitting a diff
           * is meaningless here, so wipe and replay — otherwise the surface
           * keeps stale lines from the previous fixture set forever.
           */
          emitted = lines.length;
          cb(CLEAR + render(lines));
        }
      });
    },
  };
}

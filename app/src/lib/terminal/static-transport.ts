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
       * Progress is tracked by the identity of the last line emitted, not by a
       * count.
       *
       * A counter is the obvious implementation and it is wrong for any
       * transcript with a cap. The orchestrator console is capped (story 041):
       * once it is full, every push drops the oldest line and appends a new
       * one, so the array *length never changes again*. A length diff sees no
       * change, emits nothing, and the console freezes on screen while the
       * store keeps updating perfectly — a silent failure with no error to
       * follow.
       *
       * Line objects are created fresh on every push and never reused, so
       * `indexOf` is an exact "where did I get to" probe that survives the
       * window sliding underneath it.
       *
       * Per-subscription, not per-transport: two surfaces bound to the same
       * entity must each receive the full replay, and shared progress would let
       * the first subscriber starve the second.
       */
      let last: TermLine | undefined;

      const initial = selectLines(useHiveStore.getState(), entityId);
      last = initial.at(-1);
      if (initial.length > 0) cb(render(initial));

      return useHiveStore.subscribe((state) => {
        const lines = selectLines(state, entityId);
        if (lines.at(-1) === last) return;

        const seen = last === undefined ? -1 : lines.indexOf(last);

        if (seen === -1) {
          /**
           * The last line emitted is gone from the transcript entirely. Either
           * `reset()` replaced it, or so much arrived at once that the cap slid
           * past everything this subscriber had seen. A diff is meaningless
           * either way, so wipe and replay.
           *
           * Nothing to wipe if nothing was ever emitted — an entity that starts
           * empty gets its first lines written plainly, not preceded by a
           * pointless clear-screen.
           */
          const wipe = last === undefined ? '' : CLEAR;
          last = lines.at(-1);
          cb(wipe + render(lines));
          return;
        }

        // The common case: emit only what is new, so the terminal never
        // re-renders scrollback it already has.
        const fresh = lines.slice(seen + 1);
        last = lines.at(-1);
        cb(render(fresh));
      });
    },
  };
}

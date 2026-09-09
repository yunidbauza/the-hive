import { useEffect, useRef } from 'react';

import { isMacPlatform } from '@lib/platform';
import {
  isRailChord,
  isTerminalHereChord,
  TERMINAL_CHORD_EVENT,
  type KeyEventLike,
  type TerminalChordDetail,
} from '@lib/terminal/keymap';
import { useToggleRailCollapsed } from '@stores/appearance-store';
import { useSpawnTerminalBeside } from '@stores/hive-store';
import { useActiveTab } from '@stores/ui-store';

/**
 * One chord, both ways it can arrive.
 *
 * `matches` sees a window keydown. `name` is what the same chord is called when
 * a focused terminal forwarded it instead — xterm consumes keys before `window`
 * sees them, so a chord pressed in a terminal arrives as a
 * {@link TERMINAL_CHORD_EVENT} the surface dispatched on the way past.
 */
interface AppChord {
  matches: (event: KeyEventLike, isMac: boolean) => boolean;
  name: TerminalChordDetail['chord'];
  run: () => void;
}

/**
 * The app's global chords, from wherever focus happens to be.
 *
 * This was `useRailChord`, one chord pair with two entry points, and its own
 * docblock said a third chord is when a table earns itself. The terminal-here
 * chord is the third. What the table shares is the two listeners and the
 * de-duplication between them; what it does not become is a binding registry —
 * `header.tsx` still defers `Cmd+,` to story 060, and nothing here is
 * rebindable.
 */
export function useAppChords(): void {
  const toggleRailCollapsed = useToggleRailCollapsed();
  const spawnTerminalBeside = useSpawnTerminalBeside();
  const activeTab = useActiveTab();
  /*
    A ref rather than a dependency: the listeners are installed once, and a
    tab switch must not tear them down and put them back for a value the
    action only needs at keystroke time.
  */
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    const isMac = isMacPlatform();

    const chords: AppChord[] = [
      {
        matches: (event, mac) => isRailChord(event, mac) === 'left',
        name: 'rail-left',
        run: () => toggleRailCollapsed('left'),
      },
      {
        matches: (event, mac) => isRailChord(event, mac) === 'right',
        name: 'rail-right',
        run: () => toggleRailCollapsed('right'),
      },
      {
        matches: (event) => isTerminalHereChord(event),
        name: 'terminal-here',
        run: () => {
          // Nothing on the console tab: there is no entity to stand beside.
          const tab = activeTabRef.current;
          if (tab === 'orch') return;
          spawnTerminalBeside(tab);
        },
      },
    ];

    const onKeyDown = (event: KeyboardEvent) => {
      /*
        A terminal already dispatched a chord event for this keystroke.
        Handling both would run the action twice — for a toggle, that lands
        back where it started, which is the hardest kind of shortcut to
        diagnose; for a spawn, it opens two shells.
      */
      if (event.target instanceof Element && event.target.closest('[data-terminal-id]')) return;

      const chord = chords.find((candidate) => candidate.matches(event, isMac));
      if (!chord) return;
      event.preventDefault();
      chord.run();
    };

    const onChord = (event: Event) => {
      const { detail } = event as CustomEvent<TerminalChordDetail>;
      chords.find((candidate) => candidate.name === detail?.chord)?.run();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(TERMINAL_CHORD_EVENT, onChord);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(TERMINAL_CHORD_EVENT, onChord);
    };
  }, [toggleRailCollapsed, spawnTerminalBeside]);
}

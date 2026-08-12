import { useEffect, useState } from 'react';

import { TerminalSurface } from '@components/terminal/terminal-surface';
import type { TerminalTheme } from '@lib/terminal/ansi';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';

export interface TerminalHostEntry {
  /** Entity id, or `'orch'` for the console. Opaque to this component. */
  id: string;
  /**
   * Which terminal this entry runs in. Equal to {@link TerminalHostEntry.id}
   * unless a `/clear` retired one row and opened another on the same pty.
   *
   * The React key, and therefore what decides whether an xterm instance is
   * reused or rebuilt. Two entries may share one: a cleared session and the
   * successor that replaced it both name the terminal that is still running.
   */
  terminalKey: string;
  transport: TerminalTransport;
  readOnly?: boolean;
}

interface TerminalHostProps {
  entries: TerminalHostEntry[];
  /** Which entry is on screen. `null` shows nothing. */
  activeId: string | null;
  /**
   * The entry whose process has ended, if any (story 108).
   *
   * One id rather than a flag per entry, because the caller knows the status of
   * the entity it is *showing* and would have to subscribe to all thirteen to
   * fill in the rest — which is exactly the whole-shell re-render the store
   * split exists to prevent. Nothing is lost: `ended` only changes how keys and
   * stdin are handled, and only the visible surface has focus.
   */
  endedId?: string | null;
  theme: TerminalTheme;
  /** Appearance, already resolved (story 105). Forwarded verbatim. */
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
}

/**
 * One xterm instance per entity, kept alive and hidden — never one shared
 * instance re-fed on every tab switch.
 *
 * The re-fed alternative is cheaper in memory and wrong in every way that
 * matters: it loses scrollback position and selection on each switch, so
 * returning to a session drops the user at the bottom of a transcript they
 * were reading the middle of. Real multiplexers keep the buffer; so does this.
 * Thirteen entities at 5k scrollback is nothing.
 *
 * Instances mount lazily on first visit, so opening the app does not construct
 * a terminal for every session in the fixture set.
 */
export function TerminalHost({
  entries,
  activeId,
  endedId = null,
  theme,
  fontFamily,
  fontSize,
  scrollback,
}: TerminalHostProps) {
  const [visited, setVisited] = useState<string[]>([]);

  useEffect(() => {
    if (!activeId) return;
    setVisited((current) =>
      current.includes(activeId) ? current : [...current, activeId],
    );
  }, [activeId]);

  /**
   * Ordered by first visit rather than by `entries`, so a re-ordered session
   * list cannot reorder live DOM nodes and force xterm to re-measure.
   * Filtered against `entries` so a removed entity's instance is torn down.
   */
  /**
   * Visit order, collapsed to **terminals**.
   *
   * A `/clear` leaves two rows naming one pty — the session that finished and
   * the one that replaced it — and mounting both would hand React duplicate
   * keys and xterm two instances fighting over one channel.
   */
  const visitedTerminals: string[] = [];
  for (const id of visited) {
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry && !visitedTerminals.includes(entry.terminalKey)) {
      visitedTerminals.push(entry.terminalKey);
    }
  }

  /**
   * For each terminal, the row that can still be typed into.
   *
   * Chosen from **all** entries rather than only the visited ones, and that is
   * the load-bearing part. `visited` grows in an effect, so the render right
   * after a `/clear` sees the retired row already read-only while its successor
   * has not been recorded as visited yet. Picking from visited alone would mount
   * the retired row for exactly one frame — and since `readOnly` is structural
   * to xterm (it cannot change `disableStdin` after construction), that frame
   * costs two rebuilds and throws the user's scrollback away twice on the way
   * through.
   *
   * Sharing the key across the swap is what makes the handover seamless at all:
   * keyed by row id, the successor would be a different element and xterm would
   * tear down and replay the transcript at the instant the user typed `/clear`.
   */
  const mounted = visitedTerminals.flatMap((key) => {
    const sharing = entries.filter((candidate) => candidate.terminalKey === key);
    const live = sharing.find((candidate) => candidate.readOnly !== true);
    const chosen = live ?? sharing[0];
    return chosen ? [chosen] : [];
  });

  return (
    <>
      {mounted.map((entry) => (
        <TerminalSurface
          key={entry.terminalKey}
          id={entry.id}
          transport={entry.transport}
          theme={theme}
          fontFamily={fontFamily}
          fontSize={fontSize}
          scrollback={scrollback}
          readOnly={entry.readOnly}
          visible={entry.id === activeId}
          ended={entry.id === endedId}
        />
      ))}
    </>
  );
}

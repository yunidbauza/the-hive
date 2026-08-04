import { useEffect, useState } from 'react';

import { TerminalSurface } from '@components/terminal/terminal-surface';
import type { TerminalTheme } from '@lib/terminal/ansi';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';

export interface TerminalHostEntry {
  /** Entity id, or `'orch'` for the console. Opaque to this component. */
  id: string;
  transport: TerminalTransport;
  readOnly?: boolean;
}

interface TerminalHostProps {
  entries: TerminalHostEntry[];
  /** Which entry is on screen. `null` shows nothing. */
  activeId: string | null;
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
  const mounted = visited.flatMap((id) => {
    const entry = entries.find((candidate) => candidate.id === id);
    return entry ? [entry] : [];
  });

  return (
    <>
      {mounted.map((entry) => (
        <TerminalSurface
          key={entry.id}
          id={entry.id}
          transport={entry.transport}
          theme={theme}
          fontFamily={fontFamily}
          fontSize={fontSize}
          scrollback={scrollback}
          readOnly={entry.readOnly}
          visible={entry.id === activeId}
        />
      ))}
    </>
  );
}

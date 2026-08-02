import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useState } from 'react';

import '@xterm/xterm/css/xterm.css';

/**
 * Minimal xterm.js mount — the scaffold's proof that the terminal stack loads
 * and renders (story 010's definition of done).
 *
 * Story 042 replaces this with the real surface: it will take a
 * `TerminalTransport` and nothing else, and will keep instances alive across
 * tab switches. The invariant that starts here and is lint-enforced by story
 * 014: nothing under `src/components/terminal/` may import from `features/`,
 * `data/`, or `stores/`. The terminal knows only its transport.
 */
export function TerminalSurface() {
  /**
   * The container is held in state behind a callback ref rather than in a
   * `useRef`. A ref's `.current` is populated by the time the mount effect
   * runs, which makes a null-check on it dead code that can never be exercised
   * — an untestable branch that quietly erodes the coverage gate. With a
   * callback ref the null case is a genuine state React passes through on the
   * first render, so the guard below is real and covered.
   */
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!container) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, Menlo, 'SF Mono', monospace",
      fontSize: 12,
      theme: { background: '#0b1023', foreground: '#dbe4ff' },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
    };
  }, [container]);

  return <div ref={setContainer} className="h-full w-full bg-term-bg" />;
}

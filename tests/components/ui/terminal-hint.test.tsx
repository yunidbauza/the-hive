import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TerminalHint } from '@components/ui/terminal-hint';

describe('TerminalHint', () => {
  it('names what happened before it names the remedy', () => {
    /**
     * The order is the design (HIVE-79). A user who has just watched `←` do
     * something they did not ask for needs the cause first; a bare chord with
     * no explanation is a hint about the app rather than an answer about the
     * thing that just happened.
     */
    render(
      <TerminalHint
        said="← went to the session"
        chord="⌘["
        does="returns to the overmind"
      />,
    );

    const strip = screen.getByTestId('terminal-hint');
    expect(strip.textContent).toBe('← went to the session⌘[returns to the overmind');
  });

  it('draws the chord as a key, not as prose', () => {
    render(<TerminalHint said="x" chord="Ctrl+Shift+←" does="y" />);
    expect(screen.getByText('Ctrl+Shift+←').tagName).toBe('KBD');
  });

  it('announces itself politely', () => {
    /**
     * The whole defect is a thing that happened silently. A screen-reader user
     * is the one this strip cannot afford to miss — and `polite` rather than
     * `assertive` because it is news, not an alarm.
     */
    render(<TerminalHint said="x" chord="⌘[" does="y" />);
    const strip = screen.getByRole('status');
    expect(strip).toHaveAttribute('aria-live', 'polite');
  });

  it('does not eat clicks meant for the terminal underneath it', () => {
    // It is drawn *over* a live surface. Anything else would make the strip a
    // four-second dead zone across the foot of a terminal the user is using.
    render(<TerminalHint said="x" chord="⌘[" does="y" />);
    expect(screen.getByTestId('terminal-hint').className).toContain(
      'pointer-events-none',
    );
  });

  it('takes a caller’s placement without losing its own styling', () => {
    render(
      <TerminalHint said="x" chord="⌘[" does="y" className="absolute bottom-0" />,
    );
    const strip = screen.getByTestId('terminal-hint');
    expect(strip.className).toContain('absolute');
    expect(strip.className).toContain('font-mono');
  });
});

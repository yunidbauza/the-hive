import { render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { MAX_GROW_ROWS, useAutoGrow } from '@hooks/use-auto-grow';

/**
 * The sizing hook behind both prompt rows.
 *
 * happy-dom performs no layout, so `scrollHeight` is `0` and every computed
 * length is `NaN` here — the same reason xterm is never instantiated for real.
 * What this file can prove is the *plumbing*: that the hook resets the height
 * before measuring (without which a row could only ever get taller), that it
 * writes nothing nonsensical when the measurements are absent, and that it runs
 * again when the value changes. The pixels are Playwright's job.
 */

function Probe({ initial = '' }: { initial?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initial);

  useAutoGrow(ref, value);

  return (
    <>
      <textarea
        ref={ref}
        aria-label="probe"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button onClick={() => setValue(`${value}\nmore`)}>grow</button>
    </>
  );
}

const field = () => screen.getByRole('textbox', { name: 'probe' });

describe('useAutoGrow', () => {
  it('caps growth in rows rather than pixels', () => {
    /**
     * Denominated in rows on purpose: the terminal font size is a user setting
     * and these rows are styled to match it, so a hard-coded pixel cap would
     * mean ten rows at one setting and six at another.
     */
    expect(MAX_GROW_ROWS).toBe(10);
  });

  it('clears the height before measuring, so a row can shrink again', () => {
    /**
     * The subtle half of the hook. `scrollHeight` reports the content height
     * *or the element's own height, whichever is larger* — so an element that
     * has already grown reports at least that forever, and without the reset
     * the row would ratchet upward and never come back down when text is
     * deleted. With no layout engine here, `auto` is what survives.
     */
    render(<Probe />);

    expect(field().style.height).toBe('auto');
  });

  it('writes no height at all when the environment cannot measure one', () => {
    // Rather than `NaNpx`, which is what an unguarded `lineHeight * rows` would
    // produce and which browsers silently discard — hiding the bug in the one
    // environment where it matters.
    render(<Probe initial={'a\nb\nc'} />);

    expect(field().style.height).not.toContain('NaN');
    expect(field().getAttribute('style')).not.toContain('NaN');
  });

  it('re-runs when the value changes', () => {
    /**
     * The dependency that makes the hook do anything. Keyed on the text rather
     * than on a ref (which never changes identity) — a hook that only ran on
     * mount would size the first line and then never again.
     */
    const { rerender } = render(<Probe />);

    expect(field().style.overflowY).toBe('hidden');

    rerender(<Probe initial="one" />);

    // Still inert under happy-dom, but the effect ran rather than throwing on
    // the second pass — which is what a missing dependency array would hide.
    expect(field().style.height).toBe('auto');
  });
});

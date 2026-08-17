import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_GROW_ROWS, useAutoGrow } from '@hooks/use-auto-grow';

/**
 * The sizing hook behind both prompt rows.
 *
 * happy-dom performs no layout, so left alone `scrollHeight` is `0` here and
 * every computed length is `NaN` — the same reason xterm is never instantiated
 * for real. Two kinds of test follow, and the split is deliberate.
 *
 * The **unmeasured** block asserts the hook stays inert rather than writing
 * nonsense when it cannot measure, which is the real behaviour in that
 * environment and worth pinning.
 *
 * The **measured** block stubs the two things happy-dom will not provide — a
 * computed line height and a content height — so the arithmetic and the
 * dependency array become observable. Without that stub these tests cannot
 * fail: an earlier version of this file re-rendered a component whose `value`
 * never changed, and dropping `value` from the dependency array left all of it
 * green. The stub is what turns "the hook ran" into an assertion.
 */

const LINE = 20;

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
const grow = () => screen.getByRole('button', { name: 'grow' });

/**
 * Make the element answer as a browser would: one {@link LINE} per line of
 * text. Defined on the prototype because `scrollHeight` is a getter happy-dom
 * hard-codes to `0`, and a per-instance value cannot be assigned over it.
 */
function stubLayout() {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis.HTMLElement.prototype,
    'scrollHeight',
  );

  Object.defineProperty(globalThis.HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const text = (this as HTMLTextAreaElement).value ?? '';
      return text.split('\n').length * LINE;
    },
  });

  /**
   * Proxied over the real implementation rather than replaced with an object
   * literal. `getComputedStyle` is not only ours to read — testing-library's
   * role queries call `getPropertyValue` on the result to decide whether an
   * element is hidden — so a stub that answers three properties and nothing
   * else breaks `getByRole` before a single assertion runs.
   */
  const real = window.getComputedStyle.bind(window);
  const overrides: Record<string, string> = {
    lineHeight: `${LINE}px`,
    paddingTop: '0px',
    paddingBottom: '0px',
  };

  vi.stubGlobal('getComputedStyle', (el: Element) => {
    const styles = real(el as HTMLElement);
    return new Proxy(styles, {
      get(target, property) {
        if (typeof property === 'string' && property in overrides) {
          return overrides[property];
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(
        globalThis.HTMLElement.prototype,
        'scrollHeight',
        descriptor,
      );
    }
    vi.unstubAllGlobals();
  };
}

describe('useAutoGrow', () => {
  it('caps growth in rows rather than pixels', () => {
    // Denominated in rows so the cap survives a change of type scale: a pixel
    // constant here would silently become six rows or fourteen.
    expect(MAX_GROW_ROWS).toBe(10);
  });

  describe('when the environment cannot measure', () => {
    it('clears the height before measuring, so a row can shrink again', () => {
      /**
       * The subtle half of the hook. `scrollHeight` reports the content height
       * *or the element's own height, whichever is larger* — so an element that
       * has already grown reports at least that forever, and without the reset
       * the row would ratchet upward and never come back down when text is
       * deleted. With no layout engine, `auto` is what survives.
       */
      render(<Probe />);

      expect(field().style.height).toBe('auto');
    });

    it('writes no height at all rather than `NaNpx`', () => {
      // Which is what an unguarded `lineHeight * rows` would produce, and which
      // browsers silently discard — hiding the bug in the one environment where
      // it would matter.
      render(<Probe initial={'a\nb\nc'} />);

      expect(field().getAttribute('style')).not.toContain('NaN');
    });
  });

  describe('when it can measure', () => {
    let restore: () => void;

    afterEach(() => restore?.());

    it('sizes the row to its content', () => {
      restore = stubLayout();
      render(<Probe initial={'a\nb'} />);

      expect(field().style.height).toBe(`${2 * LINE}px`);
    });

    it('re-measures when the value changes', () => {
      /**
       * The dependency that makes the hook do anything, and the one this file
       * previously failed to cover. Changing `[ref, value]` to `[ref]` leaves
       * the height at two lines and fails here — which is the whole point of a
       * test guarding a dependency array.
       */
      restore = stubLayout();
      render(<Probe initial={'a\nb'} />);

      expect(field().style.height).toBe(`${2 * LINE}px`);

      fireEvent.click(grow());

      expect(field()).toHaveValue('a\nb\nmore');
      expect(field().style.height).toBe(`${3 * LINE}px`);
    });

    it('shrinks back when lines are removed', () => {
      restore = stubLayout();
      render(<Probe initial={'a\nb\nc'} />);

      expect(field().style.height).toBe(`${3 * LINE}px`);

      fireEvent.change(field(), { target: { value: 'a' } });

      expect(field().style.height).toBe(`${LINE}px`);
    });

    it('stops at the cap and turns on scrolling only there', () => {
      restore = stubLayout();
      const tall = Array.from({ length: MAX_GROW_ROWS + 5 }, () => 'x').join('\n');
      render(<Probe initial={tall} />);

      expect(field().style.height).toBe(`${MAX_GROW_ROWS * LINE}px`);
      expect(field().style.overflowY).toBe('auto');
    });

    it('leaves a short row unscrollable, so no scrollbar steals width', () => {
      restore = stubLayout();
      render(<Probe initial={'a\nb'} />);

      expect(field().style.overflowY).toBe('hidden');
    });
  });
});

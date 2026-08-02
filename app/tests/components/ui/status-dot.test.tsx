import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  STATUS_LABEL,
  STATUS_TEXT,
  StatusDot,
} from '@components/ui/status-dot';

describe('StatusDot', () => {
  it.each([
    ['working', 'bg-green'],
    ['waiting', 'bg-amber'],
    ['idle', 'bg-subtle'],
    ['done', 'bg-brand'],
    ['online', 'bg-green'],
  ] as const)('paints %s with %s', (status, expected) => {
    const { container } = render(<StatusDot status={status} />);

    expect(container.firstChild).toHaveClass(expected);
  });

  it('pulses only for working', () => {
    const { container, rerender } = render(<StatusDot status="working" />);
    expect(container.firstChild).toHaveClass('animate-ccpulse');

    for (const status of ['waiting', 'idle', 'done', 'online'] as const) {
      rerender(<StatusDot status={status} />);
      expect(container.firstChild).not.toHaveClass('animate-ccpulse');
    }
  });

  it('lets a caller force the pulse off for a working session', () => {
    const { container } = render(<StatusDot status="working" pulse={false} />);

    expect(container.firstChild).not.toHaveClass('animate-ccpulse');
  });

  it('lets a caller force the pulse on for a non-working status', () => {
    const { container } = render(<StatusDot status="idle" pulse />);

    expect(container.firstChild).toHaveClass('animate-ccpulse');
  });

  it('is a 7px circle that never shrinks', () => {
    const { container } = render(<StatusDot status="idle" />);

    expect(container.firstChild).toHaveClass(
      'size-[7px]',
      'rounded-full',
      'shrink-0',
    );
  });

  /**
   * Same contract as `Badge`: with a label the dot joins the accessibility
   * tree, without one it is decoration. Story 031 pairs it with a visible
   * status label and omits it; story 032 has no visible label and passes one,
   * so status is never carried by colour alone.
   */
  it('is decoration when no label is given', () => {
    const { container } = render(<StatusDot status="working" />);

    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('announces its status once a label is given', () => {
    const { container } = render(
      <StatusDot status="waiting" label="lead-form status" />,
    );

    expect(container.firstChild).not.toHaveAttribute('aria-hidden');
    expect(
      screen.getByText('lead-form status: needs input'),
    ).toBeInTheDocument();
  });

  it('forwards a className', () => {
    const { container } = render(
      <StatusDot status="idle" className="mt-0.5" />,
    );

    expect(container.firstChild).toHaveClass('mt-0.5');
  });

  /**
   * A dot and its label drifting to different colours is the exact bug this
   * module exists to prevent, so the two maps are asserted against each other
   * rather than each against a hardcoded list.
   */
  it('keeps the text colour matched to the dot colour', () => {
    for (const status of [
      'working',
      'waiting',
      'idle',
      'done',
      'online',
    ] as const) {
      const { container } = render(<StatusDot status={status} />);
      const fill = [...container.firstElementChild!.classList].find((c) =>
        c.startsWith('bg-'),
      );

      expect(STATUS_TEXT[status]).toBe(fill?.replace('bg-', 'text-'));
    }
  });

  it('owns the waiting → "needs input" rename', () => {
    expect(STATUS_LABEL.waiting).toBe('needs input');
    expect(STATUS_LABEL.working).toBe('working');
    expect(STATUS_LABEL.idle).toBe('idle');
    expect(STATUS_LABEL.done).toBe('done');
    expect(STATUS_LABEL.online).toBe('online');
  });
});

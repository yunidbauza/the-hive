import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  STATUS_LABEL,
  STATUS_TEXT,
  StatusDot,
  statusLabel,
} from '@components/ui/status-dot';

describe('StatusDot', () => {
  it.each([
    ['working', 'bg-green'],
    ['waiting', 'bg-amber'],
    ['idle', 'bg-subtle'],
    ['done', 'bg-brand'],
    /**
     * Muted, not `bg-subtle` (story 108). `idle` owns subtle, and idle and
     * terminated are the two states most easily confused — both quiet, one
     * still alive. Sharing a dot would erase the only distinction that matters
     * when deciding whether to go and look.
     */
    ['terminated', 'bg-muted'],
    ['online', 'bg-green'],
  ] as const)('paints %s with %s', (status, expected) => {
    const { container } = render(<StatusDot status={status} />);

    expect(container.firstChild).toHaveClass(expected);
  });

  it('pulses only for working', () => {
    const { container, rerender } = render(<StatusDot status="working" />);
    expect(container.firstChild).toHaveClass('animate-ccpulse');

    for (const status of [
      'waiting',
      'idle',
      'done',
      'terminated',
      'online',
    ] as const) {
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

  /**
   * The gap Task 6's review found: a labelled, hollow `idle` dot used to
   * announce plain "idle", dropping the one distinction the ring exists to
   * carry for the one audience that cannot see the ring at all.
   */
  it('folds the idle detail into the announcement, not just plain idle', () => {
    render(
      <StatusDot status="idle" label="hero-refresh status" detail="agents" />,
    );

    expect(
      screen.getByText('hero-refresh status: idle (agents)'),
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
      'terminated',
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
    // Its own word, and the reason the state exists: `done` is a claim about
    // the work, `terminated` an observation about the process (story 108).
    expect(STATUS_LABEL.terminated).toBe('terminated');
    expect(STATUS_LABEL.online).toBe('online');
  });

  it('draws a hollow dot when something is still running', () => {
    const { container } = render(<StatusDot status="idle" detail="agents" />);
    const dot = container.firstElementChild as HTMLElement;

    expect(dot.className).toContain('border-subtle');
    expect(dot.className).not.toContain('bg-subtle');
  });

  it('stays solid for a plain idle session', () => {
    const { container } = render(<StatusDot status="idle" />);

    expect((container.firstElementChild as HTMLElement).className).toContain('bg-subtle');
  });

  /**
   * HIVE-83 review fix: hollowness used to be a caller-computed prop, so a
   * `done` row that still carried a stale `idleDetail` (the `/clear` bug at
   * `hive-store.ts`'s retired-row assignment) rendered a hollow ring in the
   * brand colour instead of the solid fill. Deriving hollow from
   * `status === 'idle'` inside the atom makes that unrepresentable — a
   * non-idle status with a `detail` still passed in must stay solid.
   */
  it('never hollows a non-idle status, even if a detail is passed', () => {
    const { container } = render(<StatusDot status="done" detail="agents" />);
    const dot = container.firstElementChild as HTMLElement;

    expect(dot.className).toContain('bg-brand');
    expect(dot.className).not.toContain('border-brand');
  });

  it('names what is still running', () => {
    expect(statusLabel('idle', 'agents')).toBe('idle (agents)');
    expect(statusLabel('idle', 'script')).toBe('idle (script)');
    expect(statusLabel('idle')).toBe('idle');
    expect(statusLabel('waiting')).toBe('needs input');
  });
});

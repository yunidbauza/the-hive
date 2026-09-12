import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PlanGlyph } from '@features/plan/components/plan-glyph';

/** One task's ring (HIVE-181): numbered, pulsing while current, a filled check when done. */
describe('PlanGlyph', () => {
  it('numbers a pending task and names it pending', () => {
    render(<PlanGlyph index={0} status="pending" />);

    const glyph = screen.getByRole('img', { name: 'Task 1, pending' });
    expect(glyph).toHaveTextContent('1');
    expect(glyph.className).toContain('border-term-track');
  });

  it("reads a plan-mode task as proposed", () => {
    render(<PlanGlyph index={0} status="pending" proposed />);

    expect(screen.getByRole('img', { name: 'Task 1, proposed' })).toBeInTheDocument();
  });

  it('pulses the task in progress, in green, only where motion is allowed', () => {
    render(<PlanGlyph index={1} status="in_progress" />);

    const glyph = screen.getByRole('img', { name: 'Task 2, in progress' });
    expect(glyph).toHaveTextContent('2');
    expect(glyph.className).toContain('text-green');
    expect(glyph.className).toContain('motion-safe:animate-ccpulse');
  });

  it('fills a done task with a check instead of its number', () => {
    render(<PlanGlyph index={2} status="completed" />);

    const glyph = screen.getByRole('img', { name: 'Task 3, done' });
    expect(glyph).not.toHaveTextContent('3');
    expect(glyph.querySelector('svg')).not.toBeNull();
    expect(glyph.className).toContain('bg-green');
  });

  it('a done task stays done, not proposed, in plan mode', () => {
    render(<PlanGlyph index={0} status="completed" proposed />);

    expect(screen.getByRole('img', { name: 'Task 1, done' })).toBeInTheDocument();
  });
});

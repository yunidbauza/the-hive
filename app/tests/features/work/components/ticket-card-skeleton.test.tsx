import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TicketListSkeleton } from '@features/work/components/ticket-card-skeleton';

/**
 * The placeholder the WORK panel shows while the Jira read is in flight.
 *
 * The panel used to have eight seeded tickets on screen at boot, so a real read
 * arrived as a replacement and the user watched sample data turn into their
 * backlog. This is what fills that gap instead — nothing false, in the shape of
 * the thing being fetched.
 */
describe('TicketListSkeleton', () => {
  it('announces itself once, not nine times', () => {
    render(<TicketListSkeleton />);

    // A screen reader should hear "Loading tickets", not a stack of anonymous
    // boxes — which is why the cards are aria-hidden and the region is not.
    expect(
      screen.getByRole('status', { name: 'Loading tickets' }),
    ).toBeInTheDocument();
  });

  /**
   * `article` is the element *and* the role a real `TicketCard` has, and no
   * placeholder may be one.
   *
   * `aria-hidden` alone is not enough. It keeps a node out of the accessibility
   * tree but does nothing to a CSS selector, and the e2e suite counts
   * `[data-panel="work"] article` to ask how many tickets are on screen — a
   * question three skeletons must not answer with "three". Asserted on the tag
   * as well as the role, because it was an `<article aria-hidden>` first and
   * that passed the role check while failing the real one.
   */
  it('presents no card as a real ticket', () => {
    const { container } = render(<TicketListSkeleton />);

    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(container.querySelectorAll('article')).toHaveLength(0);
  });

  it('renders three placeholder cards', () => {
    const { container } = render(<TicketListSkeleton />);

    expect(
      container.querySelectorAll('[data-testid="work-skeleton-card"]'),
    ).toHaveLength(3);
  });

  /**
   * The geometry is the point. It mirrors `ticket-card.tsx` exactly — same
   * rounded border, same padding token — so the list settles into place when
   * the data lands instead of reflowing under the user's eye.
   */
  it('matches the real card box, so the list does not jump when data lands', () => {
    const { container } = render(<TicketListSkeleton />);
    const card = container.querySelector('[data-testid="work-skeleton-card"]');

    expect(card).toHaveClass('rounded-xl', 'border', 'border-border-soft');
    expect(card?.className).toContain('py-[var(--cc-card-py)]');
  });
});

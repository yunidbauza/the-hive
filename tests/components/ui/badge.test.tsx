import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge } from '@components/ui/badge';

describe('Badge', () => {
  it('renders the exact count', () => {
    render(<Badge count={3} label="unread notifications" />);

    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders nothing at zero', () => {
    const { container } = render(
      <Badge count={0} label="unread notifications" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a negative count', () => {
    const { container } = render(
      <Badge count={-2} label="unread notifications" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('gives screen readers the count in words, not a bare digit', () => {
    render(<Badge count={12} label="unread notifications" />);

    expect(screen.getByText('12 unread notifications')).toBeInTheDocument();
  });

  /**
   * An ancestor's `aria-label` replaces its descendants' text outright, so a
   * label inside an already-labelled control would never be announced. The
   * badge opts out of the accessibility tree instead of duplicating silently.
   */
  it('is decoration when no label is given', () => {
    const { container } = render(<Badge count={7} />);

    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('joins the accessibility tree once a label is given', () => {
    const { container } = render(<Badge count={7} label="open pull requests" />);

    expect(container.firstChild).not.toHaveAttribute('aria-hidden');
  });

  it('defaults to the danger fill and accepts the other tones', () => {
    const { container, rerender } = render(
      <Badge count={1} label="unread notifications" />,
    );
    expect(container.firstChild).toHaveClass('bg-danger-solid');

    rerender(<Badge count={1} tone="brand" label="open pull requests" />);
    expect(container.firstChild).toHaveClass('bg-brand-fill');

    rerender(<Badge count={1} tone="muted" label="work items" />);
    expect(container.firstChild).toHaveClass('bg-chip', 'text-muted');
  });

  /**
   * The text colour, which nothing asserted until it was wrong.
   *
   * `danger` painted `text-on-brand` — "legible on the *brand* fill" — so a
   * theme whose brand is light enough to need dark text on it, as Graphite's
   * lime does, rendered a near-black count on crimson at 3.22:1. Each fill
   * takes the token named for it, and this is the assertion that says so.
   */
  it('takes its text colour from the fill it sits on, not from the brand', () => {
    const { container, rerender } = render(
      <Badge count={1} label="unread notifications" />,
    );
    expect(container.firstChild).toHaveClass('text-on-danger');
    expect(container.firstChild).not.toHaveClass('text-on-brand');

    rerender(<Badge count={1} tone="brand" label="open pull requests" />);
    expect(container.firstChild).toHaveClass('text-on-brand');
  });

  it('keeps a three-digit count from clipping', () => {
    const { container } = render(
      <Badge count={128} label="unread notifications" />,
    );

    expect(container.firstChild).toHaveClass('min-w-4', 'px-1');
    expect(screen.getByText('128')).toBeInTheDocument();
  });
});

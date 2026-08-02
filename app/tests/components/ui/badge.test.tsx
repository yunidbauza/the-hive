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

  it('defaults to the danger fill and accepts the brand tone', () => {
    const { container, rerender } = render(
      <Badge count={1} label="unread notifications" />,
    );
    expect(container.firstChild).toHaveClass('bg-danger-solid');

    rerender(<Badge count={1} tone="brand" label="open pull requests" />);
    expect(container.firstChild).toHaveClass('bg-brand-fill');
  });

  it('keeps a three-digit count from clipping', () => {
    const { container } = render(
      <Badge count={128} label="unread notifications" />,
    );

    expect(container.firstChild).toHaveClass('min-w-4', 'px-1');
    expect(screen.getByText('128')).toBeInTheDocument();
  });
});

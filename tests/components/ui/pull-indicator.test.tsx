import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PullIndicator } from '@components/ui/pull-indicator';

/** Pretend the OS asked for less motion, for one render. */
function withReducedMotion(reduced: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: reduced,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

describe('PullIndicator', () => {
  it('draws nothing at rest', () => {
    const { container } = render(<PullIndicator distance={0} phase="idle" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('tracks the gesture with its height', () => {
    render(<PullIndicator distance={37} phase="pulling" />);
    expect(screen.getByRole('status')).toHaveStyle({ height: '37px' });
  });

  it('says what the gesture will do, then what it did', () => {
    const { rerender } = render(<PullIndicator distance={20} phase="pulling" />);
    expect(screen.getByText('Pull to refresh')).toBeInTheDocument();

    rerender(<PullIndicator distance={70} phase="armed" />);
    expect(screen.getByText('Release to refresh')).toBeInTheDocument();

    rerender(<PullIndicator distance={64} phase="refreshing" />);
    expect(screen.getByText('Refreshing…')).toBeInTheDocument();
  });

  it('carries its phase for the styles to key on', () => {
    render(<PullIndicator distance={70} phase="armed" />);
    expect(screen.getByRole('status')).toHaveAttribute('data-phase', 'armed');
  });

  /**
   * "Pull to refresh" is a caption on a gesture a screen-reader user is not
   * making; that the list *did* refresh is worth one polite announcement. So
   * only the refreshing label is exposed.
   */
  it('announces only the refresh itself', () => {
    const { rerender } = render(<PullIndicator distance={20} phase="pulling" />);
    expect(screen.getByText('Pull to refresh')).toHaveAttribute(
      'aria-hidden',
      'true',
    );

    rerender(<PullIndicator distance={64} phase="refreshing" />);
    expect(screen.getByText('Refreshing…')).not.toHaveAttribute('aria-hidden');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('spins while refreshing', () => {
    withReducedMotion(false);
    const { container } = render(<PullIndicator distance={64} phase="refreshing" />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('holds still when asked for less motion', () => {
    withReducedMotion(true);
    const { container } = render(<PullIndicator distance={64} phase="refreshing" />);
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Tag } from '@components/ui/tag';

describe('Tag', () => {
  it('renders its text', () => {
    render(<Tag tone="green">approved</Tag>);
    expect(screen.getByText('approved')).toBeInTheDocument();
  });

  it.each([
    ['brand', 'text-brand'],
    ['green', 'text-green'],
    ['amber', 'text-amber'],
    ['red', 'text-red'],
    ['subtle', 'text-subtle'],
  ] as const)('colours the %s tone with %s', (tone, expected) => {
    render(<Tag tone={tone}>label</Tag>);
    expect(screen.getByText('label')).toHaveClass(expected);
  });

  /**
   * A pill is only a pill against its background. On a card already filled with
   * `--cc-chip`, the default fill would erase the shape and leave floating ink,
   * so the raised surface inverts to the panel colour instead.
   */
  describe('surface', () => {
    it('fills against the flat panel by default', () => {
      render(<Tag tone="subtle">merged</Tag>);
      expect(screen.getByText('merged')).toHaveClass('bg-chip');
    });

    it('inverts to the panel fill on a raised surface', () => {
      render(
        <Tag tone="subtle" surface="raised">
          merged
        </Tag>,
      );

      const tag = screen.getByText('merged');
      expect(tag).toHaveClass('bg-panel');
      expect(tag).not.toHaveClass('bg-chip');
    });
  });

  it('merges a caller className', () => {
    render(
      <Tag tone="subtle" className="ml-1">
        draft
      </Tag>,
    );
    expect(screen.getByText('draft')).toHaveClass('ml-1');
  });
});

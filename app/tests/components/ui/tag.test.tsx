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

  it('merges a caller className', () => {
    render(
      <Tag tone="subtle" className="ml-1">
        draft
      </Tag>,
    );
    expect(screen.getByText('draft')).toHaveClass('ml-1');
  });
});

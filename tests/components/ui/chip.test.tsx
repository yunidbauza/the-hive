import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Chip } from '@components/ui/chip';

describe('Chip', () => {
  it('renders its children', () => {
    render(<Chip>opus · high</Chip>);

    expect(screen.getByText('opus · high')).toBeInTheDocument();
  });

  it('is muted without a tone and coloured with one', () => {
    const { container, rerender } = render(<Chip>x</Chip>);
    expect(container.firstChild).toHaveClass('text-muted');

    rerender(<Chip tone="green">x</Chip>);
    expect(container.firstChild).toHaveClass('text-green');
    expect(container.firstChild).not.toHaveClass('text-muted');
  });

  it('exposes a title for the truncated case', () => {
    render(<Chip title="the full story">short</Chip>);

    expect(screen.getByTitle('the full story')).toBeInTheDocument();
  });

  it('never wraps — a chip that wraps would break the 56px header row', () => {
    const { container } = render(<Chip>x</Chip>);

    expect(container.firstChild).toHaveClass('whitespace-nowrap');
  });

  it('merges a caller class without losing its own', () => {
    const { container } = render(<Chip className="ml-2">x</Chip>);

    expect(container.firstChild).toHaveClass('ml-2', 'bg-chip');
  });
});

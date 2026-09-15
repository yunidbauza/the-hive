import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SearchBox } from '@components/ui/search-box';

describe('SearchBox', () => {
  it('is a searchbox named by its label', () => {
    render(<SearchBox label="Search files" value="" onChange={vi.fn()} onClear={vi.fn()} />);

    expect(screen.getByRole('searchbox', { name: 'Search files' })).toHaveAttribute(
      'placeholder',
      'Search files',
    );
  });

  it('reports each keystroke', async () => {
    const onChange = vi.fn();
    render(<SearchBox label="Search files" value="" onChange={onChange} onClear={vi.fn()} />);

    await userEvent.type(screen.getByRole('searchbox'), 'a');

    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('offers the clear button only while there is a term', () => {
    const { rerender } = render(
      <SearchBox label="Search files" value="" onChange={vi.fn()} onClear={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Clear the search' })).toBeNull();

    rerender(<SearchBox label="Search files" value="rail" onChange={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Clear the search' })).toBeInTheDocument();
  });

  it('clears from the button', async () => {
    const onClear = vi.fn();
    render(<SearchBox label="Search files" value="rail" onChange={vi.fn()} onClear={onClear} />);

    await userEvent.click(screen.getByRole('button', { name: 'Clear the search' }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('clears on Escape while there is a term', async () => {
    const onClear = vi.fn();
    render(<SearchBox label="Search files" value="rail" onChange={vi.fn()} onClear={onClear} />);

    await userEvent.type(screen.getByRole('searchbox'), '{Escape}');

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape alone on an empty box', async () => {
    const onClear = vi.fn();
    render(<SearchBox label="Search files" value="" onChange={vi.fn()} onClear={onClear} />);

    await userEvent.type(screen.getByRole('searchbox'), '{Escape}');

    expect(onClear).not.toHaveBeenCalled();
  });
});

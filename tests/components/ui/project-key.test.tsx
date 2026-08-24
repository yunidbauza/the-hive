import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProjectKey } from '@components/ui/project-key';

/**
 * The project key chip (HIVE-94).
 *
 * Small enough that the interesting assertions are about the two decisions the
 * component actually makes — a fixed width, and a monospaced face — because
 * those are what a future edit would quietly drop while the text still rendered.
 */
describe('ProjectKey', () => {
  it('renders the key', () => {
    render(<ProjectKey value="hive" />);

    expect(screen.getByText('hive')).toBeInTheDocument();
  });

  /*
    A fixed width is the whole reason this is not a bare `Tag`: a column of
    chips has to line up whether the key is two letters or four.
  */
  it('is a fixed width, so a column of them aligns', () => {
    render(<ProjectKey value="is" />);

    expect(screen.getByText('is')).toHaveClass('w-11');
  });

  it('is monospaced, matching the console the key is typed into', () => {
    render(<ProjectKey value="is" />);

    expect(screen.getByText('is')).toHaveClass('font-mono');
  });

  it('carries a tooltip when one is given, and none when it is not', () => {
    const { rerender } = render(<ProjectKey value="hive" title="type this" />);
    expect(screen.getByText('hive')).toHaveAttribute('title', 'type this');

    rerender(<ProjectKey value="hive" />);
    expect(screen.getByText('hive')).not.toHaveAttribute('title');
  });
});

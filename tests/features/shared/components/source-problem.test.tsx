import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SourceProblem } from '@features/shared/components/source-problem';

/**
 * What both rails say when their source failed or went stale.
 *
 * The sentence is amber rather than red because the panel still has something
 * to show in the stale case — see each panel's own branch for which it is.
 */
describe('SourceProblem', () => {
  it('shows the message and retries on the button', async () => {
    const onRetry = vi.fn();
    render(<SourceProblem message="Could not reach GitHub." onRetry={onRetry} />);

    expect(screen.getByText('Could not reach GitHub.')).toHaveClass('text-amber');

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

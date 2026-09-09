import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AttachedChip } from '@components/layout/attached-chip';

vi.mock('@hooks/use-project-config', () => ({ useAttachedServer: vi.fn() }));
import { useAttachedServer } from '@hooks/use-project-config';

describe('AttachedChip', () => {
  /*
    A positive control, run first and asserted independently: this proves the
    query below actually finds the chip when the hook says one exists, so the
    "renders nothing" test's own empty assertion cannot be passing for the
    wrong reason (a thrown render, a mis-mocked hook, a typo in the query).
  */
  it('names the server it is attached to', () => {
    vi.mocked(useAttachedServer).mockReturnValue('mini');

    render(<AttachedChip />);

    expect(screen.getByText('attached · mini')).toBeInTheDocument();
  });

  it('renders nothing in local mode', () => {
    vi.mocked(useAttachedServer).mockReturnValue(null);

    const { container } = render(<AttachedChip />);

    expect(container).toBeEmptyDOMElement();
    // Restated against the exact text the positive control above proved this
    // same query can find, rather than only the coarser `toBeEmptyDOMElement`
    // — belt and braces against a future sibling being added to this chip
    // that would make the container non-empty for an unrelated reason while
    // this specific string still correctly never appears.
    expect(screen.queryByText('attached · mini')).not.toBeInTheDocument();
  });

  it('names where the socket goes', () => {
    vi.mocked(useAttachedServer).mockReturnValue('mini');
    render(<AttachedChip />);
    expect(screen.getByTitle(/attached to mini over a socket/)).toBeInTheDocument();
  });

  /*
    Amber is reserved for accidental exposure (`ExposureChip`); attaching is
    as deliberate as serving, so this chip takes the same brand token
    `ServingChip` does. Without this assertion, flipping `tone="brand"` to
    `tone="amber"` — or dropping the prop — passes every other test here,
    since none of the others look past the text and title.
  */
  it('uses the brand token, not amber — this attachment is on purpose', () => {
    vi.mocked(useAttachedServer).mockReturnValue('mini');
    render(<AttachedChip />);
    expect(screen.getByText('attached · mini')).toHaveClass('text-brand');
  });
});

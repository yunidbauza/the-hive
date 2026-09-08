import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ServingChip } from '@components/layout/serving-chip';

vi.mock('@hooks/use-project-config', () => ({ useServerExposure: vi.fn() }));
import { useServerExposure } from '@hooks/use-project-config';

describe('ServingChip', () => {
  it('renders nothing when nothing is bound', () => {
    vi.mocked(useServerExposure).mockReturnValue(null);
    const { container } = render(<ServingChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the address it is serving on', () => {
    vi.mocked(useServerExposure).mockReturnValue('100.101.102.103');
    render(<ServingChip />);
    expect(screen.getByText(/100\.101\.102\.103/)).toBeInTheDocument();
  });

  it('says where to turn it off', () => {
    vi.mocked(useServerExposure).mockReturnValue('100.101.102.103');
    render(<ServingChip />);
    expect(screen.getByTitle(/Settings › Advanced › Server mode/)).toBeInTheDocument();
  });

  /*
    The tone is the entire reason this component exists rather than a second
    call site for `ExposureChip`: amber means "wider than you may have
    meant," brand means "doing this on purpose." Without this assertion,
    flipping `tone="brand"` back to `tone="amber"` — or dropping the prop —
    passes every other test in the file, since none of the others look past
    the text and title. See `exposure-chip.test.tsx`'s equivalent assertion
    on `text-amber`.
  */
  it('uses the brand token, not amber — this exposure is on purpose', () => {
    vi.mocked(useServerExposure).mockReturnValue('100.101.102.103');
    render(<ServingChip />);
    expect(screen.getByText(/100\.101\.102\.103/)).toHaveClass('text-brand');
  });
});

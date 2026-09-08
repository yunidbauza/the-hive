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
});

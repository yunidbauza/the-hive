import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ServingChip } from '@components/layout/serving-chip';

vi.mock('@hooks/use-project-config', () => ({
  useServerExposure: vi.fn(),
  useServingDeviceCount: vi.fn(),
}));
import { useServerExposure, useServingDeviceCount } from '@hooks/use-project-config';

describe('ServingChip', () => {
  it('renders nothing when not serving', () => {
    vi.mocked(useServerExposure).mockReturnValue(null);
    // A live count with nothing bound would be an impossible state to
    // render, but stubbing it non-zero here proves the chip's silence is
    // driven by the bind gate, not by this mock happening to answer 0 too.
    vi.mocked(useServingDeviceCount).mockReturnValue(2);

    const { container } = render(<ServingChip />);

    expect(container).toBeEmptyDOMElement();
  });

  it('reports the device count rather than the address', () => {
    vi.mocked(useServerExposure).mockReturnValue('100.101.102.103');
    vi.mocked(useServingDeviceCount).mockReturnValue(2);

    render(<ServingChip />);

    // Exact string, not a substring regex: `/serving · 2 device/` would also
    // match a chip that always printed "devices" and happened to render "2
    // devices" here by coincidence — see the singular test below for the case
    // that actually discriminates a hard-coded plural.
    expect(screen.getByText('serving · 2 devices')).toBeInTheDocument();
    expect(screen.queryByText(/100\.101\.102\.103/)).not.toBeInTheDocument();
  });

  /*
   * Proven separately from the plural case above, with an **exact** string
   * match rather than a regex substring. `/serving · 1 device/` reads as
   * "singular" but is satisfied by the text "serving · 1 devices" too, since
   * "device" is a leading substring of "devices" — so a component hard-coded
   * to always pluralise would still pass a regex assertion here. The exact
   * string match is the only one of the two that actually fails against that
   * bug, which is the whole point of this test existing.
   */
  it('says device, singular, for one', () => {
    vi.mocked(useServerExposure).mockReturnValue('100.101.102.103');
    vi.mocked(useServingDeviceCount).mockReturnValue(1);

    render(<ServingChip />);

    expect(screen.getByText('serving · 1 device')).toBeInTheDocument();
    expect(screen.queryByText('serving · 1 devices')).not.toBeInTheDocument();
  });

  it('says where to turn it off', () => {
    vi.mocked(useServerExposure).mockReturnValue('100.101.102.103');
    vi.mocked(useServingDeviceCount).mockReturnValue(2);
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
    vi.mocked(useServingDeviceCount).mockReturnValue(2);
    render(<ServingChip />);
    expect(screen.getByText('serving · 2 devices')).toHaveClass('text-brand');
  });
});

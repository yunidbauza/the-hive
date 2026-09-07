import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExposureChip } from '@components/layout/exposure-chip';

const exposure = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('@hooks/use-project-config', () => ({
  useReceiverExposure: () => exposure.value,
}));

/**
 * The hook itself — loopback in, `null` out; anything wider, the address out —
 * is covered by `tests/hooks/use-project-config.test.tsx`. What this file pins
 * is the chip's *reaction* to that hook, so `useReceiverExposure` is mocked
 * rather than driven through a real config snapshot.
 */
describe('ExposureChip', () => {
  beforeEach(() => {
    exposure.value = null;
  });

  /*
    HIVE-131 dropped this indicator because nothing was exposed, and the
    reasoning holds: claiming exposure when there is none is worse than silence.
    So the default bind renders no element at all — not a muted chip, not an
    "off" state.
  */
  it('renders nothing on a loopback bind', () => {
    const { container } = render(<ExposureChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the address it is bound to', () => {
    exposure.value = '172.17.0.1';
    render(<ExposureChip />);
    expect(screen.getByText('172.17.0.1')).toBeInTheDocument();
  });

  it('says where to turn it off', () => {
    exposure.value = '172.17.0.1';
    render(<ExposureChip />);
    expect(screen.getByTitle(/Advanced/i)).toBeInTheDocument();
  });

  it('uses the amber token — the app’s "needs attention" register', () => {
    exposure.value = '172.17.0.1';
    render(<ExposureChip />);
    expect(screen.getByText('172.17.0.1')).toHaveClass('text-amber');
  });
});

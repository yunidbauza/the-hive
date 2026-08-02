import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { Header } from '@components/layout/header';
import { useUiStore } from '@stores/ui-store';

/**
 * The placeholder header story 020 ships. Story 021 replaces it with the real
 * seven-zone header and takes these assertions over.
 */
describe('Header', () => {
  beforeEach(() => {
    useUiStore.getState().reset();
  });

  it('renders as the page banner at the fixed 56px height', () => {
    render(<Header />);

    const banner = screen.getByRole('banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveClass('h-14', 'shrink-0');
  });

  it('offers to switch to light while dark is active', () => {
    render(<Header />);

    expect(
      screen.getByRole('button', { name: 'Switch to light theme' }),
    ).toBeInTheDocument();
  });

  it('offers to switch back to dark once light is active', () => {
    useUiStore.setState({ theme: 'light' });

    render(<Header />);

    expect(
      screen.getByRole('button', { name: 'Switch to dark theme' }),
    ).toBeInTheDocument();
  });

  it('toggles the theme when the control is clicked', async () => {
    const user = userEvent.setup();
    render(<Header />);

    await user.click(
      screen.getByRole('button', { name: 'Switch to light theme' }),
    );

    expect(useUiStore.getState().theme).toBe('light');
    expect(document.body.getAttribute('data-theme')).toBe('light');
    expect(
      screen.getByRole('button', { name: 'Switch to dark theme' }),
    ).toBeInTheDocument();
  });
});

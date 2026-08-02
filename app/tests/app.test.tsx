import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/app';
import { useUiStore } from '@stores/ui-store';

vi.mock('@xterm/xterm');
vi.mock('@xterm/addon-fit');

describe('App', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-theme');
    useUiStore.setState({ theme: 'dark' });
  });

  it('renders the shell with the terminal surface mounted', () => {
    const { container } = render(<App />);

    expect(screen.getByText('the hive')).toBeInTheDocument();
    expect(container.querySelector('header')).toBeInTheDocument();
    expect(container.querySelector('main')).toBeInTheDocument();
  });

  it('offers to switch to light while dark is active', () => {
    render(<App />);

    expect(
      screen.getByRole('button', { name: 'Switch to light theme' }),
    ).toBeInTheDocument();
  });

  it('offers to switch back to dark once light is active', () => {
    useUiStore.setState({ theme: 'light' });
    render(<App />);

    expect(
      screen.getByRole('button', { name: 'Switch to dark theme' }),
    ).toBeInTheDocument();
  });

  it('toggles the theme when the control is clicked', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));

    expect(useUiStore.getState().theme).toBe('light');
    expect(document.body.getAttribute('data-theme')).toBe('light');
    expect(
      screen.getByRole('button', { name: 'Switch to dark theme' }),
    ).toBeInTheDocument();
  });
});

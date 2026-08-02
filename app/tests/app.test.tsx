import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { App } from '@/app';

vi.mock('@xterm/xterm');
vi.mock('@xterm/addon-fit');

describe('App', () => {
  it('renders the shell with the terminal surface mounted', () => {
    const { container } = render(<App />);

    expect(screen.getByText('the hive')).toBeInTheDocument();
    expect(container.querySelector('header')).toBeInTheDocument();
    expect(container.querySelector('main')).toBeInTheDocument();
  });
});

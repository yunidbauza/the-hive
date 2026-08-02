import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Pr } from '@/types/pull-request';

import { PrCard } from '@features/pull-requests/components/pr-card';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

const pr = (overrides: Partial<Pr> = {}): Pr => ({
  n: 482,
  repo: 'apfm-web',
  title: 'Hero: semantic token refactor',
  state: 'open',
  findings: 2,
  checks: 'passing',
  session: 'hero-refresh',
  ...overrides,
});

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

describe('PrCard', () => {
  it('renders number, title, and repo', () => {
    render(<PrCard pr={pr()} />);

    expect(screen.getByText('#482')).toBeInTheDocument();
    expect(screen.getByText('Hero: semantic token refactor')).toBeInTheDocument();
    expect(screen.getByText('apfm-web')).toBeInTheDocument();
  });

  it('renders the badges the rule table composes', () => {
    render(<PrCard pr={pr({ state: 'draft', findings: 0, checks: 'running' })} />);

    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByText('checks running')).toBeInTheDocument();
  });

  it('opens the owning session, not a browser', async () => {
    const user = userEvent.setup();
    render(<PrCard pr={pr()} />);

    await user.click(screen.getByRole('button'));

    expect(useUiStore.getState().activeTab).toBe('hero-refresh');
  });

  it('colours the icon by state', () => {
    const { container, rerender } = render(<PrCard pr={pr({ state: 'merged' })} />);
    expect(container.querySelector('svg')).toHaveClass('text-brand');

    rerender(<PrCard pr={pr({ state: 'draft' })} />);
    expect(container.querySelector('svg')).toHaveClass('text-subtle');
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  url: 'https://github.com/acme/apfm-web/pull/482',
  branch: 'feat/hero-refresh',
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

  it('colours the icon by state', () => {
    const { container, rerender } = render(<PrCard pr={pr({ state: 'merged' })} />);
    expect(container.querySelector('svg')).toHaveClass('text-brand');

    rerender(<PrCard pr={pr({ state: 'draft' })} />);
    expect(container.querySelector('svg')).toHaveClass('text-subtle');
  });

  /**
   * The two actions, and the reason the card stopped being one `<button>`.
   *
   * A user reaching this card wants one of two things — the diff, or the agent
   * that can fix it — and the card has to offer both without nesting one
   * control inside the other, which is invalid markup and unreachable by
   * keyboard.
   */
  describe('two actions', () => {
    it('links the number to the PR on GitHub', () => {
      render(<PrCard pr={pr()} />);

      const link = screen.getByRole('link', {
        name: 'Open PR #482 on GitHub',
      });

      expect(link).toHaveAttribute(
        'href',
        'https://github.com/acme/apfm-web/pull/482',
      );
      expect(link).toHaveAttribute('target', '_blank');
    });

    it('opens the owning session when the body is clicked', async () => {
      const user = userEvent.setup();
      render(<PrCard pr={pr()} />);

      await user.click(screen.getByRole('button', { name: 'Open session hero-refresh' }));

      expect(useUiStore.getState().activeTab).toBe('hero-refresh');
    });

    /**
     * No session on that branch is the ordinary case for a PR raised outside
     * the app. A click that did nothing would read as broken, so the body falls
     * back to the same destination the link has.
     */
    it('opens GitHub from the body when no session matched', async () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      const user = userEvent.setup();

      render(<PrCard pr={pr({ session: null })} />);

      await user.click(
        screen.getByRole('button', { name: 'Open PR #482 on GitHub' }),
      );

      expect(open).toHaveBeenCalledWith(
        'https://github.com/acme/apfm-web/pull/482',
        '_blank',
        'noopener,noreferrer',
      );
      expect(useUiStore.getState().activeTab).toBe('orch');

      open.mockRestore();
    });

    /** Two focus stops, each with its own name. */
    it('exposes both actions to the keyboard', () => {
      render(<PrCard pr={pr()} />);

      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(screen.getAllByRole('link')).toHaveLength(1);
    });
  });
});

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { SessionRow } from '@features/projects/components/session-row';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

const row = () => screen.getByRole('button');

describe('SessionRow', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });

  it('shows the session id, its status label, and its branch', () => {
    render(<SessionRow id="hero-refresh" />);

    expect(screen.getByText('hero-refresh')).toBeInTheDocument();
    expect(screen.getByText('working')).toBeInTheDocument();
    expect(screen.getByText('feat/hero-refresh')).toBeInTheDocument();
  });

  /** The one status whose label is not its own name. */
  it('renders waiting as "needs input"', () => {
    render(<SessionRow id="lead-form" />);

    expect(screen.getByText('needs input')).toBeInTheDocument();
    expect(screen.queryByText('waiting')).not.toBeInTheDocument();
  });

  it('colours the status label to match its dot', () => {
    render(<SessionRow id="lead-form" />);

    expect(screen.getByText('needs input')).toHaveClass('text-amber');
  });

  it('opens the session’s tab when clicked', async () => {
    render(<SessionRow id="webhooks" />);

    await userEvent.click(row());

    expect(useUiStore.getState().activeTab).toBe('webhooks');
  });

  it('highlights the row whose tab is open', () => {
    useUiStore.getState().openTab('hero-refresh');
    render(<SessionRow id="hero-refresh" />);

    expect(row()).toHaveClass('bg-active');
    expect(row()).toHaveAttribute('aria-current', 'true');
  });

  it('leaves an inactive row unhighlighted', () => {
    useUiStore.getState().openTab('webhooks');
    render(<SessionRow id="hero-refresh" />);

    expect(row()).not.toHaveClass('bg-active');
    expect(row()).not.toHaveAttribute('aria-current');
  });

  /**
   * The simulation (061) and the spawn flow (044) both mutate entities under
   * open panels, so a row that assumes its entity exists is a race waiting to
   * throw.
   */
  it('renders nothing for an unknown id', () => {
    const { container } = render(<SessionRow id="does-not-exist" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an agent id', () => {
    const { container } = render(<SessionRow id="slack-agent" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('follows the store when the session’s status changes', () => {
    render(<SessionRow id="hero-refresh" />);
    expect(screen.getByText('working')).toBeInTheDocument();

    act(() => {
      useHiveStore.getState().appendEntityLines('hero-refresh', [], 'waiting');
    });

    expect(screen.getByText('needs input')).toBeInTheDocument();
  });
});

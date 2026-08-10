import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { SessionRow } from '@features/projects/components/session-row';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

const row = () => screen.getByRole('button');

describe('SessionRow', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
  });

  it('shows the session id, its status label, and its branch', () => {
    render(<SessionRow id="hero-refresh" />);

    expect(screen.getByText('hero-refresh')).toBeInTheDocument();
    expect(screen.getByText('working')).toBeInTheDocument();
    expect(screen.getByText('feat/hero-refresh')).toBeInTheDocument();
  });

  it('renders an em dash for a session with no observed branch', () => {
    /**
     * HIVE-78. This row used to read `feat/sess-01` for a session sitting on
     * `main` — a branch nothing had created. An em dash is a smaller claim and
     * an honest one, and it is what every session shows for the moment between
     * spawning and main's first `git rev-parse` coming back.
     */
    const id = useHiveStore.getState().spawnSession('apfm-web');
    render(<SessionRow id={id} />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/^feat\/sess-/)).not.toBeInTheDocument();
  });

  it('renders the branch once main has observed one', () => {
    const id = useHiveStore.getState().spawnSession('apfm-web');
    act(() =>
      useHiveStore
        .getState()
        .setSessionBranch(id, 'feat/incorp-332', '/repo/.claude/worktrees/x'),
    );

    render(<SessionRow id={id} />);

    expect(screen.getByText('feat/incorp-332')).toBeInTheDocument();
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

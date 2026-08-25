import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TicketSessionRow } from '@features/work/components/ticket-session-row';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

/**
 * The session indicator on a ticket card (story 032, reachable since HIVE-73).
 *
 * This component shipped before anything could render it: real tickets carried
 * no sessions, so the WORK panel never mounted one. It has coverage now because
 * the link exists.
 */
describe('TicketSessionRow', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
    seedDemoFleet();
  });

  afterEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });

  it('shows the session name and the repo it runs in', () => {
    render(<TicketSessionRow id="hero-refresh" />);

    expect(screen.getByText('hero-refresh')).toBeInTheDocument();
    expect(screen.getByText('nova-web')).toBeInTheDocument();
  });

  /**
   * The row carries no visible status text, so without a label the dot would
   * communicate status by colour alone.
   */
  it('labels the status dot', () => {
    render(<TicketSessionRow id="hero-refresh" />);

    expect(
      screen.getByText('hero-refresh status: working'),
    ).toBeInTheDocument();
  });

  /**
   * HIVE-83. This row has no visible status text (see `labels the status
   * dot` above), so the sr-only announcement is the only place a screen
   * reader hears what a quiet session is still running — dropping the detail
   * here would announce plain "idle" for a session that is actually still
   * busy with subagents.
   */
  it('folds the idle detail into the announcement for a screen reader', () => {
    act(() => {
      useHiveStore.getState().setSessionStatus('rails-upgrade', 'idle', 'agents');
    });

    render(<TicketSessionRow id="rails-upgrade" />);

    expect(
      screen.getByText('rails-upgrade status: idle (agents)'),
    ).toBeInTheDocument();
  });

  it('opens the session’s terminal', async () => {
    render(<TicketSessionRow id="hero-refresh" />);

    await userEvent.click(screen.getByRole('button'));

    expect(useUiStore.getState().activeTab).toBe('hero-refresh');
  });

  it('renders nothing for an id the store does not know', () => {
    const { container } = render(<TicketSessionRow id="not-a-session" />);
    expect(container).toBeEmptyDOMElement();
  });

  /** Agents own tabs too, but they are not sessions and never work a ticket. */
  it('renders nothing for an agent', () => {
    const { container } = render(<TicketSessionRow id="slack-agent" />);
    expect(container).toBeEmptyDOMElement();
  });
});

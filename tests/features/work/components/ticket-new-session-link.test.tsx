import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TicketNewSessionLink } from '@features/work/components/ticket-new-session-link';
import { useUiStore } from '@stores/ui-store';

/**
 * Start a session for a ticket (HIVE-73).
 *
 * The component is three lines of markup; what is worth testing is the seam it
 * exists to respect — it must reach the picker through the store, because
 * `features/work` may not import `features/sessions`.
 */
describe('TicketNewSessionLink', () => {
  beforeEach(() => {
    useUiStore.getState().reset();
  });

  afterEach(() => {
    useUiStore.getState().reset();
  });

  it('opens the picker for its own ticket', async () => {
    render(<TicketNewSessionLink ticketKey="HIVE-73" />);

    await userEvent.click(screen.getByRole('button'));

    expect(useUiStore.getState().picker).toBe(true);
    expect(useUiStore.getState().pickerTicket).toBe('HIVE-73');
  });

  /**
   * The header's button is `New session`, and the electron e2e fixture drives
   * the picker with `getByRole('button', { name: 'New session' })`. An
   * accessible name equal to the visible text would make that query ambiguous
   * the moment a ticket card is on screen.
   */
  it('names its ticket in the accessible name, not just the visible text', () => {
    render(<TicketNewSessionLink ticketKey="HIVE-73" />);

    expect(
      screen.getByRole('button', { name: 'New session for HIVE-73' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New session' }),
    ).not.toBeInTheDocument();
  });

  it('clears the search query so a reopen shows no stale filter', async () => {
    useUiStore.getState().setPickerQuery('nova');

    render(<TicketNewSessionLink ticketKey="HIVE-73" />);
    await userEvent.click(screen.getByRole('button'));

    expect(useUiStore.getState().pickerQuery).toBe('');
  });
});

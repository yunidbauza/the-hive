import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Ticket } from '@/types/ticket';

import { TicketCard } from '@features/work/components/ticket-card';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

/**
 * The whole card (HIVE-73).
 *
 * The parts each have their own file; what this one owns is the **composition**
 * — that the sessions working a ticket appear above the PRs those sessions
 * opened, that the way to start another session is the last thing in the
 * sessions block, and that all of it comes before the conversation.
 */
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  key: 'GRAC-3018',
  status: 'In Progress',
  statusCategory: 'in-progress',
  title: 'Hero refresh: migrate to semantic tokens',
  ...over,
});

describe('TicketCard', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
    seedDemoFleet();
  });

  afterEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });

  it('lists the sessions working the ticket', () => {
    render(<TicketCard ticket={ticket()} />);

    expect(screen.getByText('hero-refresh')).toBeInTheDocument();
  });

  /** `rails-upgrade` is on no ticket; it must not appear on this one. */
  it('lists only the sessions pointing at this ticket', () => {
    render(<TicketCard ticket={ticket()} />);

    expect(screen.queryByText('rails-upgrade')).not.toBeInTheDocument();
    expect(screen.queryByText('lead-form')).not.toBeInTheDocument();
  });

  it('shows the PRs those sessions opened', () => {
    render(<TicketCard ticket={ticket()} />);

    expect(screen.getByText('#482')).toBeInTheDocument();
  });

  /** Two sessions, one ticket — the concept's GRAC-3010 case. */
  it('lists every session on a ticket that has more than one', () => {
    render(<TicketCard ticket={ticket({ key: 'GRAC-3010' })} />);

    expect(screen.getByText('nplusone')).toBeInTheDocument();
    expect(screen.getByText('e2e-quote')).toBeInTheDocument();
  });

  it('offers to start a session for the ticket', async () => {
    render(<TicketCard ticket={ticket()} />);

    await userEvent.click(
      screen.getByRole('button', { name: 'New session for GRAC-3018' }),
    );

    expect(useUiStore.getState().pickerTicket).toBe('GRAC-3018');
  });

  /**
   * The start link is the last child of the sessions block, so it sits directly
   * under the title on a ticket nobody has picked up and under the final
   * session on one that is being worked.
   */
  it('puts the start link after the session rows and before the PRs', () => {
    render(<TicketCard ticket={ticket()} />);

    const labels = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);

    const session = labels.findIndex((label) => label?.includes('hero-refresh'));
    const start = labels.findIndex((label) =>
      label?.includes('New session for'),
    );
    const pr = labels.findIndex((label) => label?.includes('#482'));

    expect(session).toBeLessThan(start);
    expect(start).toBeLessThan(pr);
  });

  it('still offers to start a session on a ticket nobody is working', () => {
    render(<TicketCard ticket={ticket({ key: 'UNWORKED-1' })} />);

    expect(
      screen.getByRole('button', { name: 'New session for UNWORKED-1' }),
    ).toBeInTheDocument();
  });

  /**
   * A divider with nothing under it reads as a rendering bug, which is why the
   * PR block — separator included — is omitted rather than emptied.
   */
  it('omits the PR block entirely when no session has one', () => {
    const { container } = render(
      <TicketCard ticket={ticket({ key: 'GRAC-3022' })} />,
    );

    expect(screen.queryByText(/^#\d+$/)).not.toBeInTheDocument();
    expect(container.querySelector('.border-t')).toBeNull();
  });

  /**
   * The load-bearing property of the whole redesign: the WORK panel re-reads
   * Jira on every open, and the sessions on a card have to survive it.
   */
  it('keeps its sessions across a ticket refresh', () => {
    render(<TicketCard ticket={ticket()} />);
    expect(screen.getByText('hero-refresh')).toBeInTheDocument();

    act(() => {
      useHiveStore.getState().hydrateTickets(
        [
          {
            key: 'GRAC-3018',
            summary: 'Hero refresh: migrate to semantic tokens',
            status: 'In Review',
            statusCategory: 'in-progress',
            issueType: 'Story',
            priority: null,
            assignee: null,
            updated: '2026-08-09T00:00:00.000+0000',
            url: 'https://example.atlassian.net/browse/GRAC-3018',
          },
        ],
        false,
      );
    });

    expect(screen.getByText('hero-refresh')).toBeInTheDocument();
  });

  /**
   * `/clear` retires the old row as `done` and gives the successor the same
   * `ticket`, because the terminal is still on the same issue. Listing both
   * would grow the card by a row on every clear — up to `DONE_CAP` of them.
   */
  it('shows one row per terminal after /clear, not two', () => {
    render(<TicketCard ticket={ticket()} />);
    expect(screen.getByText('hero-refresh')).toBeInTheDocument();

    let successor = '';
    act(() => {
      successor = useHiveStore.getState().clearSession('hero-refresh') ?? '';
    });

    expect(successor).not.toBe('');
    expect(screen.queryByText('hero-refresh')).not.toBeInTheDocument();
    expect(screen.getByText(successor)).toBeInTheDocument();
  });

  /**
   * The other half of that filter. A merged PR outlives the session that opened
   * it, so a completed ticket must keep its PR row even though no session is
   * running — which is what the concept shows for a Done issue.
   */
  it('keeps the PR of a session that has ended', () => {
    // GRAC-2810 / `tz-fix` is `done` and carries merged PR #77.
    render(<TicketCard ticket={ticket({ key: 'GRAC-2810' })} />);

    expect(screen.queryByText('tz-fix')).not.toBeInTheDocument();
    expect(screen.getByText('#77')).toBeInTheDocument();
    expect(screen.getByText('merged')).toBeInTheDocument();
  });

  it('links out to Jira only when the issue is real', () => {
    const { rerender } = render(
      <TicketCard ticket={ticket({ url: 'https://example.test/GRAC-3018' })} />,
    );
    expect(screen.getByRole('link', { name: 'GRAC-3018' })).toBeInTheDocument();

    rerender(<TicketCard ticket={ticket()} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('colours the status pill by Jira’s category, not the status name', () => {
    render(<TicketCard ticket={ticket({ status: 'Awaiting deploy' })} />);

    // The name is shown verbatim; the colour comes from `in-progress`.
    const pill = screen.getByText('Awaiting deploy');
    expect(pill).toHaveClass('text-brand');
  });

  it('renders a status Jira invented, in the done bucket', () => {
    render(
      <TicketCard
        ticket={ticket({ status: 'Shipped', statusCategory: 'done' })}
      />,
    );

    expect(screen.getByText('Shipped')).toHaveClass('text-green');
  });

  it('shows the title', () => {
    render(<TicketCard ticket={ticket()} />);
    expect(
      screen.getByText('Hero refresh: migrate to semantic tokens'),
    ).toBeInTheDocument();
  });

  it('keeps the PR row inside the divided block', () => {
    const { container } = render(<TicketCard ticket={ticket()} />);

    const block = container.querySelector('.border-t');
    expect(block).not.toBeNull();
    expect(within(block as HTMLElement).getByText('#482')).toBeInTheDocument();
  });
});


/**
 * The card's header row (HIVE-79).
 *
 * The defect: on a 268px left rail the card has ~216px of content width, and
 * `INCORP-463` + a `Move ⌄` control + an `IN PROGRESS` lozenge did not fit —
 * the key wrapped to a second line. Folding the control into the lozenge is what
 * bought the room back, and these assertions pin that shape rather than the
 * pixels, which `ticket-card.spec.ts` measures in a real browser.
 */
describe('the header row', () => {
  it('has no separate Move control — the lozenge is the trigger', () => {
    render(<TicketCard ticket={ticket({ url: 'https://x/browse/HIVE-70' })} />);

    // The word that used to sit between the key and the status is gone.
    expect(screen.queryByText('Move')).not.toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: 'In Progress — move GRAC-3018' });
    expect(trigger).toHaveTextContent('In Progress');
  });

  it('holds exactly two things: the key and the status', () => {
    render(<TicketCard ticket={ticket({ url: 'https://x/browse/HIVE-70' })} />);

    const key = screen.getByText('GRAC-3018');
    // The key, a flex spacer, and the lozenge — nothing else competing for the
    // row's width.
    const row = key.parentElement;
    expect(row?.children).toHaveLength(3);
  });

  /**
   * A fixture has no Jira behind it, so an interactive lozenge would be a
   * control that cannot work — the same "absent rather than disabled" rule the
   * notification switches follow. Both spellings share `STATUS_PILL`, so the
   * card does not resize depending on where its ticket came from.
   */
  it('renders an inert lozenge for a ticket with no issue behind it', () => {
    render(<TicketCard ticket={ticket()} />);

    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /move GRAC-3018/i })).not.toBeInTheDocument();
  });

  it('gives both spellings the same shape, so the row does not jump', () => {
    const { unmount } = render(<TicketCard ticket={ticket()} />);
    const inert = screen.getByText('In Progress').className;
    unmount();

    render(<TicketCard ticket={ticket({ url: 'https://x/browse/HIVE-70' })} />);
    const interactive = screen.getByRole('button', { name: 'In Progress — move GRAC-3018' })
      .className;

    for (const shape of ['rounded-full', 'bg-chip', 'px-[9px]', 'text-[10px]']) {
      expect(inert).toContain(shape);
      expect(interactive).toContain(shape);
    }
  });
});

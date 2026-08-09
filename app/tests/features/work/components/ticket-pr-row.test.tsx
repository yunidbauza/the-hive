import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TicketPr } from '@/types/pull-request';

import { TicketPrRow } from '@features/work/components/ticket-pr-row';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

/**
 * The PR indicator on a ticket card (story 032, reachable since HIVE-73).
 *
 * Like the session row, this shipped unreachable — a real ticket had no
 * sessions, so it had no PRs either. It is on screen now.
 */
const pr = (over: Partial<TicketPr> = {}): TicketPr => ({
  n: 482,
  repo: 'apfm-web',
  state: 'open',
  findings: 0,
  session: 'hero-refresh',
  ...over,
});

describe('TicketPrRow', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
    seedDemoFleet();
  });

  afterEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });

  it('shows the number, the repo and the state', () => {
    render(<TicketPrRow pr={pr()} />);

    expect(screen.getByText('#482')).toBeInTheDocument();
    expect(screen.getByText('apfm-web')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
  });

  it.each(['draft', 'open', 'merged'] as const)('renders a %s PR', (state) => {
    render(<TicketPrRow pr={pr({ state })} />);
    expect(screen.getByText(state)).toBeInTheDocument();
  });

  /**
   * The count is decorative to a sighted user and meaningless to a screen
   * reader, so the glyph is hidden and a sentence carries the same fact.
   */
  it('describes unresolved findings for assistive tech', () => {
    render(<TicketPrRow pr={pr({ findings: 2 })} />);

    expect(screen.getByText('⚠ 2')).toBeInTheDocument();
    expect(screen.getByText('2 open findings')).toBeInTheDocument();
  });

  it('shows no findings marker when there are none', () => {
    render(<TicketPrRow pr={pr({ findings: 0 })} />);
    expect(screen.queryByText(/⚠/)).not.toBeInTheDocument();
  });

  /** A PR has no tab of its own; the session that produced it does. */
  it('opens the owning session rather than a browser', async () => {
    render(<TicketPrRow pr={pr()} />);

    await userEvent.click(screen.getByRole('button'));

    expect(useUiStore.getState().activeTab).toBe('hero-refresh');
  });
});

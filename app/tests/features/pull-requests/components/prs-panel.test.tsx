import { render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { PrsPanel } from '@features/pull-requests/components/prs-panel';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

const cardFor = (n: number) =>
  screen.getByText(`#${n}`).closest('button') as HTMLElement;

describe('PrsPanel', () => {
  it('renders one card per PR', () => {
    render(<PrsPanel />);

    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  /**
   * Story 052's acceptance criterion, fixture by fixture.
   *
   * #219 gets `approved` and nothing else: the story's rule table and the
   * concept both gate "no findings" on `state open`, even though the story's
   * worked example adds it here. See `composeBadges` for the full reasoning.
   */
  it('gives each fixture PR the badge combination the rules produce', () => {
    render(<PrsPanel />);

    expect(within(cardFor(482)).getByText('2 open findings')).toBeInTheDocument();

    expect(within(cardFor(219)).getByText('approved')).toBeInTheDocument();
    expect(within(cardFor(219)).queryByText('no findings')).not.toBeInTheDocument();

    expect(within(cardFor(495)).getByText('draft')).toBeInTheDocument();
    expect(within(cardFor(495)).getByText('checks running')).toBeInTheDocument();

    expect(within(cardFor(77)).getByText('merged')).toBeInTheDocument();
  });

  it('re-renders when a PR changes in the store', async () => {
    render(<PrsPanel />);
    expect(within(cardFor(482)).getByText('2 open findings')).toBeInTheDocument();

    await act(async () => {
      useHiveStore.setState((state) => ({
        prs: state.prs.map((pr) =>
          pr.n === 482 ? { ...pr, findings: 3, checks: 'failing' as const } : pr,
        ),
      }));
    });

    expect(within(cardFor(482)).getByText('3 open findings')).toBeInTheDocument();
    expect(within(cardFor(482)).getByText('checks failing')).toBeInTheDocument();
  });

  /** A draft that opens picks up the reassurance badge it could not have before. */
  it('re-renders a state change', async () => {
    render(<PrsPanel />);
    expect(within(cardFor(495)).getByText('draft')).toBeInTheDocument();

    await act(async () => {
      useHiveStore.setState((state) => ({
        prs: state.prs.map((pr) =>
          pr.n === 495
            ? { ...pr, state: 'open' as const, checks: 'passing' as const }
            : pr,
        ),
      }));
    });

    expect(within(cardFor(495)).queryByText('draft')).not.toBeInTheDocument();
    expect(within(cardFor(495)).getByText('no findings')).toBeInTheDocument();
  });
});

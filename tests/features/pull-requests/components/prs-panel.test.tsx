import { render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { PrsPanel } from '@features/pull-requests/components/prs-panel';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

beforeEach(() => {
  useHiveStore.getState().reset();
  seedDemoFleet();
  /**
   * Stub the sweep the poller fires on mount.
   *
   * `usePrRefresh` subscribes this panel to the shared timer, and the real
   * action settles on `unconfigured` in a test environment — no bridge,
   * therefore no `gh` — which would clear the seeded PRs before an assertion
   * ran. These cases are about how a PR *renders*; `use-pr-refresh.test.ts`
   * owns the scheduling and `hive-store.refresh-prs.test.ts` owns the states.
   */
  useHiveStore.setState({ refreshPrs: () => Promise.resolve() });
  useUiStore.getState().reset();
});

/** The card is the box around the number — now a `div`, not a `button`. */
const cardFor = (n: number) =>
  screen.getByText(`#${n}`).closest('div.relative') as HTMLElement;

describe('PrsPanel', () => {
  it('renders one card per PR', () => {
    render(<PrsPanel />);

    // One stretched "open the session" button per card.
    expect(screen.getAllByRole('button')).toHaveLength(5);
  });

  /**
   * Story 052's acceptance criterion, PR by PR.
   *
   * #219 gets `approved` and nothing else: the story's rule table and the
   * concept both gate "no findings" on `state open`, even though the story's
   * worked example adds it here. See `composeBadges` for the full reasoning.
   */
  it('gives each PR the badge combination the rules produce', () => {
    render(<PrsPanel />);

    expect(within(cardFor(482)).getByText('2 open findings')).toBeInTheDocument();

    expect(within(cardFor(219)).getByText('approved')).toBeInTheDocument();
    expect(within(cardFor(219)).queryByText('no findings')).not.toBeInTheDocument();

    expect(within(cardFor(495)).getByText('draft')).toBeInTheDocument();
    expect(within(cardFor(495)).getByText('checks running')).toBeInTheDocument();

    expect(within(cardFor(77)).getByText('merged')).toBeInTheDocument();
  });

  /**
   * An approved PR with open findings shows **both**, state first.
   *
   * The case that motivated the badge order: a reviewer can approve while a bot
   * still has unresolved threads, and a panel that showed only one of the two
   * would be hiding whichever the user needed.
   */
  it('shows approval and findings together, approval first', () => {
    act(() => {
      useHiveStore.setState((state) => ({
        prs: state.prs.map((pr) =>
          pr.number === 219 ? { ...pr, findings: 3 } : pr,
        ),
      }));
    });

    render(<PrsPanel />);

    const badges = within(cardFor(219))
      .getAllByText(/approved|open findings/)
      .map((el) => el.textContent);

    expect(badges).toEqual(['approved', '3 open findings']);
  });

  it('re-renders when a PR changes in the store', async () => {
    render(<PrsPanel />);
    expect(within(cardFor(482)).getByText('2 open findings')).toBeInTheDocument();

    await act(async () => {
      useHiveStore.setState((state) => ({
        prs: state.prs.map((pr) =>
          pr.number === 482 ? { ...pr, findings: 3, checks: 'failing' as const } : pr,
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
          pr.number === 495
            ? { ...pr, state: 'open' as const, checks: 'passing' as const }
            : pr,
        ),
      }));
    });

    expect(within(cardFor(495)).queryByText('draft')).not.toBeInTheDocument();
    expect(within(cardFor(495)).getByText('no findings')).toBeInTheDocument();
  });

  /**
   * The owning session is resolved by branch, at render time.
   *
   * #482 is on `feat/hero-refresh`, which the `hero-refresh` session is
   * working — so its card offers that session. #77's branch belongs to a
   * session too, but a *finished* one, which is still the right tab to open.
   */
  it('names the session on the PR’s branch', () => {
    render(<PrsPanel />);

    expect(
      within(cardFor(482)).getByRole('button', { name: 'Open session hero-refresh' }),
    ).toBeInTheDocument();
  });

  it('falls back to GitHub when no session is on the branch', () => {
    act(() => {
      useHiveStore.setState((state) => ({
        prs: state.prs.map((pr) =>
          pr.number === 482 ? { ...pr, branch: 'feat/nobody-is-on-this' } : pr,
        ),
      }));
    });

    render(<PrsPanel />);

    expect(
      within(cardFor(482)).getByRole('button', { name: 'Open PR #482 on GitHub' }),
    ).toBeInTheDocument();
  });

  describe('source states', () => {
    it('shows a skeleton while the first sweep is out', () => {
      act(() => {
        useHiveStore.setState({ prs: [], prSource: { kind: 'loading' } });
      });

      render(<PrsPanel />);

      expect(screen.getByLabelText('Loading pull requests')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('explains an unconfigured machine instead of sitting empty', () => {
      act(() => {
        useHiveStore.setState({
          prs: [],
          prSource: {
            kind: 'unconfigured',
            message: 'GitHub CLI (`gh`) was not found on this machine.',
          },
        });
      });

      render(<PrsPanel />);

      expect(
        screen.getByText('GitHub CLI (`gh`) was not found on this machine.'),
      ).toBeInTheDocument();
    });

    it('offers a retry when the first sweep failed', () => {
      act(() => {
        useHiveStore.setState({
          prs: [],
          prSource: { kind: 'failed', message: 'Could not reach GitHub.' },
        });
      });

      render(<PrsPanel />);

      expect(screen.getByText('Could not reach GitHub.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    /** Staleness over emptiness: the rows stay, with a warning above them. */
    it('keeps a stale list on screen and says so', () => {
      act(() => {
        useHiveStore.setState({
          prSource: { kind: 'live', stale: true, repos: 5 },
        });
      });

      render(<PrsPanel />);

      expect(
        screen.getByText('Could not reach GitHub. These may be out of date.'),
      ).toBeInTheDocument();
      expect(within(cardFor(482)).getByText('2 open findings')).toBeInTheDocument();
    });

    it('answers an empty sweep with how many repositories it swept', () => {
      act(() => {
        useHiveStore.setState({
          prs: [],
          prSource: { kind: 'live', stale: false, repos: 4 },
        });
      });

      render(<PrsPanel />);

      expect(
        screen.getByText('No open pull requests of yours across 4 repositories.'),
      ).toBeInTheDocument();
    });

    /**
     * The browser e2e cannot reach this state — it needs `gh` to be live — so
     * the creature's presence and its rail size are pinned here instead. This
     * is the panel the absence was first reported on.
     */
    it('leads the empty sweep with a spire at rail size', () => {
      act(() => {
        useHiveStore.setState({
          prs: [],
          prSource: { kind: 'live', stale: false, repos: 4 },
        });
      });

      render(<PrsPanel />);

      const img = screen.getByRole('presentation', { hidden: true });

      expect(img).toHaveAttribute('data-creature', 'spire');
      expect(img).toHaveStyle({ height: '44px' });
      expect(document.querySelector('[data-swarm-line]')).not.toBeNull();
    });

    it('says “1 repository”, not “1 repositories”', () => {
      act(() => {
        useHiveStore.setState({
          prs: [],
          prSource: { kind: 'live', stale: false, repos: 1 },
        });
      });

      render(<PrsPanel />);

      expect(
        screen.getByText('No open pull requests of yours across 1 repository.'),
      ).toBeInTheDocument();
    });
  });
});

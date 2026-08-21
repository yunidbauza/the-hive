import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Entity } from '@/types/entity';

import { SessionMetaBar } from '@components/layout/session-meta-bar';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

const entity = (id: string): Entity => {
  const found = useHiveStore.getState().entities[id];
  if (!found) throw new Error(`no fixture entity ${id}`);
  return found;
};

/**
 * The bar above the terminal in the session and agent views (story 040).
 * Everything it shows is derived from the entity, so these assertions double as
 * a check that a status or PR change reaches the bar.
 */
describe('SessionMetaBar', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
  });

  describe('sessions', () => {
    it('shows the id, task, branch, and status', () => {
      render(<SessionMetaBar entity={entity('hero-refresh')} />);

      expect(screen.getByText('hero-refresh')).toBeInTheDocument();
      expect(
        screen.getByText('Refactor hero to semantic tokens'),
      ).toBeInTheDocument();
      expect(screen.getByText('feat/hero-refresh')).toBeInTheDocument();
      expect(screen.getByText('working')).toBeInTheDocument();
    });

    it('shows an em dash before any branch has been observed', () => {
      /**
       * HIVE-78. The chip is the most prominent of the three branch surfaces —
       * it sits directly above the terminal — so it is the one that made
       * `feat/sess-01` look most authoritative while the session was on `main`.
       */
      const id = useHiveStore.getState().spawnSession('apfm-web');

      render(<SessionMetaBar entity={entity(id)} />);

      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('shows the real branch once main reports it', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      act(() =>
        useHiveStore
          .getState()
          .setSessionBranch(id, 'feat/incorp-332', '/repo/.claude/worktrees/x'),
      );

      render(<SessionMetaBar entity={entity(id)} />);

      expect(screen.getByText('feat/incorp-332')).toBeInTheDocument();
    });

    it('renders the PR chip with its number and state', () => {
      render(<SessionMetaBar entity={entity('hero-refresh')} />);

      expect(screen.getByText('#482 · open')).toBeInTheDocument();
    });

    it('omits the PR chip when the session has no PR', () => {
      render(<SessionMetaBar entity={entity('lead-form')} />);

      expect(screen.queryByText(/^#\d/)).not.toBeInTheDocument();
    });

    /**
     * HIVE-83: the chip's dot goes hollow and its word names what is still
     * running, matching the rails and the fleet table rather than collapsing
     * a quiet-but-busy session into plain "idle".
     */
    it('names what a quiet session is still running, and hollows the dot', () => {
      act(() => {
        useHiveStore
          .getState()
          .setSessionStatus('rails-upgrade', 'idle', 'agents');
      });

      render(<SessionMetaBar entity={entity('rails-upgrade')} />);

      expect(screen.getByText('idle (agents)')).toBeInTheDocument();
    });

    it('renames a waiting session to "needs input"', () => {
      render(<SessionMetaBar entity={entity('lead-form')} />);

      // The rename lives in STATUS_LABEL so the rails and this bar cannot
      // disagree about what `waiting` is called.
      expect(screen.getByText('needs input')).toBeInTheDocument();
      expect(screen.queryByText('waiting')).not.toBeInTheDocument();
    });

    it('follows a status change made after mount', () => {
      const { rerender } = render(<SessionMetaBar entity={entity('lead-form')} />);
      expect(screen.getByText('needs input')).toBeInTheDocument();

      useHiveStore
        .getState()
        .appendEntityLines('lead-form', [{ text: 'ok', color: 'dim' }], 'working');
      rerender(<SessionMetaBar entity={entity('lead-form')} />);

      // The payoff moment from story 043: answering a blocked session clears
      // "needs input" here at the same instant it clears in the rails.
      expect(screen.getByText('working')).toBeInTheDocument();
    });
  });

  describe('agents', () => {
    it('shows the agent chips rather than branch and PR', () => {
      render(<SessionMetaBar entity={entity('slack-agent')} />);

      expect(screen.getByText('slack-agent')).toBeInTheDocument();
      expect(screen.getByText('dedicated agent')).toBeInTheDocument();
      expect(screen.getByText('online')).toBeInTheDocument();
    });
  });

  describe('the back button', () => {
    it('returns to the overmind', async () => {
      const user = userEvent.setup();
      useUiStore.getState().openTab('hero-refresh');
      render(<SessionMetaBar entity={entity('hero-refresh')} />);

      await user.click(screen.getByRole('button', { name: 'Back to overmind' }));

      expect(useUiStore.getState().activeTab).toBe('orch');
    });

    it('names its keyboard shortcut in the tooltip', () => {
      render(<SessionMetaBar entity={entity('hero-refresh')} />);

      // Story 060 binds ArrowLeft to the same action; the hint is how anyone
      // discovers it.
      expect(
        screen.getByRole('button', { name: 'Back to overmind' }),
      ).toHaveAttribute('title', 'Back to overmind (←)');
    });
  });
});

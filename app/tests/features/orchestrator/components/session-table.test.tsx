import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { SessionTable } from '@features/orchestrator/components/session-table';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

const rows = () => screen.getAllByRole('button');

/** The fleet table (story 041) — DOM, so its rows stay clickable. */
describe('SessionTable', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });

  it('partitions the fixtures into 8 active and 2 ended', () => {
    render(<SessionTable />);

    // The exact split the story's acceptance criteria name.
    expect(rows()).toHaveLength(10);
    expect(screen.getByText('ENDED')).toBeInTheDocument();
  });

  it('lists active sessions before the divider and done ones after', () => {
    render(<SessionTable />);
    const labels = rows().map((row) => row.textContent ?? '');

    // `tz-fix` and `ecs-scaling` are the two done fixtures.
    expect(labels.slice(0, 8).join(' ')).not.toContain('tz-fix');
    expect(labels.slice(8).join(' ')).toContain('tz-fix');
    expect(labels.slice(8).join(' ')).toContain('ecs-scaling');
  });

  it('shows id, status, project · branch, and PR for a row', () => {
    render(<SessionTable />);
    const row = rows()[0];

    expect(within(row).getByText('hero-refresh')).toBeInTheDocument();
    expect(within(row).getByText('working')).toBeInTheDocument();
    expect(
      within(row).getByText('apfm-web · feat/hero-refresh'),
    ).toBeInTheDocument();
    expect(within(row).getByText('#482')).toBeInTheDocument();
  });

  it('names the PR state rather than carrying it in colour alone', () => {
    render(<SessionTable />);
    const row = rows()[0];

    // 34px leaves no room for the state as visible text, but a hue is no
    // signal to a colour-blind user and none at all to a screen reader.
    expect(within(row).getByText('#482')).toHaveAttribute(
      'title',
      '#482 · open',
    );
    expect(row).toHaveAccessibleName(/open/);
  });

  it('renders an em dash for a session with no PR', () => {
    render(<SessionTable />);
    const leadForm = rows().find((row) => row.textContent?.includes('lead-form'));

    expect(within(leadForm!).getByText('—')).toBeInTheDocument();
  });

  it('renames a waiting session to "needs input"', () => {
    render(<SessionTable />);
    const leadForm = rows().find((row) => row.textContent?.includes('lead-form'));

    expect(within(leadForm!).getByText('needs input')).toBeInTheDocument();
  });

  it('selects and opens on click', async () => {
    const user = userEvent.setup();
    render(<SessionTable />);

    const webhooks = rows().find((row) => row.textContent?.includes('webhooks'));
    await user.click(webhooks!);

    // Both, not one: the caret has to follow the user's last action or the
    // keyboard and the mouse disagree about where "here" is.
    expect(useUiStore.getState().activeTab).toBe('webhooks');
    expect(useUiStore.getState().selIdx).toBe(2);
  });

  describe('a terminated session (story 108)', () => {
    const webhooks = () =>
      rows().find((row) => row.textContent?.includes('webhooks'))!;

    const terminate = () =>
      act(() =>
        useHiveStore.getState().setSessionStatus('webhooks', 'terminated'),
      );

    it('says so in the status column', () => {
      render(<SessionTable />);
      terminate();

      // Its own word, not `done`. One finished; the other quit, and the fleet
      // view is where that difference is decided upon.
      expect(within(webhooks()).getByText('terminated')).toBeInTheDocument();
    });

    it('moves under the divider with the other endings', () => {
      render(<SessionTable />);
      terminate();

      const labels = rows().map((row) => row.textContent ?? '');
      expect(labels.slice(0, 7).join(' ')).not.toContain('webhooks');
      expect(labels.slice(7).join(' ')).toContain('webhooks');
    });

    it('cannot be entered, and says why', async () => {
      /**
       * `disabled`, not a silently ignored click. The row's job on this screen
       * is to say what happened to a session, so it stays legible and stays in
       * the list — but a button that looks live and does nothing is worse than
       * one that says it is spent, and `disabled` is the only version of that a
       * screen reader hears too.
       */
      const user = userEvent.setup();
      render(<SessionTable />);
      terminate();

      expect(webhooks()).toBeDisabled();
      expect(webhooks()).toHaveAttribute(
        'title',
        'webhooks has terminated — its process is gone',
      );

      await user.click(webhooks());
      expect(useUiStore.getState().activeTab).toBe('orch');
    });

    it('leaves every other row clickable', async () => {
      const user = userEvent.setup();
      render(<SessionTable />);
      terminate();

      const heroRefresh = rows().find((row) =>
        row.textContent?.includes('hero-refresh'),
      );
      await user.click(heroRefresh!);

      expect(useUiStore.getState().activeTab).toBe('hero-refresh');
    });
  });

  it('shows a newly spawned session immediately', () => {
    render(<SessionTable />);
    expect(rows()).toHaveLength(10);

    act(() => {
      useHiveStore.getState().spawnSession('apfm-web', 'a new thing');
    });

    expect(rows()).toHaveLength(11);
  });
});

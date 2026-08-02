import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ProjectsPanel } from '@features/projects/components/projects-panel';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

/** The five fixture projects, in fixture order, with their live-session counts. */
const FIXTURE_PROJECTS = [
  ['apfm-web', 3],
  ['referral-api', 3],
  ['advisor-portal', 1],
  ['design-system', 1],
  ['infra-terraform', 0],
] as const;

const projectToggle = (id: string) =>
  screen.getByRole('button', { name: new RegExp(`^${id}`) });

describe('ProjectsPanel', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });

  it('renders every fixture project, in fixture order', () => {
    render(<ProjectsPanel />);

    const names = screen
      .getAllByRole('button', { expanded: true })
      .map((row) => row.textContent?.match(/^[a-z-]+/)?.[0]);

    expect(names).toEqual(FIXTURE_PROJECTS.map(([id]) => id));
  });

  /**
   * The ticket's acceptance criteria say apfm-web has 2 active sessions. The
   * fixtures give it three — hero-refresh (working), lead-form (waiting), and
   * e2e-quote (idle). The code is the source of truth; see the UPDATED SPECS
   * note on HIVE-17.
   */
  it.each(FIXTURE_PROJECTS)('shows %s with %i live sessions', (id, count) => {
    render(<ProjectsPanel />);

    expect(projectToggle(id)).toHaveAccessibleName(
      `${id} ${count} active session${count === 1 ? '' : 's'}`,
    );
  });

  it('excludes done sessions from the counts and the tree', () => {
    render(<ProjectsPanel />);

    // tz-fix (advisor-portal) and ecs-scaling (infra-terraform) are done.
    expect(screen.queryByText('tz-fix')).not.toBeInTheDocument();
    expect(screen.queryByText('ecs-scaling')).not.toBeInTheDocument();
    expect(projectToggle('infra-terraform')).toHaveAccessibleName(
      'infra-terraform 0 active sessions',
    );
  });

  /** The story's empty state: the row stays, the pill reads 0, no children. */
  it('renders a project with no live sessions as a childless row', () => {
    render(<ProjectsPanel />);

    const row = projectToggle('infra-terraform');
    expect(row).toBeInTheDocument();
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(row.parentElement?.querySelectorAll('button')).toHaveLength(1);
  });

  it('starts expanded and hides the children once collapsed', async () => {
    render(<ProjectsPanel />);

    expect(screen.getByText('hero-refresh')).toBeInTheDocument();

    await userEvent.click(projectToggle('apfm-web'));

    expect(screen.queryByText('hero-refresh')).not.toBeInTheDocument();
    expect(projectToggle('apfm-web')).toHaveAttribute('aria-expanded', 'false');
    // Its siblings are unaffected.
    expect(screen.getByText('webhooks')).toBeInTheDocument();
  });

  /**
   * The AC that justifies keeping `collapsed` in the store: the panel unmounts
   * whenever the user visits another left-rail tab, so component state would
   * forget the tree on the way back.
   */
  it('remembers collapsed projects across an unmount', async () => {
    const { unmount } = render(<ProjectsPanel />);

    await userEvent.click(projectToggle('apfm-web'));
    unmount();
    render(<ProjectsPanel />);

    expect(projectToggle('apfm-web')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('hero-refresh')).not.toBeInTheDocument();
  });

  it('shows a newly spawned session under its project immediately', () => {
    render(<ProjectsPanel />);

    expect(projectToggle('design-system')).toHaveAccessibleName(
      'design-system 1 active session',
    );

    act(() => {
      useHiveStore.getState().spawnSession('design-system', 'new work');
    });

    expect(projectToggle('design-system')).toHaveAccessibleName(
      'design-system 2 active sessions',
    );
  });

  /**
   * Story 014 fences this at lint time; asserting it here makes the intent
   * explicit — the panel reads derived state through selectors only.
   */
  it('reads the store, never the fixtures', () => {
    render(<ProjectsPanel />);

    act(() => {
      useHiveStore.setState({ projects: [{ id: 'solo', icon: 'ph-cube' }] });
    });

    expect(projectToggle('solo')).toBeInTheDocument();
    expect(screen.queryByText('apfm-web')).not.toBeInTheDocument();
  });
});

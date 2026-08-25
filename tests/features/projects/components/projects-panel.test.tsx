import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectsPanel } from '@features/projects/components/projects-panel';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet, seedDemoProjectConfig } from '@tests/support/demo-fleet';
import { emptySnapshot } from '@shared/config-contract';

/** The five demo projects, in config order, with their live-session counts. */
const FIXTURE_PROJECTS = [
  ['nova-web', 3],
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
    seedDemoFleet();
    /**
     * The panel lists the *config's* projects and nothing else now. The store's
     * `projects` slice used to double as a fallback whenever the config was
     * empty, which is why this test never had to declare one; that fallback was
     * the seeded demo data and it is gone.
     */
    seedDemoProjectConfig();
    useUiStore.getState().reset();
  });

  afterEach(() => {
    resetProjectConfig();
  });

  /**
   * The state a fresh install actually opens in — no config, so no projects.
   *
   * Unaskable before: the store seeded five projects and fell back to them
   * whenever the config had none, so this panel was never empty and the copy
   * below could not have existed.
   */
  it('says why it is empty when the config declares no projects', () => {
    setProjectConfigForTest(emptySnapshot('/tmp/hive/config.json'));

    render(<ProjectsPanel />);

    expect(screen.getByText(/No projects mapped/i)).toBeInTheDocument();
    expect(screen.getByText('Settings → Projects')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders every configured project, in config order', () => {
    render(<ProjectsPanel />);

    const names = screen
      .getAllByRole('button', { expanded: true })
      .map((row) => row.textContent?.match(/^[a-z-]+/)?.[0]);

    expect(names).toEqual(FIXTURE_PROJECTS.map(([id]) => id));
  });

  /**
   * The ticket's acceptance criteria say nova-web has 2 active sessions. The
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

  /**
   * The story's empty state: the row stays, the pill reads 0, no session rows.
   *
   * This counted *buttons* until the tree grew a start link, which made the
   * count 2 and the name "childless" wrong. Both were only ever standing in for
   * the real claim — that no session is listed under a project running none —
   * so the assertion now makes that claim directly instead of by arithmetic.
   */
  it('lists no sessions under a project running none', () => {
    render(<ProjectsPanel />);

    const row = projectToggle('infra-terraform');
    expect(row).toBeInTheDocument();
    expect(row).toHaveAttribute('aria-expanded', 'true');

    const children = [...(row.parentElement?.children ?? [])].filter(
      (child) => child !== row,
    );
    expect(children).toHaveLength(1);
    expect(children[0]).toHaveAccessibleName('New session in infra-terraform');
  });

  it('starts expanded and hides the children once collapsed', async () => {
    render(<ProjectsPanel />);

    expect(screen.getByText('hero-refresh')).toBeInTheDocument();

    await userEvent.click(projectToggle('nova-web'));

    expect(screen.queryByText('hero-refresh')).not.toBeInTheDocument();
    expect(projectToggle('nova-web')).toHaveAttribute('aria-expanded', 'false');
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

    await userEvent.click(projectToggle('nova-web'));
    unmount();
    render(<ProjectsPanel />);

    expect(projectToggle('nova-web')).toHaveAttribute('aria-expanded', 'false');
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
   * The panel follows the config, and only the config.
   *
   * This used to write to the store's `projects` slice and assert the row
   * appeared, because that slice was what the rail fell back to. It is the
   * config that decides now, so the assertion moved with the authority — and
   * the second half is the one that matters: replacing the config replaces the
   * list, with nothing lingering from the old one.
   */
  it('follows the config, and drops projects it no longer declares', () => {
    render(<ProjectsPanel />);
    expect(projectToggle('nova-web')).toBeInTheDocument();

    act(() => {
      setProjectConfigForTest({
        ...emptySnapshot('/tmp/hive/config.json'),
        projects: [
          {
            id: 'solo',
            name: 'solo',
            path: '/repos/solo',
            icon: 'ph-cube',
            origin: 'local',
            status: 'ok',
            key: 'solo',
            isRepo: true,
          },
        ],
      });
    });

    expect(projectToggle('solo')).toBeInTheDocument();
    expect(screen.queryByText('nova-web')).not.toBeInTheDocument();
  });

  /**
   * A renamed project, end to end through the panel (HIVE-104).
   *
   * `seedDemoProjectConfig` sets every `name` to its `id`, exactly as
   * `addProject` does for a freshly mapped directory — which is why this bug
   * survived so long and why the whole suite above cannot see it. This is the
   * one test that hands the panel a snapshot where the two disagree.
   *
   * Driven by replacing the snapshot rather than by calling `renameProject`,
   * because that is what a rename *arrives* as: main writes the file and
   * returns a new snapshot, `mutate` installs it, and `useProjects()`
   * re-derives. No restart, no remount — the rail simply repaints.
   */
  it('repaints a renamed project under its new name', () => {
    render(<ProjectsPanel />);
    expect(projectToggle('design-system')).toBeInTheDocument();

    act(() => {
      setProjectConfigForTest({
        ...emptySnapshot('/tmp/hive/config.json'),
        projects: [
          {
            id: 'design-system',
            // The rename writes this and leaves `id` alone, because `id` is
            // what every live session's `entity.project` points at.
            name: 'Design System',
            path: '/repos/design-system',
            icon: 'ph-cube',
            origin: 'local',
            status: 'ok',
            key: 'ds',
            isRepo: true,
          },
        ],
      });
    });

    expect(screen.getByText('Design System')).toBeInTheDocument();
    expect(screen.queryByText('design-system')).not.toBeInTheDocument();
  });

  /*
   * There was a test here asserting the panel ignored the store's `projects`
   * slice — the thing that used to put five unmapped repositories in a fresh
   * install. The slice itself is gone now, so the compiler enforces what this
   * asserted at runtime: `useHiveStore.setState({ projects: … })` no longer
   * type-checks. A test that cannot express its own failure case is not a test.
   */
});

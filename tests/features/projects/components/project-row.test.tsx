import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_JIRA,
  DEFAULT_NOTIFICATIONS,
  type ConfigSnapshot,
  type ProjectStatus,
} from '@shared/config-contract';

import { ProjectRow } from '@features/projects/components/project-row';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

import { testProjectKey } from '@tests/support/project-key';

/**
 * The unmapped badge (story 090).
 *
 * `Tag`, not `Badge`: `Badge` takes a `count` and renders nothing at zero, so
 * it cannot carry a word. See the story's UPDATED SPECS note — the ticket said
 * "reuse badge.tsx", the code said `Badge` is a counter, and the code won.
 */

const CONFIG_PATH = '/home/dev/.hive/config.json';

/**
 * `name` disagrees with `id` on purpose (HIVE-104).
 *
 * `addProject` derives both from the same directory basename, so an
 * un-renamed project reads identically either way — which is how the rail drew
 * `id` this long without anyone noticing. A fixture whose handles agree cannot
 * tell a name match from an id match, so this one's do not.
 */
const PROJECT = {
  id: 'nova-web',
  name: 'NOVA Web',
  key: testProjectKey('nova-web'),
  icon: 'ph-globe-hemisphere-west',
};

function snapshot(projects: { id: string; status: ProjectStatus }[]): ConfigSnapshot {
  return {
    configPath: CONFIG_PATH,
    templateWritten: false,
    shell: '/bin/zsh',
    claudeCommand: 'claude',
    env: {},
    projects: projects.map(({ id, status }) => ({
      id,
      path: status === 'ok' ? `/repos/${id}` : null,
      name: id,
      icon: 'ph-folder',
      origin: 'local' as const,
      status,
      key: testProjectKey(id),
      isRepo: true,
    })),
    notifications: { ...DEFAULT_NOTIFICATIONS },
    jira: { ...DEFAULT_JIRA },
    subscriptionAuth: true,
  sessionMetrics: true,
  importLoginEnv: true,
    errors: [],
  };
}

beforeEach(() => {
  useHiveStore.getState().reset();
    seedDemoFleet();
  useUiStore.getState().reset();
  resetProjectConfig();
});

afterEach(() => {
  resetProjectConfig();
});

describe('ProjectRow', () => {
  /**
   * The regression HIVE-104 exists for.
   *
   * A rename writes `name` and leaves `id` alone — `id` is the stable key
   * `entity.project` points at, and rewriting it would strand every session.
   * So the rename was always correct at every layer and the rail was simply
   * reading the wrong field, permanently, across restarts.
   *
   * Both halves are asserted. "Shows the name" alone would pass a row that
   * printed both.
   */
  describe('the label', () => {
    it('is the display name', () => {
      setProjectConfigForTest(snapshot([{ id: 'nova-web', status: 'ok' }]));

      render(<ProjectRow project={PROJECT} />);

      expect(screen.getByText('NOVA Web')).toBeInTheDocument();
    });

    it('is not the id', () => {
      setProjectConfigForTest(snapshot([{ id: 'nova-web', status: 'ok' }]));

      render(<ProjectRow project={PROJECT} />);

      expect(screen.queryByText('nova-web')).not.toBeInTheDocument();
    });

    it('carries no key chip — the rail is the quiet surface', () => {
      setProjectConfigForTest(snapshot([{ id: 'nova-web', status: 'ok' }]));

      render(<ProjectRow project={PROJECT} />);

      // Settings and the picker both show the alias; the rail deliberately
      // does not, which is the design call HIVE-104 settled.
      expect(screen.queryByText(PROJECT.key)).not.toBeInTheDocument();
    });
  });

  it('shows no badge with no config — the browser demo is unchanged', () => {
    render(<ProjectRow project={PROJECT} />);

    expect(screen.queryByText('unmapped')).not.toBeInTheDocument();
  });

  it('shows no badge for a project that resolves', () => {
    setProjectConfigForTest(snapshot([{ id: 'nova-web', status: 'ok' }]));

    render(<ProjectRow project={PROJECT} />);

    expect(screen.queryByText('unmapped')).not.toBeInTheDocument();
  });

  it('marks a project the config never mentions, and names the file in the tooltip', () => {
    setProjectConfigForTest(snapshot([{ id: 'referral-api', status: 'ok' }]));

    render(<ProjectRow project={PROJECT} />);

    const badge = screen.getByText('unmapped');
    expect(badge).toHaveAttribute('title', expect.stringContaining(CONFIG_PATH));
    // Muted — a thing the user has not done yet, not a thing they did wrong.
    expect(badge).toHaveClass('text-subtle');
  });

  it('marks a broken entry in amber, with its reason verbatim', () => {
    setProjectConfigForTest(snapshot([{ id: 'nova-web', status: 'missing' }]));

    render(<ProjectRow project={PROJECT} />);

    const badge = screen.getByText('unmapped');
    expect(badge).toHaveClass('text-amber');
    expect(badge).toHaveAttribute('title', expect.stringContaining('missing'));
  });

  it('still renders the session count and stays expandable while unmapped', () => {
    setProjectConfigForTest(snapshot([]));

    render(<ProjectRow project={PROJECT} />);

    // nova-web has three live fixture sessions; being unmapped changes what a
    // user can *start*, not what the rail reports about what is running.
    //
    // "unmapped" lands inside the row's accessible name on purpose. The badge
    // is the only signal that this project cannot host a session, and a
    // screen-reader user who never hears it is exactly the user who will be
    // surprised when the picker refuses.
    expect(
      screen.getByRole('button', { expanded: true }),
    ).toHaveAccessibleName('NOVA Web unmapped 3 active sessions');
  });

  /**
   * Where the start link sits (this job).
   *
   * Placement is the whole feature: "under the project" and "under its last
   * session" are one rule — last child of the expanded region — and asserting
   * the link merely *exists* would pass for a link rendered above the sessions
   * or beside the folder name.
   */
  describe('the new-session link', () => {
    const LINK = 'New session in NOVA Web';

    it('follows the last session', () => {
      setProjectConfigForTest(snapshot([{ id: 'nova-web', status: 'ok' }]));

      const { container } = render(<ProjectRow project={PROJECT} />);

      const rows = container.firstElementChild;
      // Header button, three fixture sessions, then the link.
      expect(rows?.children).toHaveLength(5);
      expect(rows?.lastElementChild).toHaveAccessibleName(LINK);
    });

    it('sits directly under a project with nothing running', () => {
      useHiveStore.getState().reset();
      setProjectConfigForTest(snapshot([{ id: 'nova-web', status: 'ok' }]));

      const { container } = render(<ProjectRow project={PROJECT} />);

      const rows = container.firstElementChild;
      expect(rows?.children).toHaveLength(2);
      expect(rows?.lastElementChild).toHaveAccessibleName(LINK);
    });

    it('is gone when the project is collapsed', async () => {
      setProjectConfigForTest(snapshot([{ id: 'nova-web', status: 'ok' }]));

      render(<ProjectRow project={PROJECT} />);
      await userEvent.click(screen.getByRole('button', { expanded: true }));

      // A collapsed row is a summary; its count pill already says what is
      // running inside it.
      expect(screen.queryByRole('button', { name: LINK })).not.toBeInTheDocument();
    });
  });
});

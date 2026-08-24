import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSession } from '@/types/entity';

import {
  DEFAULT_JIRA,
  DEFAULT_NOTIFICATIONS,
  type ConfigSnapshot,
  type ProjectStatus,
} from '@shared/config-contract';

import { NewSessionLink } from '@features/projects/components/new-session-link';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

import { testProjectKey } from '@tests/support/project-key';

/**
 * Starting a session from the projects tree.
 *
 * These assert against the **real** stores rather than a mocked `spawnSession`:
 * what the link owes the user is a session on the right project with the right
 * model and effort, and only the entity the store actually created can prove
 * that. A spy would prove the arguments and nothing about the result.
 */

const CONFIG_PATH = '/home/dev/.hive/config.json';
const PROJECT = 'apfm-web';

function snapshot(
  projects: { id: string; status: ProjectStatus }[],
): ConfigSnapshot {
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

/** The session the click just created, as the store recorded it. */
function lastSession() {
  const { order, entities } = useHiveStore.getState();
  const id = order.at(-1);
  const entity = id === undefined ? undefined : entities[id];
  if (entity === undefined || !isSession(entity)) {
    throw new Error('no session was created');
  }
  return entity;
}

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
  resetProjectConfig();
});

afterEach(() => {
  resetProjectConfig();
});

describe('NewSessionLink', () => {
  it('spawns on its own project, with an empty task', async () => {
    setProjectConfigForTest(snapshot([{ id: PROJECT, status: 'ok' }]));
    render(<NewSessionLink projectId={PROJECT} />);

    await userEvent.click(screen.getByRole('button'));

    const session = lastSession();
    expect(session.project).toBe(PROJECT);
    // Empty, not a placeholder: the session opens ready and the first message
    // gives it its job — exactly what the picker does.
    expect(session.task).toBe('');
  });

  it('starts on the current defaults, not the seeded ones', async () => {
    setProjectConfigForTest(snapshot([{ id: PROJECT, status: 'ok' }]));
    // What the picker's steppers write. The store seeds opus/high, so a link
    // that ignored these would still look right against the defaults — which is
    // the whole reason this test moves them first.
    useUiStore.getState().setNewModel('sonnet');
    useUiStore.getState().setNewEffort('low');

    render(<NewSessionLink projectId={PROJECT} />);
    await userEvent.click(screen.getByRole('button'));

    const session = lastSession();
    expect(session.model).toBe('sonnet');
    expect(session.effort).toBe('low');
  });

  it('opens the new session, the way every other spawn does', async () => {
    setProjectConfigForTest(snapshot([{ id: PROJECT, status: 'ok' }]));
    render(<NewSessionLink projectId={PROJECT} />);

    await userEvent.click(screen.getByRole('button'));

    expect(useUiStore.getState().activeTab).toBe(lastSession().id);
  });

  it('names its project in the accessible name', () => {
    render(<NewSessionLink projectId={PROJECT} />);

    /**
     * The visible label is just `new session`. A screen-reader user arriving
     * here out of context cannot see the folder row above it, so the project
     * has to be in the name — and it contains the visible text, which is what
     * WCAG's Label in Name asks for.
     *
     * The *other* consequence — that `New session` alone stops identifying one
     * control — is a Playwright problem, not a jsdom one: Testing Library
     * matches a string name in full, Playwright matches a substring. It is
     * asserted where it bites, in `tests/e2e/electron/projects-tree.spec.ts`.
     */
    expect(screen.getByRole('button')).toHaveAccessibleName(
      'New session in apfm-web',
    );
  });

  it('refuses a project the config never mentions, and says why', async () => {
    setProjectConfigForTest(snapshot([{ id: 'referral-api', status: 'ok' }]));
    render(<NewSessionLink projectId={PROJECT} />);

    const link = screen.getByRole('button');
    expect(link).toBeDisabled();
    expect(link).toHaveAttribute('title', expect.stringContaining(CONFIG_PATH));

    await userEvent.click(link);
    expect(useHiveStore.getState().order).toHaveLength(0);
  });

  it('refuses a broken entry, with its reason verbatim', () => {
    setProjectConfigForTest(snapshot([{ id: PROJECT, status: 'missing' }]));
    render(<NewSessionLink projectId={PROJECT} />);

    const link = screen.getByRole('button');
    expect(link).toBeDisabled();
    expect(link).toHaveAttribute('title', expect.stringContaining('missing'));
  });

  it('says what it is about to start on', () => {
    setProjectConfigForTest(snapshot([{ id: PROJECT, status: 'ok' }]));
    useUiStore.getState().setNewModel('haiku');
    useUiStore.getState().setNewEffort('max');

    render(<NewSessionLink projectId={PROJECT} />);

    // The steppers that decide this live in the picker, and the picker is not
    // open. Without the tooltip the click commits to a model the user cannot
    // see from here.
    expect(screen.getByRole('button')).toHaveAttribute(
      'title',
      'Starts on haiku · max',
    );
  });

  /**
   * `projectAccess` answers "spawnable" while no snapshot has arrived, and this
   * pins that default — but note what it is *not* evidence of. The component
   * never renders in that state: `useProjects()` returns `[]` with no snapshot,
   * so there is no `ProjectRow` to hang a link on, in the browser target (which
   * has no config at all) or in the first frames of a desktop launch.
   *
   * It is here because the permissive default is the one that would spawn into
   * an unresolved directory if a future caller mounted this component outside
   * the tree. Asserting it costs a line; discovering it costs a bug.
   */
  it('defaults to enabled before any config has arrived', () => {
    render(<NewSessionLink projectId={PROJECT} />);

    expect(screen.getByRole('button')).toBeEnabled();
  });
});

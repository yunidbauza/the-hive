import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  emptySnapshot,
  type ConfigSnapshot,
  type ProjectConfig,
} from '@shared/config-contract';

import { ProjectsSection } from '@features/settings/components/projects-section';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

const chooseProjectDirectory = vi.fn();
const addProjectToConfig = vi.fn();
const removeProjectFromConfig = vi.fn();

vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return {
    ...actual,
    chooseProjectDirectory: () => chooseProjectDirectory(),
    addProjectToConfig: (request: unknown) => addProjectToConfig(request),
    removeProjectFromConfig: (request: unknown) => removeProjectFromConfig(request),
  };
});

/** A resolved v2 entry, with only the interesting fields varying. */
const entry = (over: Partial<ProjectConfig> & { id: string }): ProjectConfig => ({
  name: over.id,
  path: `/repos/${over.id}`,
  icon: 'ph-folder',
  origin: 'local',
  status: 'ok',
  isRepo: true,
  ...over,
});

const seed = (projects: ProjectConfig[], errors: string[] = []): void => {
  const snapshot: ConfigSnapshot = {
    ...emptySnapshot('/tmp/hive/config.json'),
    projects,
    errors,
  };
  setProjectConfigForTest(snapshot);
};

/**
 * The Projects section (story 101).
 *
 * The behaviour under test is the round trip the story is named for: choose a
 * directory, write it, see it. The dialog is mocked because it is a main-process
 * capability — what matters here is that the renderer asks for a path and never
 * invents one.
 */
describe('ProjectsSection', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
    resetProjectConfig();
    vi.clearAllMocks();
    chooseProjectDirectory.mockResolvedValue(null);
    addProjectToConfig.mockResolvedValue(undefined);
    removeProjectFromConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetProjectConfig();
  });

  it('lists the projects the config declares', () => {
    seed([entry({ id: 'the-hive', name: 'The Hive' })]);

    render(<ProjectsSection />);

    expect(screen.getByText('The Hive')).toBeInTheDocument();
    expect(screen.getByText('/repos/the-hive')).toBeInTheDocument();
  });

  /**
   * Settings lists what the user owns, not the merged list the rails use.
   *
   * The merge rule keeps fixture projects alive for the rails, because the work
   * panel and `resolve-transport` reach sessions through `entity.project`.
   * Listing them *here* would open a fresh install on five rows the user did
   * not add and cannot remove, and would make the empty state unreachable.
   */
  it('does not list demo projects as rows', () => {
    seed([entry({ id: 'the-hive', name: 'The Hive' })]);

    render(<ProjectsSection />);

    expect(screen.queryByText('demo')).not.toBeInTheDocument();
    expect(screen.queryByText('apfm-web')).not.toBeInTheDocument();
  });

  it('accounts for the demo projects in one line instead', () => {
    seed([entry({ id: 'the-hive' })]);

    render(<ProjectsSection />);

    // The user can still tell where the rail's other projects come from.
    expect(
      screen.getByText(/demo projects from the sample data also appear/i),
    ).toBeInTheDocument();
  });

  it('names the config file', () => {
    seed([]);

    render(<ProjectsSection />);

    expect(screen.getByText(/\/tmp\/hive\/config\.json/)).toBeInTheDocument();
  });

  describe('adding', () => {
    it('calls chooseDirectory then addProject with the returned path', async () => {
      const user = userEvent.setup();
      seed([entry({ id: 'the-hive' })]);
      chooseProjectDirectory.mockResolvedValue('/tmp/picked');

      render(<ProjectsSection />);
      await user.click(screen.getByRole('button', { name: /add project/i }));

      expect(chooseProjectDirectory).toHaveBeenCalledTimes(1);
      expect(addProjectToConfig).toHaveBeenCalledWith({ path: '/tmp/picked' });
    });

    it('writes nothing when the dialog is cancelled', async () => {
      const user = userEvent.setup();
      seed([entry({ id: 'the-hive' })]);
      chooseProjectDirectory.mockResolvedValue(null);

      render(<ProjectsSection />);
      await user.click(screen.getByRole('button', { name: /add project/i }));

      expect(chooseProjectDirectory).toHaveBeenCalledTimes(1);
      // No write, and no error: the user closed a dialog they opened.
      expect(addProjectToConfig).not.toHaveBeenCalled();
    });

    it('never invents a path of its own', async () => {
      const user = userEvent.setup();
      seed([]);
      chooseProjectDirectory.mockResolvedValue('/tmp/picked');

      render(<ProjectsSection />);
      await user.click(screen.getByRole('button', { name: /add project/i }));

      // The only path that reaches main is the one the dialog returned.
      expect(addProjectToConfig).toHaveBeenCalledWith({ path: '/tmp/picked' });
    });
  });

  describe('the empty state', () => {
    it('shows a bordered empty state when the config declares no projects', () => {
      // The fixtures are left alone: this is the real fresh-install screen, and
      // demo projects must not stand in the way of it.
      seed([]);

      render(<ProjectsSection />);

      expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
      expect(screen.getByText(/add a folder to start a session/i)).toBeInTheDocument();
    });

    it('still offers Add project when empty', () => {
      seed([]);

      render(<ProjectsSection />);

      expect(screen.getByRole('button', { name: /add project/i })).toBeEnabled();
    });
  });

  describe('errors', () => {
    it('renders the reason from an error snapshot', () => {
      seed(
        [entry({ id: 'the-hive' })],
        ['config: cannot add /tmp/notes.txt (not-a-directory)'],
      );

      render(<ProjectsSection />);

      expect(screen.getByText(/not-a-directory/)).toBeInTheDocument();
      expect(screen.getByText(/notes\.txt/)).toBeInTheDocument();
    });
  });

  describe('removing', () => {
    it('removes a config project that owns no live sessions', async () => {
      const user = userEvent.setup();
      seed([entry({ id: 'the-hive', name: 'The Hive' })]);

      render(<ProjectsSection />);
      await user.click(screen.getByRole('button', { name: 'Remove The Hive' }));

      expect(removeProjectFromConfig).toHaveBeenCalledWith({ id: 'the-hive' });
    });

    it('disables remove for a config project that owns live sessions', () => {
      // The fixtures already run live sessions on apfm-web, so declaring it in
      // the config produces a row that owns live sessions — the case story 103
      // will unlock with a confirmation flow.
      seed([entry({ id: 'apfm-web', name: 'APFM' })]);

      render(<ProjectsSection />);

      const remove = screen.getByRole('button', { name: 'Remove APFM' });
      expect(remove).toBeDisabled();
      expect(remove).toHaveAttribute('title', expect.stringMatching(/live sessions/));
    });
  });

  describe('the no-git tag', () => {
    it('tags a directory that is not a git repository', () => {
      seed([entry({ id: 'scratch', isRepo: false })]);

      render(<ProjectsSection />);

      expect(screen.getByText('no git')).toBeInTheDocument();
    });

    it('does not tag a directory that is one', () => {
      seed([entry({ id: 'the-hive', isRepo: true })]);

      render(<ProjectsSection />);

      expect(screen.queryByText('no git')).not.toBeInTheDocument();
    });
  });
});

describe('cloning a repository (story 102)', () => {
  it('swaps the pane for the clone view', async () => {
    seed([]);
    const user = userEvent.setup();
    render(<ProjectsSection />);

    await user.click(screen.getByRole('button', { name: /clone from url/i }));

    expect(screen.getByLabelText(/repository url/i)).toBeInTheDocument();
    // The list is gone: cloning owns the pane while it runs.
    expect(
      screen.queryByRole('button', { name: /add project/i }),
    ).not.toBeInTheDocument();
  });

  it('comes back to the list', async () => {
    seed([]);
    const user = userEvent.setup();
    render(<ProjectsSection />);

    await user.click(screen.getByRole('button', { name: /clone from url/i }));
    await user.click(screen.getByRole('button', { name: /projects/i }));

    expect(
      screen.getByRole('button', { name: /add project/i }),
    ).toBeInTheDocument();
  });
});

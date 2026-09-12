import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptySnapshot } from '@shared/config-contract';
import type { SkillsSnapshot } from '@shared/skills-contract';

import { namesFit, SessionPluginsRow } from '@features/settings/components/session-plugins-row';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';

const setSessionPluginInConfig = vi.fn();
let skills: SkillsSnapshot | null = null;

vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return {
    ...actual,
    setSessionPluginInConfig: (request: unknown) => setSessionPluginInConfig(request),
  };
});

vi.mock('@/hooks/use-skills', () => ({ useSkills: () => skills }));

const withPlugins = (plugins: string[] | undefined): SkillsSnapshot => ({
  skills: [],
  invalid: [],
  skillsRoot: '/home/me/.hive/skills',
  ...(plugins === undefined ? {} : { plugins }),
});

const disable = (names: string[]): void =>
  setProjectConfigForTest({ ...emptySnapshot('/tmp/config.json'), disabledSessionPlugins: names });

const manage = () => userEvent.click(screen.getByRole('button', { name: 'Manage Installed Plugins' }));

beforeEach(() => {
  setSessionPluginInConfig.mockReset();
  disable(['workstream', 'superpowers']);
});

afterEach(() => {
  resetProjectConfig();
  skills = null;
});

describe('namesFit (HIVE-177)', () => {
  it('names up to three short plugins, and counts past three or past the width', () => {
    expect(namesFit(['workstream', 'superpowers'])).toBe(true);
    expect(namesFit(['code-review', 'context7', 'github'])).toBe(true);
    expect(namesFit(['code-review', 'context7', 'github', 'slack'])).toBe(false);
    expect(namesFit(['svg-logo-designer', 'ui-ux-pro-max', 'frontend-design'])).toBe(false);
  });
});

describe('SessionPluginsRow (HIVE-176, HIVE-177)', () => {
  it('names the installed plugins that are off, and skips one the config names but is not installed', () => {
    skills = withPlugins(['jira-writer', 'workstream']);
    render(<SessionPluginsRow />);

    expect(screen.getByText('Off in Hive sessions:')).toBeInTheDocument();
    expect(screen.getByText('workstream')).toBeInTheDocument();
    // The count is there too, for a row too narrow to name them.
    expect(screen.getByText('1 plugin')).toHaveClass('@min-[620px]:hidden');
    expect(screen.queryByText('superpowers')).not.toBeInTheDocument();
    expect(screen.queryByText('jira-writer')).not.toBeInTheDocument();
  });

  it('counts the off plugins in one chip once their names would not fit', () => {
    const many = ['code-review', 'context7', 'github', 'slack'];
    skills = withPlugins([...many, 'vercel']);
    disable(many);
    render(<SessionPluginsRow />);

    const chip = screen.getByText('4 plugins');
    expect(chip).toHaveAttribute('title', 'code-review, context7, github, slack');
    expect(screen.queryByText('context7')).not.toBeInTheDocument();
  });

  it('says none when every plugin loads', () => {
    skills = withPlugins(['jira-writer']);
    render(<SessionPluginsRow />);
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('opens a dialog of switches, each sending its own plugin both ways', async () => {
    skills = withPlugins(['jira-writer', 'workstream']);
    render(<SessionPluginsRow />);
    await manage();

    const dialog = screen.getByRole('dialog', { name: 'Manage Installed Plugins' });
    expect(within(dialog).getByRole('switch', { name: 'jira-writer' })).toHaveAttribute('aria-checked', 'true');
    const workstream = within(dialog).getByRole('switch', { name: 'workstream' });
    expect(workstream).toHaveAttribute('aria-checked', 'false');
    expect(workstream).toHaveAccessibleDescription("Off by default: its skills duplicate the Hive's.");

    await userEvent.click(within(dialog).getByRole('switch', { name: 'jira-writer' }));
    expect(setSessionPluginInConfig).toHaveBeenLastCalledWith({ plugin: 'jira-writer', off: true });
    await userEvent.click(workstream);
    expect(setSessionPluginInConfig).toHaveBeenLastCalledWith({ plugin: 'workstream', off: false });
  });

  it('filters the switches, says when nothing matches, and clears the filter on close', async () => {
    skills = withPlugins(['jira-writer', 'workstream']);
    render(<SessionPluginsRow />);
    await manage();

    const filter = screen.getByLabelText('Filter plugins');
    await userEvent.type(filter, 'JIRA');
    expect(screen.getByRole('switch', { name: 'jira-writer' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'workstream' })).not.toBeInTheDocument();

    await userEvent.clear(filter);
    await userEvent.type(filter, 'nope');
    expect(screen.getByText('No plugin matches “nope”.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Focus goes back to the button that opened it, not to <body>.
    expect(screen.getByRole('button', { name: 'Manage Installed Plugins' })).toHaveFocus();
    await manage();
    expect(screen.getByLabelText('Filter plugins')).toHaveValue('');
  });

  it('says so when no plugin is installed, and renders nothing without a registry', () => {
    skills = withPlugins([]);
    const { unmount } = render(<SessionPluginsRow />);
    expect(screen.getByText('No Claude Code plugins are installed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage Installed Plugins' })).not.toBeInTheDocument();
    unmount();

    skills = withPlugins(undefined);
    const { container } = render(<SessionPluginsRow />);
    expect(container).toBeEmptyDOMElement();
  });
});

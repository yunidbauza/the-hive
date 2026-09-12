import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptySnapshot } from '@shared/config-contract';
import type { SkillsSnapshot } from '@shared/skills-contract';

import { SessionPluginsGroup } from '@features/settings/components/session-plugins-group';
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

beforeEach(() => {
  setSessionPluginInConfig.mockReset();
  setProjectConfigForTest({ ...emptySnapshot('/tmp/config.json'), disabledSessionPlugins: ['workstream'] });
});

afterEach(() => {
  resetProjectConfig();
  skills = null;
});

describe('SessionPluginsGroup (HIVE-176)', () => {
  it('shows one switch per installed plugin, off for the ones sessions do not load', () => {
    skills = withPlugins(['jira-writer', 'workstream']);
    render(<SessionPluginsGroup />);

    expect(screen.getByRole('switch', { name: 'jira-writer' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'workstream' })).toHaveAttribute('aria-checked', 'false');
  });

  it('sends the one plugin its switch names, both ways', async () => {
    skills = withPlugins(['jira-writer', 'workstream']);
    render(<SessionPluginsGroup />);

    await userEvent.click(screen.getByRole('switch', { name: 'jira-writer' }));
    expect(setSessionPluginInConfig).toHaveBeenLastCalledWith({ plugin: 'jira-writer', off: true });

    await userEvent.click(screen.getByRole('switch', { name: 'workstream' }));
    expect(setSessionPluginInConfig).toHaveBeenLastCalledWith({ plugin: 'workstream', off: false });
  });

  it('says so when no plugin is installed, and renders nothing without a registry', () => {
    skills = withPlugins([]);
    const { unmount } = render(<SessionPluginsGroup />);
    expect(screen.getByText('No Claude Code plugins are installed.')).toBeInTheDocument();
    unmount();

    skills = withPlugins(undefined);
    const { container } = render(<SessionPluginsGroup />);
    expect(container).toBeEmptyDOMElement();
  });
});

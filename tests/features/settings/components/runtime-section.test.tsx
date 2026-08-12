import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  emptySnapshot,
  type CommandDiagnostic,
  type ConfigSnapshot,
  type ProjectConfig,
} from '@shared/config-contract';

import { RuntimeSection } from '@features/settings/components/runtime-section';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';

const setRuntimeConfig = vi.fn();
const setProjectRuntimeConfig = vi.fn();
const diagnoseAgentCommand = vi.fn();

vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return {
    ...actual,
    setRuntimeConfig: (request: unknown) => setRuntimeConfig(request),
    setProjectRuntimeConfig: (request: unknown) => setProjectRuntimeConfig(request),
    diagnoseAgentCommand: (request: unknown) => diagnoseAgentCommand(request),
  };
});

const entry = (over: Partial<ProjectConfig> & { id: string }): ProjectConfig => ({
  name: over.id,
  path: `/repos/${over.id}`,
  icon: 'ph-folder',
  origin: 'local',
  status: 'ok',
  isRepo: true,
  ...over,
});

const snapshot = (over: Partial<ConfigSnapshot> = {}): ConfigSnapshot => ({
  ...emptySnapshot('/tmp/hive/config.json'),
  shell: '/bin/sh',
  claudeCommand: 'claude',
  ...over,
});

const install = (over: Partial<ConfigSnapshot> = {}) => {
  setProjectConfigForTest(snapshot(over));
};

beforeEach(() => {
  vi.clearAllMocks();
  diagnoseAgentCommand.mockResolvedValue(null);
  resetProjectConfig();
});

afterEach(() => {
  resetProjectConfig();
});

describe('RuntimeSection — defaults', () => {
  it('shows the current shell and command', () => {
    install({ shell: '/bin/zsh', claudeCommand: 'my-claude' });
    render(<RuntimeSection />);

    expect(screen.getByRole('textbox', { name: 'Shell' })).toHaveValue('/bin/zsh');
    expect(screen.getByRole('textbox', { name: 'Agent command' })).toHaveValue(
      'my-claude',
    );
  });

  it('saves a changed shell on Enter', async () => {
    const user = userEvent.setup();
    install();
    render(<RuntimeSection />);

    const field = screen.getByRole('textbox', { name: 'Shell' });
    await user.clear(field);
    await user.type(field, '/bin/zsh{Enter}');

    // Only the field that changed — saving one must not restate the other.
    expect(setRuntimeConfig).toHaveBeenCalledWith({ shell: '/bin/zsh' });
  });

  it('does not write when the value is unchanged', async () => {
    const user = userEvent.setup();
    install({ shell: '/bin/sh' });
    render(<RuntimeSection />);

    await user.type(screen.getByRole('textbox', { name: 'Shell' }), '{Enter}');

    // A whole-file atomic write for a no-op edit is worth avoiding.
    expect(setRuntimeConfig).not.toHaveBeenCalled();
  });

  it('restores rather than writing an empty top-level value', async () => {
    const user = userEvent.setup();
    install({ shell: '/bin/sh' });
    render(<RuntimeSection />);

    const field = screen.getByRole('textbox', { name: 'Shell' });
    await user.clear(field);
    await user.type(field, '{Enter}');

    // There is no lower level to inherit from, and a session with no shell
    // cannot start — so the field snaps back instead of writing "".
    expect(setRuntimeConfig).not.toHaveBeenCalled();
    expect(field).toHaveValue('/bin/sh');
  });
});

describe('RuntimeSection — per-project overrides', () => {
  it('shows nothing until a project is picked', () => {
    install({ projects: [entry({ id: 'apfm-web' })] });
    render(<RuntimeSection />);

    expect(
      screen.queryByRole('textbox', { name: 'Shell override' }),
    ).not.toBeInTheDocument();
  });

  it('shows the inherited value as a placeholder, not a value', async () => {
    const user = userEvent.setup();
    install({ shell: '/bin/sh', projects: [entry({ id: 'apfm-web' })] });
    render(<RuntimeSection />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Project' }),
      'apfm-web',
    );

    const field = screen.getByRole('textbox', { name: 'Shell override' });
    // Empty means "inherit". Pre-filling the inherited value would turn every
    // opened row into an override the moment it was saved.
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', '/bin/sh');
  });

  it('sets an override', async () => {
    const user = userEvent.setup();
    install({ projects: [entry({ id: 'apfm-web' })] });
    render(<RuntimeSection />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Project' }),
      'apfm-web',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Shell override' }),
      '/bin/bash{Enter}',
    );

    expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
      id: 'apfm-web',
      shell: '/bin/bash',
    });
  });

  it('clears an override with null rather than an empty string', async () => {
    const user = userEvent.setup();
    install({ projects: [entry({ id: 'apfm-web', shell: '/bin/bash' })] });
    render(<RuntimeSection />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Project' }),
      'apfm-web',
    );
    const field = screen.getByRole('textbox', { name: 'Shell override' });
    await user.clear(field);
    await user.type(field, '{Enter}');

    // The whole point of the three-state contract: "" would spawn a shell
    // named "", null restores inheritance.
    expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
      id: 'apfm-web',
      shell: null,
    });
  });

  it('saves env vars, and clears the key entirely when emptied', async () => {
    const user = userEvent.setup();
    install({ projects: [entry({ id: 'apfm-web', env: { FOO: 'bar' } })] });
    render(<RuntimeSection />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Project' }),
      'apfm-web',
    );
    await user.click(screen.getByRole('button', { name: 'Remove variable 1' }));
    await user.click(screen.getByRole('button', { name: 'Save variables' }));

    // `null`, not `{}` — leaving `"env": {}` behind is litter in a file people
    // hand-edit.
    expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
      id: 'apfm-web',
      env: null,
    });
  });

  it('resets the draft when the selected project changes', async () => {
    const user = userEvent.setup();
    install({
      projects: [
        entry({ id: 'a', shell: '/bin/bash' }),
        entry({ id: 'b' }),
      ],
    });
    render(<RuntimeSection />);

    const select = screen.getByRole('combobox', { name: 'Project' });
    await user.selectOptions(select, 'a');
    expect(screen.getByRole('textbox', { name: 'Shell override' })).toHaveValue(
      '/bin/bash',
    );

    await user.selectOptions(select, 'b');
    // Keyed by project id, so switching remounts — a stale override must never
    // render under another project's name.
    expect(screen.getByRole('textbox', { name: 'Shell override' })).toHaveValue('');
  });
});

describe('RuntimeSection — diagnostic', () => {
  const found: CommandDiagnostic = {
    projectId: null,
    command: 'claude',
    isPath: false,
    resolved: '/usr/bin/claude',
    path: '/usr/bin',
    probes: [{ directory: '/usr/bin', found: true }],
  };

  it('asks about the top-level command when no project is picked', async () => {
    const user = userEvent.setup();
    diagnoseAgentCommand.mockResolvedValue(found);
    install();
    render(<RuntimeSection />);

    await user.click(screen.getByRole('button', { name: 'Check the default command' }));

    expect(diagnoseAgentCommand).toHaveBeenCalledWith({});
    expect(await screen.findByText('/usr/bin/claude')).toBeInTheDocument();
  });

  it('asks about the selected project', async () => {
    const user = userEvent.setup();
    diagnoseAgentCommand.mockResolvedValue({ ...found, projectId: 'apfm-web' });
    install({ projects: [entry({ id: 'apfm-web' })] });
    render(<RuntimeSection />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Project' }),
      'apfm-web',
    );
    await user.click(
      screen.getByRole('button', { name: /Check this project/ }),
    );

    expect(diagnoseAgentCommand).toHaveBeenCalledWith({ id: 'apfm-web' });
  });

  it('drops a stale verdict when the project changes', async () => {
    const user = userEvent.setup();
    diagnoseAgentCommand.mockResolvedValue(found);
    install({ projects: [entry({ id: 'a' }), entry({ id: 'b' })] });
    render(<RuntimeSection />);

    const select = screen.getByRole('combobox', { name: 'Project' });
    await user.selectOptions(select, 'a');
    await user.click(screen.getByRole('button', { name: /Check this project/ }));
    expect(await screen.findByText('/usr/bin/claude')).toBeInTheDocument();

    await user.selectOptions(select, 'b');

    // The old verdict describes the old project's PATH; leaving it on screen
    // next to a new selection would be actively misleading.
    expect(screen.queryByText('/usr/bin/claude')).not.toBeInTheDocument();
  });
});

describe('RuntimeSection — no bridge', () => {
  it('says runtime settings need the desktop app', () => {
    resetProjectConfig();
    render(<RuntimeSection />);

    expect(
      screen.getByText(/only available in the desktop app/),
    ).toBeInTheDocument();
  });
});

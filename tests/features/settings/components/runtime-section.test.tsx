import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  emptySnapshot,
  type CommandDiagnostic,
  type ConfigSnapshot,
  type EnvDiagnostic,
  type ProjectConfig,
} from '@shared/config-contract';

import { RuntimeSection } from '@features/settings/components/runtime-section';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';

import { testProjectKey } from '@tests/support/project-key';

const setRuntimeConfig = vi.fn();
const setProjectRuntimeConfig = vi.fn();
const diagnoseAgentCommand = vi.fn();
const diagnoseSessionEnv = vi.fn();

vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return {
    ...actual,
    setRuntimeConfig: (request: unknown) => setRuntimeConfig(request),
    setProjectRuntimeConfig: (request: unknown) => setProjectRuntimeConfig(request),
    diagnoseAgentCommand: (request: unknown) => diagnoseAgentCommand(request),
    diagnoseSessionEnv: (request: unknown) => diagnoseSessionEnv(request),
  };
});

const entry = (over: Partial<ProjectConfig> & { id: string }): ProjectConfig => ({
  name: over.id,
  path: `/repos/${over.id}`,
  icon: 'ph-folder',
  origin: 'local',
  status: 'ok',
  key: testProjectKey(over.id),
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
  diagnoseSessionEnv.mockResolvedValue(null);
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

/**
 * The login-shell import switch (HIVE-84).
 *
 * An escape hatch rather than a preference, so what is worth asserting is that
 * it reflects the stored value, writes the boolean the guard expects, and can
 * actually be turned *off* — a control that only ever writes `true` would look
 * fine and be useless.
 */
describe('RuntimeSection — login shell environment', () => {
  const findSwitch = () =>
    screen.getByRole('switch', { name: /Import my login shell/ });

  it('reflects the stored value in both directions', () => {
    install({ importLoginEnv: true });
    const { unmount } = render(<RuntimeSection />);
    expect(findSwitch()).toBeChecked();
    unmount();

    install({ importLoginEnv: false });
    render(<RuntimeSection />);
    expect(findSwitch()).not.toBeChecked();
  });

  it('writes the boolean, and writes false when switched off', async () => {
    const user = userEvent.setup();
    install({ importLoginEnv: true });
    render(<RuntimeSection />);

    await user.click(findSwitch());

    // `false`, not an absent field: the guard refuses a coerced value, and an
    // omitted one would mean "leave it alone".
    expect(setRuntimeConfig).toHaveBeenCalledWith({ importLoginEnv: false });
  });

  it('writes true when switched on', async () => {
    const user = userEvent.setup();
    install({ importLoginEnv: false });
    render(<RuntimeSection />);

    await user.click(findSwitch());

    expect(setRuntimeConfig).toHaveBeenCalledWith({ importLoginEnv: true });
  });

  it('says the change lands on the next launch, because the import runs at boot', () => {
    install();
    render(<RuntimeSection />);

    expect(
      screen.getByText(/Takes effect on the next launch/),
    ).toBeInTheDocument();
  });
});

describe('RuntimeSection — workspace environment', () => {
  it('saves a workspace variable through setRuntimeConfig', async () => {
    const user = userEvent.setup();
    install();
    render(<RuntimeSection />);

    // No project is selected, so this is the only EnvEditor on screen — the
    // per-project one only mounts once `ProjectOverrides` renders.
    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Variable 1 name' }),
      'AWS_PROFILE',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Variable 1 value' }),
      'incorp',
    );
    await user.click(screen.getByRole('button', { name: 'Save variables' }));

    expect(setRuntimeConfig).toHaveBeenCalledWith({
      env: { AWS_PROFILE: 'incorp' },
    });
  });

  it('states that the rc file runs afterward and can override these', () => {
    install();
    render(<RuntimeSection />);

    expect(
      screen.getByText(/rc file runs afterward and can override/i),
    ).toBeInTheDocument();
  });

  it('warns that the config file is plain text, steering credentials elsewhere', () => {
    install();
    render(<RuntimeSection />);

    // The full requirement is "plain text" *and* the steer toward the rc
    // file for secrets — asserting "plain text" alone would still pass if a
    // copy edit quietly dropped the "tokens and credentials" clause.
    expect(
      screen.getByText(/tokens and credentials.*plain text/i),
    ).toBeInTheDocument();
  });

  it('gives each env editor a distinct accessible name once a project is also shown', async () => {
    const user = userEvent.setup();
    install({ projects: [entry({ id: 'nova-web', env: { FOO: 'bar' } })] });
    render(<RuntimeSection />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Project' }),
      'nova-web',
    );

    // Both groups are individually addressable by name — this is what lets
    // a screen-reader user tell two identically-labelled "Save variables"
    // buttons apart, since `EnvEditor` renders the same literal control
    // names in both places and neither `<section>` wires an
    // `aria-labelledby` down to its own heading.
    const workspaceGroup = screen.getByRole('group', {
      name: 'Workspace environment variables',
    });
    const projectGroup = screen.getByRole('group', {
      name: 'Project environment variables',
    });

    // Each group contains exactly one save control — `getByRole` throws if
    // it finds zero or more than one, which is exactly the ambiguity this
    // test exists to catch.
    expect(
      within(workspaceGroup).getByRole('button', { name: 'Save variables' }),
    ).toBeInTheDocument();
    expect(
      within(projectGroup).getByRole('button', { name: 'Save variables' }),
    ).toBeInTheDocument();
  });
});

describe('RuntimeSection — per-project overrides', () => {
  it('shows nothing until a project is picked', () => {
    install({ projects: [entry({ id: 'nova-web' })] });
    render(<RuntimeSection />);

    expect(
      screen.queryByRole('textbox', { name: 'Shell override' }),
    ).not.toBeInTheDocument();
  });

  it('shows the inherited value as a placeholder, not a value', async () => {
    const user = userEvent.setup();
    install({ shell: '/bin/sh', projects: [entry({ id: 'nova-web' })] });
    render(<RuntimeSection />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Project' }),
      'nova-web',
    );

    const field = screen.getByRole('textbox', { name: 'Shell override' });
    // Empty means "inherit". Pre-filling the inherited value would turn every
    // opened row into an override the moment it was saved.
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', '/bin/sh');
  });

  it('sets an override', async () => {
    const user = userEvent.setup();
    install({ projects: [entry({ id: 'nova-web' })] });
    render(<RuntimeSection />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Project' }),
      'nova-web',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Shell override' }),
      '/bin/bash{Enter}',
    );

    expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
      id: 'nova-web',
      shell: '/bin/bash',
    });
  });

  it('clears an override with null rather than an empty string', async () => {
    const user = userEvent.setup();
    install({ projects: [entry({ id: 'nova-web', shell: '/bin/bash' })] });
    render(<RuntimeSection />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Project' }),
      'nova-web',
    );
    const field = screen.getByRole('textbox', { name: 'Shell override' });
    await user.clear(field);
    await user.type(field, '{Enter}');

    // The whole point of the three-state contract: "" would spawn a shell
    // named "", null restores inheritance.
    expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
      id: 'nova-web',
      shell: null,
    });
  });

  it('saves env vars, and clears the key entirely when emptied', async () => {
    const user = userEvent.setup();
    install({ projects: [entry({ id: 'nova-web', env: { FOO: 'bar' } })] });
    render(<RuntimeSection />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Project' }),
      'nova-web',
    );
    // Scoped to the project's own named group: the Defaults group now carries
    // its own EnvEditor too (story 108), so an unscoped query would find two
    // "Save variables" buttons once a project is selected.
    const projectGroup = screen.getByRole('group', {
      name: 'Project environment variables',
    });

    await user.click(screen.getByRole('button', { name: 'Remove variable 1' }));
    await user.click(
      within(projectGroup).getByRole('button', { name: 'Save variables' }),
    );

    // `null`, not `{}` — leaving `"env": {}` behind is litter in a file people
    // hand-edit.
    expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
      id: 'nova-web',
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
    diagnoseAgentCommand.mockResolvedValue({ ...found, projectId: 'nova-web' });
    install({ projects: [entry({ id: 'nova-web' })] });
    render(<RuntimeSection />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Project' }),
      'nova-web',
    );
    await user.click(
      screen.getByRole('button', { name: /Check this project’s command/ }),
    );

    expect(diagnoseAgentCommand).toHaveBeenCalledWith({ id: 'nova-web' });
  });

  it('drops a stale verdict when the project changes', async () => {
    const user = userEvent.setup();
    diagnoseAgentCommand.mockResolvedValue(found);
    install({ projects: [entry({ id: 'a' }), entry({ id: 'b' })] });
    render(<RuntimeSection />);

    const select = screen.getByRole('combobox', { name: 'Project' });
    await user.selectOptions(select, 'a');
    await user.click(
      screen.getByRole('button', { name: /Check this project’s command/ }),
    );
    expect(await screen.findByText('/usr/bin/claude')).toBeInTheDocument();

    await user.selectOptions(select, 'b');

    // The old verdict describes the old project's PATH; leaving it on screen
    // next to a new selection would be actively misleading.
    expect(screen.queryByText('/usr/bin/claude')).not.toBeInTheDocument();
  });
});

describe('RuntimeSection — environment diagnostic', () => {
  const kept: EnvDiagnostic = {
    projectId: null,
    shell: '/bin/zsh',
    error: null,
    vars: [{ key: 'AWS_PROFILE', configured: 'hive', actual: 'hive', overridden: false }],
  };

  it('asks about the default environment when no project is picked', async () => {
    const user = userEvent.setup();
    diagnoseSessionEnv.mockResolvedValue(kept);
    install();
    render(<RuntimeSection />);

    await user.click(
      screen.getByRole('button', { name: 'Check the default environment' }),
    );

    expect(diagnoseSessionEnv).toHaveBeenCalledWith({});
    expect(await screen.findByText('AWS_PROFILE')).toBeInTheDocument();
  });

  it('asks about the selected project’s environment', async () => {
    const user = userEvent.setup();
    diagnoseSessionEnv.mockResolvedValue({ ...kept, projectId: 'nova-web' });
    install({ projects: [entry({ id: 'nova-web' })] });
    render(<RuntimeSection />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Project' }),
      'nova-web',
    );
    await user.click(
      screen.getByRole('button', { name: /Check this project’s environment/ }),
    );

    expect(diagnoseSessionEnv).toHaveBeenCalledWith({ id: 'nova-web' });
  });

  it('shows a pending state while the probe is in flight, and clears it after', async () => {
    const user = userEvent.setup();
    // A promise this test controls the resolution of, so the pending state
    // between click and resolution is actually observable — a diagnostic
    // that spawns a real shell can take a second or more, unlike the
    // instant, file-stat-only command diagnostic.
    let resolve!: (value: EnvDiagnostic) => void;
    diagnoseSessionEnv.mockReturnValue(
      new Promise<EnvDiagnostic>((r) => {
        resolve = r;
      }),
    );
    install();
    render(<RuntimeSection />);

    const button = screen.getByRole('button', { name: 'Check the default environment' });
    await user.click(button);

    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled();

    resolve(kept);

    expect(
      await screen.findByRole('button', { name: 'Check the default environment' }),
    ).not.toBeDisabled();
  });

  it('drops a stale env verdict when the project changes', async () => {
    const user = userEvent.setup();
    diagnoseSessionEnv.mockResolvedValue(kept);
    install({ projects: [entry({ id: 'a' }), entry({ id: 'b' })] });
    render(<RuntimeSection />);

    const select = screen.getByRole('combobox', { name: 'Project' });
    await user.selectOptions(select, 'a');
    await user.click(
      screen.getByRole('button', { name: /Check this project’s environment/ }),
    );
    expect(await screen.findByText('AWS_PROFILE')).toBeInTheDocument();

    await user.selectOptions(select, 'b');

    // The old verdict describes the old project's shell; leaving it on
    // screen next to a new selection would be actively misleading.
    expect(screen.queryByText('AWS_PROFILE')).not.toBeInTheDocument();
  });

  it('also drops a stale command verdict when the project changes, independently', async () => {
    const user = userEvent.setup();
    diagnoseAgentCommand.mockResolvedValue({
      projectId: null,
      command: 'claude',
      isPath: false,
      resolved: '/usr/bin/claude',
      path: '/usr/bin',
      probes: [{ directory: '/usr/bin', found: true }],
    });
    install({ projects: [entry({ id: 'a' }), entry({ id: 'b' })] });
    render(<RuntimeSection />);

    const select = screen.getByRole('combobox', { name: 'Project' });
    await user.selectOptions(select, 'a');
    await user.click(
      screen.getByRole('button', { name: /Check this project’s command/ }),
    );
    expect(await screen.findByText('/usr/bin/claude')).toBeInTheDocument();

    await user.selectOptions(select, 'b');

    // The two diagnostics are cleared independently — switching projects must
    // not leave either verdict behind.
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

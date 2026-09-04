import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContainerGroup } from '@features/settings/components/container-group';
import { setProjectRuntimeConfig } from '@lib/project-config';

vi.mock('@lib/project-config', () => ({ setProjectRuntimeConfig: vi.fn() }));

// The brief's own test omits this; without it a call recorded by an earlier
// test (e.g. "commits a field on blur") survives into
// "refuses an invalid alias…", whose `not.toHaveBeenCalled()` then fails for
// a reason unrelated to what it is testing. `container-alias-group.test.tsx`
// clears its own mock in `beforeEach` for the same reason.
beforeEach(() => {
  vi.mocked(setProjectRuntimeConfig).mockClear();
});

const container = {
  workspace: '/workspace',
  hiveDir: '/hive',
  envArg: '-e {name}={value}',
  freshness: 'exec-env' as const,
  hostAlias: 'host.docker.internal',
};

const COMMAND = 'docker exec -it {env} devbox claude';

describe('ContainerGroup', () => {
  it('renders as a nested group: an h4 heading, no rule', () => {
    render(<ContainerGroup projectId="p" container={container} command={COMMAND} inheritedAlias="host.docker.internal" />);
    expect(screen.getByRole('heading', { level: 4, name: 'Container' })).toBeInTheDocument();
  });

  it('gives its controls names distinct from the rest of the pane', () => {
    render(<ContainerGroup projectId="p" container={container} command={COMMAND} inheritedAlias="host.docker.internal" />);
    expect(screen.getByRole('group', { name: 'Container settings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Workspace path')).toBeInTheDocument();
    expect(screen.getByLabelText('Hive directory')).toBeInTheDocument();
    expect(screen.getByLabelText('Liveness probe')).toBeInTheDocument();
  });

  it('commits a field on blur', async () => {
    render(<ContainerGroup projectId="p" container={container} command={COMMAND} inheritedAlias="host.docker.internal" />);
    const field = screen.getByLabelText('Workspace path');
    await userEvent.clear(field);
    await userEvent.type(field, '/srv');
    await userEvent.tab();

    expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
      id: 'p',
      container: { ...container, workspace: '/srv' },
    });
  });

  it('refuses an invalid alias before sending, because a rejected write is silent', async () => {
    render(<ContainerGroup projectId="p" container={container} command={COMMAND} inheritedAlias="host.docker.internal" />);
    const field = screen.getByLabelText('Host alias');
    await userEvent.clear(field);
    await userEvent.type(field, 'bad host');
    await userEvent.tab();

    expect(setProjectRuntimeConfig).not.toHaveBeenCalled();
    expect(screen.getByText(/not a valid hostname/i)).toBeInTheDocument();
  });

  it("states rewrite's cost rather than hiding it", async () => {
    render(<ContainerGroup projectId="p" container={{ ...container, freshness: 'rewrite' }} command={COMMAND} inheritedAlias="host.docker.internal" />);
    expect(screen.getByText(/resolved HIVE_HOOK_TOKEN/)).toBeInTheDocument();
    expect(screen.getByText(/on disk inside the container/i)).toBeInTheDocument();
  });

  it('warns that values on the command line are visible', () => {
    render(<ContainerGroup projectId="p" container={container} command={COMMAND} inheritedAlias="host.docker.internal" />);
    expect(screen.getByText(/visible in scroll-back/i)).toBeInTheDocument();
  });

  it('says authentication is decided by the image', () => {
    render(<ContainerGroup projectId="p" container={container} command={COMMAND} inheritedAlias="host.docker.internal" />);
    expect(screen.getByText(/decided by the image/i)).toBeInTheDocument();
  });

  it("shows the probe's own stderr when it failed", () => {
    render(
      <ContainerGroup
        projectId="p"
        container={container}
        command={COMMAND}
        inheritedAlias="host.docker.internal"
        diagnostic={{
          probe: 'docker exec devbox true',
          ok: false,
          exitCode: 1,
          stderr: 'Error response from daemon: container devbox is not running',
          missingEnvPlaceholder: false,
        }}
      />,
    );
    expect(screen.getByText(/container devbox is not running/)).toBeInTheDocument();
  });

  it('shows a passing probe as the container running, not just as an absence of failure', () => {
    render(
      <ContainerGroup
        projectId="p"
        container={container}
        command={COMMAND}
        inheritedAlias="host.docker.internal"
        diagnostic={{
          probe: 'docker exec devbox true',
          ok: true,
          exitCode: 0,
          stderr: '',
          missingEnvPlaceholder: false,
        }}
      />,
    );
    expect(
      screen.getByText(/Probe passed\. The container is running\./),
    ).toBeInTheDocument();
  });

  it('names a killed-by-signal probe as "signal" rather than a misleading exit code', () => {
    render(
      <ContainerGroup
        projectId="p"
        container={container}
        command={COMMAND}
        inheritedAlias="host.docker.internal"
        diagnostic={{
          probe: 'docker exec devbox true',
          ok: false,
          exitCode: null,
          stderr: 'killed',
          missingEnvPlaceholder: false,
        }}
      />,
    );
    expect(screen.getByText(/Probe failed \(exit signal\)/)).toBeInTheDocument();
  });

  it('flags a command that could never authenticate', () => {
    render(
      <ContainerGroup
        projectId="p"
        container={container}
        command={COMMAND}
        inheritedAlias="host.docker.internal"
        diagnostic={{ probe: null, ok: true, exitCode: 0, stderr: '', missingEnvPlaceholder: true }}
      />,
    );
    // Not just `/\{env\}/`: the "Environment argument" field's own hint
    // ("Expanded once per variable, at {env} in the agent command.") also
    // contains that literal substring, so the bare regex matches two
    // elements and `getByText` throws. `/no \{env\}/` is unique to the
    // missing-placeholder warning.
    expect(screen.getByText(/no \{env\}/)).toBeInTheDocument();
  });

  it('switches freshness on click, commits it, and swaps the trade-off copy', async () => {
    const user = userEvent.setup();
    render(
      <ContainerGroup
        projectId="p"
        container={container}
        command={COMMAND}
        inheritedAlias="host.docker.internal"
      />,
    );

    expect(
      screen.getByText(/Nothing secret is written to disk/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'rewrite' }));

    expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
      id: 'p',
      container: { ...container, freshness: 'rewrite' },
    });
    expect(
      screen.getByText(/forfeits the read-only, secret-free property/),
    ).toBeInTheDocument();
  });

  /**
   * `ProjectOverrides` remounts on `key={project.id}` when the *selected*
   * project changes, but not when the *same* project's snapshot changes
   * underneath it — a Reload or a Reset. `seen`/`setSeen` is what makes this
   * component follow that case on its own, exactly as
   * `container-alias-group.tsx` does for its one field.
   */
  describe('when the same project’s snapshot changes underneath it', () => {
    it('follows the new container prop', () => {
      const { rerender } = render(
        <ContainerGroup
          projectId="p"
          container={container}
          command={COMMAND}
          inheritedAlias="host.docker.internal"
        />,
      );

      rerender(
        <ContainerGroup
          projectId="p"
          container={{ ...container, workspace: '/reloaded' }}
          command={COMMAND}
          inheritedAlias="host.docker.internal"
        />,
      );

      expect(screen.getByLabelText('Workspace path')).toHaveValue('/reloaded');
    });

    it('drops a pending edit rather than resurrecting it', async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <ContainerGroup
          projectId="p"
          container={container}
          command={COMMAND}
          inheritedAlias="host.docker.internal"
        />,
      );

      await user.clear(screen.getByLabelText('Workspace path'));
      await user.type(screen.getByLabelText('Workspace path'), '/half-typed');

      // A fresh object with the same values, not the same reference: a real
      // reload deserialises a new `ConfigSnapshot` from IPC, so `seen !==
      // container` must fire on a *structurally* equal snapshot too — the
      // same reason `container-alias-group.test.tsx` rerenders with a value
      // that is `===`-different even when it reads the same.
      rerender(
        <ContainerGroup
          projectId="p"
          container={{ ...container }}
          command={COMMAND}
          inheritedAlias="host.docker.internal"
        />,
      );

      expect(screen.getByLabelText('Workspace path')).toHaveValue('/workspace');
    });
  });

  it('does not write when the committed value did not change', async () => {
    const user = userEvent.setup();
    render(
      <ContainerGroup
        projectId="p"
        container={container}
        command={COMMAND}
        inheritedAlias="host.docker.internal"
      />,
    );

    await user.click(screen.getByLabelText('Workspace path'));
    await user.tab(); // Blur without editing.

    expect(setProjectRuntimeConfig).not.toHaveBeenCalled();
  });

  it('clears the alias complaint as soon as the field is edited again', async () => {
    const user = userEvent.setup();
    render(
      <ContainerGroup
        projectId="p"
        container={container}
        command={COMMAND}
        inheritedAlias="host.docker.internal"
      />,
    );
    const field = screen.getByLabelText('Host alias');

    await user.clear(field);
    await user.type(field, 'bad host');
    await user.tab();
    expect(screen.getByText(/not a valid hostname/i)).toBeInTheDocument();

    await user.type(field, '2');

    expect(screen.queryByText(/not a valid hostname/i)).not.toBeInTheDocument();
  });

  it('defaults freshness to exec-env when the file has not set one', () => {
    const { freshness: _dropped, ...bare } = container;
    render(
      <ContainerGroup
        projectId="p"
        container={bare}
        command={COMMAND}
        inheritedAlias="host.docker.internal"
      />,
    );

    expect(screen.getByRole('radio', { name: 'exec-env' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  /**
   * The three-state contract's other two fields, exercised through
   * `normalise` — restoring a default and inheriting, rather than storing the
   * empty string a user just typed over.
   */
  describe('clearing a field restores its default rather than storing ""', () => {
    /**
     * Fix round 1, Finding 1: emptying `envArg` must drop the key, not bake
     * `DEFAULT_ENV_ARG` into the file. The parser and the IPC guard both
     * validate `container` without defaulting it, exactly so a default is
     * never frozen into the file — writing `DEFAULT_ENV_ARG` here would look
     * identical today but silently stop tracking a future change to that
     * default.
     */
    it('drops the envArg key entirely rather than baking in DEFAULT_ENV_ARG', async () => {
      const user = userEvent.setup();
      render(
        <ContainerGroup
          projectId="p"
          container={container}
          command={COMMAND}
          inheritedAlias="host.docker.internal"
        />,
      );
      const field = screen.getByLabelText('Environment argument');

      await user.clear(field);
      await user.tab();

      const { envArg: _droppedEnvArg, ...expected } = container;
      expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
        id: 'p',
        container: expected, // no `envArg` key at all
      });
    });

    /**
     * Fix round 1, Finding 1: emptying `hostAlias` must drop the key, not
     * bake the *current* `receiver.hostAlias` into the file — that would be
     * user-visible and wrong in a way the user cannot see, since a later
     * change to the global alias would then never reach this project again.
     */
    it('drops the hostAlias key entirely rather than baking in the current global alias', async () => {
      const user = userEvent.setup();
      render(
        <ContainerGroup
          projectId="p"
          container={container}
          command={COMMAND}
          inheritedAlias="gateway"
        />,
      );
      const field = screen.getByLabelText('Host alias');

      await user.clear(field);
      await user.tab();

      const { hostAlias: _droppedHostAlias, ...expected } = container;
      expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
        id: 'p',
        container: expected, // no `hostAlias` key at all
      });
    });

    it('still shows the inherited alias as the field’s placeholder once the override is dropped', async () => {
      const user = userEvent.setup();
      render(
        <ContainerGroup
          projectId="p"
          container={container}
          command={COMMAND}
          inheritedAlias="gateway"
        />,
      );
      const field = screen.getByLabelText('Host alias');

      await user.clear(field);
      await user.tab();

      // The write already asserts the key is dropped; this asserts the
      // *display* consequence — blank now reads as "inherits gateway",
      // which is `effective.hostAlias`'s job, unaffected by what the write
      // path stores.
      expect(field).toHaveAttribute('placeholder', 'gateway');
    });

    it('drops the probe key entirely rather than storing "" — the guard refuses an empty probe', async () => {
      const user = userEvent.setup();
      const withProbe = { ...container, probe: 'docker exec devbox true' };
      render(
        <ContainerGroup
          projectId="p"
          container={withProbe}
          command={COMMAND}
          inheritedAlias="host.docker.internal"
        />,
      );
      const field = screen.getByLabelText('Liveness probe');

      await user.clear(field);
      await user.tab();

      expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
        id: 'p',
        container: container, // no `probe` key at all, not `probe: ''`
      });
    });

    it('keeps an existing probe untouched when a different field is committed', async () => {
      const user = userEvent.setup();
      const withProbe = { ...container, probe: 'docker exec devbox true' };
      render(
        <ContainerGroup
          projectId="p"
          container={withProbe}
          command={COMMAND}
          inheritedAlias="host.docker.internal"
        />,
      );
      const field = screen.getByLabelText('Workspace path');

      await user.clear(field);
      await user.type(field, '/srv');
      await user.tab();

      expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
        id: 'p',
        container: { ...withProbe, workspace: '/srv' },
      });
    });

    it('leaves envArg and hostAlias absent when the file never set them, even while committing a different field', async () => {
      const user = userEvent.setup();
      const bare = { workspace: '/workspace', hiveDir: '/hive' };
      render(
        <ContainerGroup
          projectId="p"
          container={bare}
          command={COMMAND}
          inheritedAlias="gateway"
        />,
      );
      const field = screen.getByLabelText('Workspace path');

      await user.clear(field);
      await user.type(field, '/srv');
      await user.tab();

      // Not `envArg: '-e {name}={value}'` or `hostAlias: 'gateway'` baked
      // in — committing `workspace` must not manufacture overrides for
      // fields the user never touched.
      expect(setProjectRuntimeConfig).toHaveBeenCalledWith({
        id: 'p',
        container: { workspace: '/srv', hiveDir: '/hive' },
      });
    });
  });
});

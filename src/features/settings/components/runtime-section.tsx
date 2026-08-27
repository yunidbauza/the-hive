import { useEffect, useState } from 'react';

import { SelectField } from '@components/ui/select-field';
import { Switch } from '@components/ui/switch';
import { TextField } from '@components/ui/text-field';
import { CommandDiagnosticView } from '@features/settings/components/command-diagnostic-view';
import { EnvDiagnosticView } from '@features/settings/components/env-diagnostic-view';
import { EnvEditor } from '@features/settings/components/env-editor';
import { PathSourceGroup } from '@features/settings/components/path-source-group';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { SettingsSectionHeader } from '@features/settings/components/settings-section-header';
import { useProjectConfig } from '@hooks/use-project-config';
import {
  diagnoseAgentCommand,
  diagnoseSessionEnv,
  readLoginEnvStatus,
  setProjectRuntimeConfig,
  setRuntimeConfig,
} from '@lib/project-config';
import type { CommandDiagnostic, EnvDiagnostic } from '@shared/config-contract';
import type { LoginEnvStatus } from '@shared/ipc-contract';

/**
 * Runtime settings — shell, agent command, per-project overrides (story 104).
 *
 * The section answers the epic's opening complaint: a user launches the app,
 * tries to start a session, and it fails with one line on a console they were
 * never asked to open. Story 101 made the project list editable; this makes the
 * two values that actually run editable, and adds the diagnostic that explains
 * the most common failure.
 *
 * Every write goes through the same single write path as the rest of the epic
 * and returns a fresh `ConfigSnapshot`, so nothing here holds an optimistic
 * value to reconcile.
 */

export function RuntimeSection() {
  const snapshot = useProjectConfig();

  /**
   * Draft state for the two top-level fields.
   *
   * Seeded from the snapshot and re-seeded whenever it changes — an explicit
   * reload, or another verb returning a fresh one, must not leave a stale
   * value sitting in an input the user is not looking at.
   */
  const [shell, setShell] = useState('');
  const [command, setCommand] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [diagnostic, setDiagnostic] = useState<CommandDiagnostic | null>(null);
  const [envDiagnostic, setEnvDiagnostic] = useState<EnvDiagnostic | null>(null);
  /**
   * Whether the env probe is in flight.
   *
   * The env diagnostic spawns a real login shell and waits for it — typically
   * a second or more with oh-my-zsh or nvm, and up to the probe's own timeout
   * in the worst case — unlike the command diagnostic, which only stats
   * files. A button with no feedback for that long reads as broken rather
   * than working.
   */
  const [envDiagnosticPending, setEnvDiagnosticPending] = useState(false);
  /**
   * `null` while the read is out, `'unavailable'` once it has failed.
   *
   * Three states rather than two, because `readLoginEnvStatus` answers `null`
   * for both "no bridge" and "the channel threw" — and a component that stores
   * that verbatim can never leave its loading state. The pane would go on
   * saying it was checking, forever, with no error and no retry.
   */
  const [loginEnv, setLoginEnv] = useState<LoginEnvStatus | 'unavailable' | null>(
    null,
  );

  useEffect(() => {
    if (!snapshot) return;
    setShell(snapshot.shell);
    setCommand(snapshot.claudeCommand);
  }, [snapshot]);

  /**
   * The environment this app actually searched, for `PathSourceGroup` below.
   *
   * `integrations.loginEnv()`, not `integrations.status()`. The status verb
   * carries this same field, and reaching for it would have spent two
   * `spawnSync` calls looking for `gh` — blocking main for as long as they take
   * — to hand back a value resolved at boot. This pane wants the environment
   * and not the binary, so it asks for exactly that.
   *
   * Keyed on *whether* there is a snapshot, never on the snapshot itself: every
   * write in this pane installs a fresh object, and depending on it would
   * re-read on each committed keystroke. Nothing here can change the answer
   * before the next launch anyway — which is what the switch above says about
   * itself, and what `PathSourceGroup`'s copy is careful to repeat.
   */
  const hasSnapshot = snapshot !== null;

  useEffect(() => {
    if (!hasSnapshot) return;

    let cancelled = false;
    void readLoginEnvStatus().then((next) => {
      // `null` is a failure, not a slow answer — see the state's own note.
      if (!cancelled) setLoginEnv(next ?? 'unavailable');
    });

    return () => {
      cancelled = true;
    };
  }, [hasSnapshot]);

  if (!snapshot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
        <SettingsSectionHeader
          title="Runtime"
          description="Runtime settings are only available in the desktop app."
        />
      </div>
    );
  }

  const project =
    snapshot.projects.find((entry) => entry.id === selectedId) ?? null;

  /** Commit a top-level field, but only when it actually changed. */
  const commitShell = () => {
    const next = shell.trim();
    // Empty is not a value here: there is no lower level to fall back to, and a
    // session with no shell cannot start. Restore rather than write.
    if (next === '' ) {
      setShell(snapshot.shell);
      return;
    }
    if (next !== snapshot.shell) void setRuntimeConfig({ shell: next });
  };

  const commitCommand = () => {
    const next = command.trim();
    if (next === '') {
      setCommand(snapshot.claudeCommand);
      return;
    }
    if (next !== snapshot.claudeCommand) {
      void setRuntimeConfig({ claudeCommand: next });
    }
  };

  const runDiagnostic = async () => {
    const result = await diagnoseAgentCommand(
      selectedId === '' ? {} : { id: selectedId },
    );
    setDiagnostic(result);
  };

  const runEnvDiagnostic = async () => {
    setEnvDiagnosticPending(true);
    try {
      const result = await diagnoseSessionEnv(
        selectedId === '' ? {} : { id: selectedId },
      );
      setEnvDiagnostic(result);
    } finally {
      setEnvDiagnosticPending(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
      <SettingsSectionHeader
        title="Runtime"
        description="What a session spawns, and where its agent command comes from."
      />

      {snapshot.errors.map((error) => (
        <p
          key={error}
          className="rounded-[5px] border border-red px-2.5 py-1.5 text-[11.5px] text-red"
        >
          {error}
        </p>
      ))}

      <SettingsGroup
        title="Defaults"
        description="Used by every project that does not override them."
      >
        <div className="grid max-w-[520px] grid-cols-2 gap-3">
          <TextField
            label="Shell"
            value={shell}
            onChange={setShell}
            onCommit={commitShell}
            placeholder="/bin/zsh"
            hint="Started as a login shell."
          />
          <TextField
            label="Agent command"
            value={command}
            onChange={setCommand}
            onCommit={commitCommand}
            placeholder="claude"
            hint="Typed into the shell when a session starts."
          />
        </div>

        <div
          // A named group, not just a visually-adjacent block: `EnvEditor`
          // renders the same literal "Save variables" / "Add variable"
          // control names everywhere it is used, and `SettingsGroup`'s own
          // heading carries no `aria-labelledby` down to this `<section>`.
          // With a project also selected below, a screen-reader user gets
          // two indistinguishable "Save variables, button" announcements
          // with nothing to tell them apart — this `aria-label` is that
          // disambiguation. It must read differently from the per-project
          // group's group name (`"Project environment variables"`, in
          // `ProjectOverrides` below).
          role="group"
          aria-label="Workspace environment variables"
          className="flex flex-col gap-1.5 pt-1"
        >
          {/*
           * Two things a user hitting a wall needs to already know, before
           * they file a bug (story 108):
           *
           * - Order of operations: this is injected before the shell starts,
           *   but a login shell's rc file runs afterward and can silently
           *   clobber it. Without saying so, "I set FOO here and it's still
           *   the old value" reads as a bug in this editor rather than in
           *   `.zshrc`.
           * - Storage: `~/.hive/config.json` is plain JSON on disk, not a
           *   secrets store, so credentials belong in the rc file instead.
           *   This is guidance, not a guard — there is deliberately no
           *   secret-detection here, since a check that rejects `API_TOKEN`
           *   while waving through `TOKEN_API` teaches nothing.
           */}
          <p className="text-[11.5px] text-subtle">
            Environment for every session, applied before the shell starts. A
            login shell’s rc file runs afterward and can override anything
            set here.
          </p>
          <p className="text-[11.5px] text-subtle">
            Prefer your rc file for tokens and credentials — this file is
            stored in plain text.
          </p>
          {/*
           * A visible label, matching the per-project editor's pattern
           * below — sighted users get the same visual parity a magnifier or
           * a quick scroll relies on, not just proximity to the section
           * heading above.
           */}
          <span className="text-[12.5px] text-muted">Environment variables</span>
          <EnvEditor
            // `EnvEditor` seeds its rows once, from a lazy initializer with
            // no effect and no key of its own (see its doc comment). `shell`
            // and `command` above are re-seeded from every fresh snapshot via
            // the `useEffect` at the top of this component, and the
            // per-project editor gets the same property for free through
            // `key={project.id}` on `ProjectOverrides` — this is the
            // workspace editor's equivalent, so a stale value cannot sit in
            // an input a fresh snapshot has already superseded.
            key={JSON.stringify(snapshot.env)}
            value={snapshot.env}
            onSave={(env) => void setRuntimeConfig({ env })}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Per-project overrides"
        description="Pick a project to override the defaults or add environment variables for it."
      >
        <SelectField
          label="Project"
          value={selectedId}
          options={[
            { value: '', label: 'Select a project…' },
            ...snapshot.projects.map((entry) => ({
              value: entry.id,
              label: entry.name,
            })),
          ]}
          onChange={(value) => {
            setSelectedId(value);
            // The old verdict describes the old project's PATH; keeping it on
            // screen next to a new selection would be actively misleading.
            setDiagnostic(null);
            // Same reasoning: a verdict about the old project's shell/env
            // would be actively misleading sitting next to a new selection.
            setEnvDiagnostic(null);
          }}
          className="max-w-[240px]"
        />

        {project ? (
          <ProjectOverrides
            key={project.id}
            id={project.id}
            shell={project.shell}
            claudeCommand={project.claudeCommand}
            env={project.env ?? {}}
            inheritedShell={snapshot.shell}
            inheritedCommand={snapshot.claudeCommand}
          />
        ) : null}
      </SettingsGroup>

      {/*
        HIVE-84. An escape hatch, deliberately phrased as one.

        The default is on, and the overwhelming majority of users should leave
        it there — without it a Finder-launched build cannot find anything they
        installed. What earns the switch a place in Settings is the rc file this
        app should not fight: one that is slow, prompts, or has side effects
        worth not triggering once per launch. The description says what turning
        it off costs, because a switch whose consequence is invisible is one
        people flip to see what happens.
      */}
      <SettingsGroup
        title="Login shell environment"
        description="Whether this app adopts the PATH your terminal uses."
      >
        <Switch
          label="Import my login shell's PATH at startup"
          checked={snapshot.importLoginEnv}
          onCheckedChange={(next) => {
            void setRuntimeConfig({ importLoginEnv: next });
          }}
          description="Runs your login shell once when the app starts and adopts its PATH, plus GH_TOKEN or GITHUB_TOKEN if this app does not already have them. Off means the app searches only the environment it was launched with — which, opened from Finder, is launchd's four-entry PATH. Takes effect on the next launch."
        />
      </SettingsGroup>

      {/*
        Directly under the switch that decides it. This group used to sit in
        Integrations, where it explained a missing `gh` but could not offer the
        control that would fix it — so the pane owning the answer had to send
        the reader here by name. Now the answer and the switch are one group
        apart, and Integrations links this way instead.
      */}
      <PathSourceGroup loginEnv={loginEnv} />

      <SettingsGroup
        title="Command diagnostic"
        description="Where the agent command is looked for, and whether it was found."
      >
        <button
          type="button"
          onClick={() => void runDiagnostic()}
          className="w-fit rounded-[6px] border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
        >
          {selectedId === ''
            ? 'Check the default command'
            : 'Check this project’s command'}
        </button>

        {diagnostic ? <CommandDiagnosticView diagnostic={diagnostic} /> : null}
      </SettingsGroup>

      <SettingsGroup
        title="Environment diagnostic"
        description="Which variables survived the shell’s rc file."
      >
        <button
          type="button"
          onClick={() => void runEnvDiagnostic()}
          disabled={envDiagnosticPending}
          aria-busy={envDiagnosticPending}
          className="w-fit rounded-[6px] border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink disabled:opacity-60"
        >
          {envDiagnosticPending
            ? 'Checking…'
            : selectedId === ''
              ? 'Check the default environment'
              : 'Check this project’s environment'}
        </button>

        {envDiagnostic ? <EnvDiagnosticView diagnostic={envDiagnostic} /> : null}
      </SettingsGroup>
    </div>
  );
}

/**
 * One project's overrides.
 *
 * Split out and **keyed by project id** so switching projects remounts it —
 * that is what resets the draft inputs. Deriving the same behaviour with an
 * effect inside a single component would mean a stale override briefly
 * rendering under the newly selected project's name.
 */
function ProjectOverrides({
  id,
  shell,
  claudeCommand,
  env,
  inheritedShell,
  inheritedCommand,
}: {
  id: string;
  shell?: string;
  claudeCommand?: string;
  env: Record<string, string>;
  inheritedShell: string;
  inheritedCommand: string;
}) {
  const [shellDraft, setShellDraft] = useState(shell ?? '');
  const [commandDraft, setCommandDraft] = useState(claudeCommand ?? '');

  /**
   * Commit an override, mapping "emptied" to `null` — remove it.
   *
   * This is the distinction the whole three-state contract exists for. Storing
   * `""` would spawn a shell named `""` and fail with a message no user could
   * act on; `null` restores inheritance, which is what clearing a field means.
   */
  const commit = (
    field: 'shell' | 'claudeCommand',
    draft: string,
    current: string | undefined,
  ) => {
    const next = draft.trim() === '' ? null : draft.trim();
    if (next === (current ?? null)) return;
    void setProjectRuntimeConfig({ id, [field]: next });
  };

  return (
    <div className="flex flex-col gap-3 rounded-[7px] border border-border-soft p-3">
      <div className="grid max-w-[520px] grid-cols-2 gap-3">
        <TextField
          label="Shell override"
          value={shellDraft}
          onChange={setShellDraft}
          onCommit={() => commit('shell', shellDraft, shell)}
          placeholder={inheritedShell}
          muted={shellDraft === ''}
          hint="Blank inherits the default."
        />
        <TextField
          label="Agent command override"
          value={commandDraft}
          onChange={setCommandDraft}
          onCommit={() => commit('claudeCommand', commandDraft, claudeCommand)}
          placeholder={inheritedCommand}
          muted={commandDraft === ''}
          hint="Blank inherits the default."
        />
      </div>

      <div
        // Named distinctly from the workspace group above (`"Workspace
        // environment variables"`) — see the comment there. Without this,
        // once a project is selected, a screen reader hears two identical
        // "Save variables, button" announcements with no way to tell which
        // is which.
        role="group"
        aria-label="Project environment variables"
        className="flex flex-col gap-1.5"
      >
        <span className="text-[12.5px] text-muted">Environment variables</span>
        <EnvEditor
          value={env}
          onSave={(next) =>
            void setProjectRuntimeConfig({
              id,
              // An emptied map is `null`, not `{}` — removing the key entirely
              // keeps the config file clean rather than leaving `"env": {}`
              // behind for the user to wonder about.
              env: Object.keys(next).length === 0 ? null : next,
            })
          }
        />
      </div>
    </div>
  );
}

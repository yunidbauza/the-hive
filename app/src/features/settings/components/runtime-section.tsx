import { useEffect, useState } from 'react';

import { SelectField } from '@components/ui/select-field';
import { TextField } from '@components/ui/text-field';
import { CommandDiagnosticView } from '@features/settings/components/command-diagnostic-view';
import { EnvEditor } from '@features/settings/components/env-editor';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { useProjectConfig } from '@hooks/use-project-config';
import {
  diagnoseAgentCommand,
  setProjectRuntimeConfig,
  setRuntimeConfig,
} from '@lib/project-config';
import type { CommandDiagnostic } from '@shared/config-contract';

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

  useEffect(() => {
    if (!snapshot) return;
    setShell(snapshot.shell);
    setCommand(snapshot.claudeCommand);
  }, [snapshot]);

  if (!snapshot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <h2 className="text-[13px] text-ink">Runtime</h2>
        <p className="text-[11.5px] text-subtle">
          Runtime settings are only available in the desktop app.
        </p>
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[13px] text-ink">Runtime</h2>
        <p className="text-[11.5px] text-subtle">
          What a session spawns, and where its agent command comes from.
        </p>
      </div>

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

      <div className="flex flex-col gap-1.5">
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

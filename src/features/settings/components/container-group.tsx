import { useState } from 'react';

import { SegmentedControl } from '@components/ui/segmented-control';
import { TextField } from '@components/ui/text-field';
import { ContainerCommandPreview } from '@features/settings/components/container-command-preview';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { SettingsNestingContext } from '@features/settings/components/settings-nesting';
import { setProjectRuntimeConfig } from '@lib/project-config';
import type {
  ContainerConfig,
  ContainerDiagnostic,
  ContainerFreshness,
} from '@shared/config-contract';
import { DEFAULT_ENV_ARG, DEFAULT_FRESHNESS, isHostAlias } from '@shared/config-contract';

const FRESHNESS: readonly { value: ContainerFreshness; label: string }[] = [
  { value: 'exec-env', label: 'exec-env' },
  { value: 'rewrite', label: 'rewrite' },
];

const FRESHNESS_COPY: Record<ContainerFreshness, string> = {
  'exec-env':
    'Environment is passed per exec and always current. Nothing secret is written to disk.',
  rewrite:
    'Writes one settings directory per session with a resolved HIVE_HOOK_TOKEN in it. That puts a live secret on disk inside the container and forfeits the read-only, secret-free property exec-env has. Choose it only for tools whose environment is fixed at creation time.',
};

const ALIAS_INVALID = 'Not a valid hostname.';

export function ContainerGroup({
  projectId,
  container,
  command,
  inheritedAlias,
  diagnostic,
}: {
  projectId: string;
  container: ContainerConfig;
  command: string;
  inheritedAlias: string;
  diagnostic?: ContainerDiagnostic;
}) {
  const [draft, setDraft] = useState(container);
  const [aliasInvalid, setAliasInvalid] = useState(false);

  /*
    Follow the snapshot when it changes underneath us. Adjusting state during
    render rather than in an effect is React's own recommendation: the
    re-render happens before paint, so the stale value is never shown. See
    `container-alias-group.tsx:47-59` for the full argument.
  */
  const [seen, setSeen] = useState(container);
  if (seen !== container) {
    setSeen(container);
    setDraft(container);
    setAliasInvalid(false);
  }

  /*
    Validated here rather than at the bridge, because `mutate` swallows an IPC
    rejection into `console.error` (`src/lib/project-config.ts:117-119`) — a refused
    write is otherwise completely silent, and the field would go on showing a
    value that was never saved. The draft is left alone so the user can correct
    what they typed rather than watch it disappear.
  */
  const commit = (next: ContainerConfig) => {
    if (!isHostAlias(next.hostAlias)) {
      setAliasInvalid(true);
      return;
    }
    setAliasInvalid(false);
    if (JSON.stringify(next) === JSON.stringify(container)) return;
    void setProjectRuntimeConfig({ id: projectId, container: next });
  };

  const field = (
    key: 'workspace' | 'hiveDir' | 'envArg' | 'probe' | 'hostAlias',
    label: string,
    hint: string,
    placeholder?: string,
  ) => (
    <TextField
      label={label}
      value={draft[key] ?? ''}
      onChange={(value) => {
        setDraft({ ...draft, [key]: value });
        if (key === 'hostAlias' && aliasInvalid) setAliasInvalid(false);
      }}
      onCommit={() => commit(normalise(draft, inheritedAlias))}
      {...(placeholder === undefined ? {} : { placeholder })}
      hint={key === 'hostAlias' && aliasInvalid ? ALIAS_INVALID : hint}
    />
  );

  /*
    What the preview and the freshness control actually show — every optional
    field resolved to what a real spawn would use, `hostAlias` included. The
    fields themselves stay on `draft`, blank and all: a blank field means
    "inherit", and pre-filling it with the resolved value would make every
    opened project look like it already had an override. `expandPreview`
    defaults `envArg` on its own (`container-preview.ts`), but `hostAlias` has
    no single fallback it can apply without being told `inheritedAlias`, so
    that one is resolved here.
  */
  /*
    Deliberately not annotated `: ContainerConfig` — that would widen
    `freshness` and `hostAlias` back to optional, since the interface declares
    them that way, and `SegmentedControl`'s `value` prop and `FRESHNESS_COPY`'s
    index both need the narrower, always-defined type this literal actually
    has.
  */
  const effective = {
    ...draft,
    hostAlias:
      draft.hostAlias === undefined || draft.hostAlias.trim() === ''
        ? inheritedAlias
        : draft.hostAlias,
    freshness: draft.freshness ?? DEFAULT_FRESHNESS,
  };

  return (
    /*
      One accessible name for the whole block, distinct from every other group
      in this pane. `EnvEditor` accepts no aria-label prop and repeats its
      control names verbatim wherever it is used — see the comment at
      `runtime-section.tsx:206-217`, and the test that pins it.
    */
    <div role="group" aria-label="Container settings">
      {/*
        Established here rather than only at the mount site: this group is
        never rendered anywhere but inside the per-project overrides card, so
        it owns the fact the same way `SettingsProviderGroup` owns it for a
        provider band — a caller that renders this component gets the nested
        heading and no rule for free, by construction, rather than by
        remembering to wrap it.
      */}
      <SettingsNestingContext value={true}>
        <SettingsGroup
          title="Container"
          description="Present means every session for this project runs inside the container the command starts. This app never starts, stops or names it."
        >
          <div className="flex flex-col gap-3.5 rounded-[8px] border border-border-soft bg-panel-2 p-3">
            <div className="flex flex-col gap-2">
              <span className="text-[11px] uppercase tracking-wide text-subtle">
                Where things are
              </span>
              <div className="grid grid-cols-2 gap-3">
                {field('workspace', 'Workspace path', "Where this project's directory is mounted.")}
                {field('hiveDir', 'Hive directory', "Where this app's generated files are mounted.")}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-[11px] uppercase tracking-wide text-subtle">
                How it is invoked
              </span>
              <div className="grid grid-cols-2 gap-3">
                {field(
                  'envArg',
                  'Environment argument',
                  'Expanded once per variable, at {env} in the agent command.',
                  DEFAULT_ENV_ARG,
                )}
                {field('hostAlias', 'Host alias', 'Blank inherits the global default.', inheritedAlias)}
                <div className="col-span-2">
                  {field(
                    'probe',
                    'Liveness probe',
                    'Must exit 0 before a session starts. Blank skips the check.',
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-[11px] uppercase tracking-wide text-subtle">Freshness</span>
              <SegmentedControl
                label="Freshness"
                options={FRESHNESS}
                value={effective.freshness}
                onChange={(freshness) => {
                  const next = { ...draft, freshness };
                  setDraft(next);
                  commit(normalise(next, inheritedAlias));
                }}
              />
              <span className="text-[11.5px] text-subtle">
                {FRESHNESS_COPY[effective.freshness]}
              </span>
            </div>
          </div>

          <ContainerCommandPreview
            command={command}
            config={effective}
            projectId={projectId}
            {...(diagnostic === undefined ? {} : { diagnostic })}
          />

          <p className="border-l-2 border-amber pl-2.5 text-[11.5px] text-muted">
            Values above are typed into the terminal, so they are visible in
            scroll-back and to ps. Credentials belong in the image — this app never
            forwards them, and what claude authenticates with inside the container
            is decided by the image.
          </p>
        </SettingsGroup>
      </SettingsNestingContext>
    </div>
  );
}

/**
 * Blank means inherit, never store `""` — the same three-state rule the other
 * overrides use.
 *
 * `probe` is dropped from the base spread rather than merely left out of the
 * conditional add-back: once a user has typed into and then cleared the
 * field, `draft.probe` itself is the literal `""`, and spreading `...draft`
 * would bake that empty string into `next` regardless of the conditional
 * below. `isContainerProbe` refuses an empty string
 * (`config-contract.ts:667-669`), so that half-fixed shape would be a payload
 * the guard throws on — silently, since `mutate` only logs a refusal.
 */
function normalise(draft: ContainerConfig, inheritedAlias: string): ContainerConfig {
  const probe = draft.probe?.trim() ?? '';
  const envArg = draft.envArg?.trim() ?? '';
  const hostAlias = draft.hostAlias?.trim() ?? '';
  const { probe: _droppedProbe, ...rest } = draft;
  return {
    ...rest,
    workspace: draft.workspace.trim(),
    hiveDir: draft.hiveDir.trim(),
    envArg: envArg === '' ? DEFAULT_ENV_ARG : envArg,
    hostAlias: hostAlias === '' ? inheritedAlias : hostAlias,
    ...(probe === '' ? {} : { probe }),
  };
}

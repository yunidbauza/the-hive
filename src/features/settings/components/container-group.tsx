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
import {
  DEFAULT_ENV_ARG,
  DEFAULT_FRESHNESS,
  isAbsoluteContainerPath,
  isContainerProbe,
  isEnvArgTemplate,
  isHostAlias,
} from '@shared/config-contract';

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

/**
 * The rejection every guarded field can hit, and what to say about it
 * (final-review fix, Important 4).
 *
 * `assertContainer` — the guard on the other end of `setProjectRuntimeConfig`
 * — throws on all five, but `commit` used to check only `hostAlias`. A
 * dropped leading slash or a placeholder-less `envArg` sent a payload the
 * guard silently refused (`mutate` only `console.error`s a rejection), and
 * the field went on showing the unsaved value with nothing to explain why it
 * never landed. `probe` is included for the same reason its neighbours are —
 * matching every field the guard validates — even though `normalise` below
 * already reduces a merely-blank probe to "omitted" before `commit` ever
 * sees it.
 */
const FIELD_INVALID_HINT: Record<
  'workspace' | 'hiveDir' | 'envArg' | 'probe' | 'hostAlias',
  string
> = {
  workspace: 'Must be an absolute path.',
  hiveDir: 'Must be an absolute path.',
  envArg: 'Must contain {name} and {value}.',
  probe: 'Must be a non-empty command.',
  hostAlias: 'Not a valid hostname.',
};

/** Every key `ContainerConfig` declares, for {@link sameContainer}. */
const CONTAINER_KEYS = [
  'workspace',
  'hiveDir',
  'envArg',
  'probe',
  'freshness',
  'hostAlias',
] as const satisfies readonly (keyof ContainerConfig)[];

/**
 * Whether two blocks are the same, field by field.
 *
 * Not `JSON.stringify(a) === JSON.stringify(b)`: `normalise` below rebuilds
 * its return value by spreading a `rest` that has had `envArg`/`hostAlias`/
 * `probe` destructured out and then conditionally re-adding them, which
 * moves those keys to the end of the object regardless of where they sat in
 * `container`. `JSON.stringify` is key-order-sensitive, so that reordering
 * alone made this fire as "changed" — and therefore write — on **every**
 * commit, even one that touched no field at all. Comparing by key sidesteps
 * order entirely, and reading a key that is absent from one side as
 * `undefined` is exactly the semantics "blank means inherit" needs: an
 * omitted key and an explicit `undefined` must compare equal.
 */
const sameContainer = (a: ContainerConfig, b: ContainerConfig): boolean =>
  CONTAINER_KEYS.every((key) => a[key] === b[key]);

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
  /**
   * Which guarded fields currently hold a value `commit` refused to send
   * (final-review fix, Important 4). A set rather than one boolean per field
   * — `hostAlias` was the only one before — because every field `assertContainer`
   * validates can independently fail, and `field()` below reads this once,
   * generically, rather than growing a fifth copy of the same three lines.
   */
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());

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
    setInvalid(new Set());
  }

  /*
    Validated here rather than at the bridge, because `mutate` swallows an IPC
    rejection into `console.error` (`src/lib/project-config.ts:117-119`) — a refused
    write is otherwise completely silent, and the field would go on showing a
    value that was never saved. The draft is left alone so the user can correct
    what they typed rather than watch it disappear.

    Every field `assertContainer` validates, checked here the same way
    (final-review fix, Important 4) — not just `hostAlias`, which was the only
    one before this. `workspace` and `hiveDir` are never optional, so they are
    checked unconditionally; `envArg` and `probe` are `undefined` whenever
    `normalise` decided the field was blank, and an absent override is always
    valid — the predicate is only consulted for a value the user actually
    typed, exactly as it already was for `hostAlias`.
  */
  const commit = (next: ContainerConfig) => {
    const invalidNow = new Set<string>();
    if (!isAbsoluteContainerPath(next.workspace)) invalidNow.add('workspace');
    if (!isAbsoluteContainerPath(next.hiveDir)) invalidNow.add('hiveDir');
    if (next.envArg !== undefined && !isEnvArgTemplate(next.envArg)) invalidNow.add('envArg');
    if (next.probe !== undefined && !isContainerProbe(next.probe)) invalidNow.add('probe');
    if (next.hostAlias !== undefined && !isHostAlias(next.hostAlias)) invalidNow.add('hostAlias');

    setInvalid(invalidNow);
    if (invalidNow.size > 0) return;

    if (sameContainer(next, container)) return;
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
        if (invalid.has(key)) {
          const next = new Set(invalid);
          next.delete(key);
          setInvalid(next);
        }
      }}
      onCommit={() => commit(normalise(draft))}
      {...(placeholder === undefined ? {} : { placeholder })}
      hint={invalid.has(key) ? FIELD_INVALID_HINT[key] : hint}
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
                  commit(normalise(next));
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
            globalAlias={inheritedAlias}
            {...(diagnostic === undefined ? {} : { diagnostic })}
          />

          <p className="border-l-2 border-amber pl-2.5 text-[11.5px] text-muted">
            Values above are typed into the terminal, so they are visible in
            scroll-back and to ps. Credentials belong in the image — while
            Subscription auth is on, this app strips the API-key variables out of
            what it forwards, and what claude authenticates with inside the
            container is decided by the image.
          </p>
        </SettingsGroup>
      </SettingsNestingContext>
    </div>
  );
}

/**
 * Blank means inherit, never store a resolved value in its place — the same
 * three-state rule for all three optional fields, `hostAlias` included.
 *
 * Each of `envArg`, `hostAlias` and `probe` is dropped from the base spread
 * rather than merely left out of its own conditional add-back: once a user
 * has typed into and then cleared a field, `draft.<field>` itself is already
 * the literal `""`, and spreading `...draft` would bake that empty string
 * (or a resolved default written in its place) into `next` regardless of the
 * conditional below. `isContainerProbe` refuses an empty string
 * (`config-contract.ts:667-669`), so a half-fixed `probe` shape would be a
 * payload the guard throws on — silently, since `mutate` only logs a
 * refusal.
 *
 * `hostAlias` (and `envArg`) must become an **absent key**, not a resolved
 * literal baked into the file — `DEFAULT_ENV_ARG` or `inheritedAlias` written
 * here would freeze today's value forever. The parser and the IPC guard both
 * validate `container` without defaulting it, exactly so a default is never
 * frozen into the file (`config-contract.ts`'s doc comment on
 * `ContainerConfig`: "an absent field means inherit, never empty"); baking
 * `inheritedAlias` in at commit time would mean a later change to
 * `receiver.hostAlias` never reaches a project whose override was "cleared"
 * this way — the exact silent staleness the three-state contract exists to
 * prevent. `effective`, in the component above, is where a *resolved* value
 * belongs — for display, never for what gets written.
 */
function normalise(draft: ContainerConfig): ContainerConfig {
  const probe = draft.probe?.trim() ?? '';
  const envArg = draft.envArg?.trim() ?? '';
  const hostAlias = draft.hostAlias?.trim() ?? '';
  const {
    probe: _droppedProbe,
    envArg: _droppedEnvArg,
    hostAlias: _droppedHostAlias,
    ...rest
  } = draft;
  return {
    ...rest,
    workspace: draft.workspace.trim(),
    hiveDir: draft.hiveDir.trim(),
    ...(envArg === '' ? {} : { envArg }),
    ...(hostAlias === '' ? {} : { hostAlias }),
    ...(probe === '' ? {} : { probe }),
  };
}

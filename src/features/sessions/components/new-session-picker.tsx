import { MagnifyingGlass } from '@phosphor-icons/react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useRef } from 'react';

import { useSwarmPhrase } from '@/hooks/use-swarm-phrase';
import { cn } from '@/lib/utils';
// `ProjectRow` is aliased because this file declares a component of that name.
import type {
  Effort,
  Model,
  ProjectRow as ProjectRowData,
} from '@/types/entity';

import { Icon } from '@components/ui/icon';
import { ProjectKey } from '@components/ui/project-key';
import { SwarmCreature } from '@components/ui/swarm-creature';
import { can } from '@config/runtime';
import { OptionStepper } from '@features/sessions/components/option-stepper';
import { useProjectAccess, useProjectConfig } from '@hooks/use-project-config';
import {
  useProjectSessions,
  useProjects,
  useSpawnSession,
  useTicket,
} from '@stores/hive-store';
import {
  usePickerActions,
  usePickerState,
  useSettingsActions,
} from '@stores/ui-store';

const MODELS: readonly Model[] = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'max'];

/** The concept pins the first four projects as one-click starts. */
const PINNED_COUNT = 4;

/**
 * The new-session picker (story 044).
 *
 * ## Why the Radix primitive rather than `components/ui/dialog`
 *
 * The vendored `DialogContent` always portals to `document.body` and centres a
 * fixed-position card. This picker fills the **center stage** — the rails and
 * header stay visible, exactly as the concept shows — so it is composed from
 * the primitive directly and rendered in place.
 *
 * What the story actually asks for is Radix's *behaviour*, and what is kept is
 * Escape, the dialog role, and the managed open/close lifecycle — all of which
 * live in `Content`.
 *
 * Not kept: scroll locking. Radix implements that in `Dialog.Overlay`, which
 * this picker deliberately omits — an overlay would paint a scrim across the
 * whole app and destroy the full-stage look the concept specifies. Nothing is
 * lost: the shell is a fixed-height, non-scrolling layout, so there is no page
 * scroll to lock.
 *
 * Also not kept, and this one was a bug rather than a choice: the focus trap
 * and the `aria-modal` semantics that hide the rest of the tree. Both come
 * from modality, and modality is wrong for a surface that leaves the header
 * and rails visible — it made them inert while they still looked live. See the
 * note on `modal` below.
 */
export function NewSessionPicker() {
  const projects = useProjects();
  const spawnSession = useSpawnSession();
  const config = useProjectConfig();
  const { pickerQuery, pickerTicket, newModel, newEffort } = usePickerState();
  const ticket = useTicket(pickerTicket);
  const { closePicker, setPickerQuery, setNewModel, setNewEffort } =
    usePickerActions();
  const { openSettings } = useSettingsActions();
  /**
   * Two pools, because the two states are not the same thing: first run means
   * nothing exists yet, and no-match means plenty exists and none of it is what
   * was typed. Sharing a pool would let "the creep has not yet spread" answer a
   * search, which is wrong about the world.
   */
  const firstRunPhrase = useSwarmPhrase('empty.projects');
  const noMatchPhrase = useSwarmPhrase('noMatch.picker');

  const searchRef = useRef<HTMLInputElement>(null);

  /*
    Case-insensitive substring match across all three things a project answers
    to (HIVE-94) — its key, its id and its display name. Substring here, unlike
    the console's `resolveProjectRef`, and deliberately so: this is a search box
    whose results the user then *clicks*, so a loose match costs a glance, where
    the console's would spawn an agent in the wrong folder.
  */
  const query = pickerQuery.trim().toLowerCase();
  const matches =
    query === ''
      ? projects
      : projects.filter((project) =>
          [project.key, project.id, project.name].some((field) =>
            field.toLowerCase().includes(query),
          ),
        );

  // Always a project **id** — the rows carry it, and `spawnSession` stores it
  // on the entity (HIVE-94).
  const spawn = (projectId: string) => {
    // Refused rather than trusted: every button that reaches here is already
    // disabled when the project has no real directory, but Enter in the search
    // box reaches here too (story 090).
    if (!can.spawnSessionIn(projectId)) return;
    // Task is empty on purpose: the picker starts a session, and the first
    // message gives it its job (story 043). `spawnSession` opens the new tab,
    // which also dismisses the picker.
    //
    // `pickerTicket ?? undefined` rather than the value itself: the store's
    // "no ticket" is `null`, the session field's is absent, and passing `null`
    // into an optional parameter would put a `ticket: null` on the entity that
    // nothing knows how to read (HIVE-73).
    spawnSession(projectId, '', newModel, newEffort, pickerTicket ?? undefined);
  };

  return (
    <DialogPrimitive.Root
      open
      /**
       * Not modal — the same reason the settings overlay is not. This fills the
       * center stage and leaves the header and rails visible on purpose, and
       * Radix's modality made that visible chrome `aria-hidden` and
       * `pointer-events: none`. The theme toggle and the bell looked live and
       * were not; clicking one dismissed the picker rather than acting.
       */
      modal={false}
      onOpenChange={(open) => {
        if (!open) closePicker();
      }}
    >
      <DialogPrimitive.Content
        aria-describedby={undefined}
        // Radix would otherwise pull focus to the container; the search box is
        // where a keyboard-first picker should start.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
        // A header or rail click acts; it does not dismiss. Escape still closes.
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
        className="flex min-h-0 flex-1 flex-col items-center gap-7 overflow-y-auto bg-term-bg px-6 py-10 outline-none"
      >
        <div className="mt-auto" />

        {/*
          Opened from a ticket card, the picker says so (HIVE-73). The click
          that got here was "work this issue", and a generic heading would give
          the user no confirmation that the session they are about to start will
          be linked to it.

          `pickerTicket` carries the heading, not `ticket`: the key is what the
          user clicked and is always known, whereas the ticket object is a
          lookup into a list the WORK panel replaces on every refresh. So a
          card that scrolled out from under the query still gets a titled
          picker — it simply has no summary line to add.
        */}
        {/*
          The spire leads the picker (HIVE-93), and **only when the first-run
          block below is not showing**.

          That condition is the whole of it: `templateWritten` renders a 120px
          hive hero a few lines down, and two creatures stacked in one dialog
          reads as a bug rather than as atmosphere. So this is the ordinary
          picker's mark and the hive stays the first-run hero — the surface has
          two states and each gets exactly one sprite.

          96px, not the hero's 120: it sits *above* a title rather than standing
          in for missing content, so it is the quieter end of the 72–120
          full-stage register `SwarmCreature` documents.
        */}
        {config?.templateWritten ? null : (
          <SwarmCreature creature="spire" size={96} />
        )}

        <div className="flex flex-col gap-1.5 text-center">
          <DialogPrimitive.Title className="font-display text-[22px] tracking-[-0.02em] text-ink">
            {pickerTicket === null
              ? 'Start a new session'
              : `Start a session for ${pickerTicket}`}
          </DialogPrimitive.Title>
          <span className="text-[13px] text-subtle">
            {ticket?.title ??
              'Pick a project — a Claude Code terminal will open for it'}
          </span>
        </div>

        {/*
          First run: the config file did not exist and was just written, so
          there is nothing to be unmapped *from* yet.

          Story 090 printed the file path here, which is the failure story 101
          exists to end: a user who has never seen that file cannot edit it, and
          naming it is not an instruction. The button opens settings, which is
          the place they can actually do something.
        */}
        {config?.templateWritten ? (
          <div className="flex max-w-[560px] flex-col items-center gap-2.5">
            <SwarmCreature creature="hive" size={120} />
            <p className="text-center font-mono text-[11.5px] text-muted">
              {firstRunPhrase}
            </p>
            <p className="text-center font-mono text-[11.5px] text-subtle">
              no projects yet — add one of your repositories to open a session in it
            </p>
            <button
              type="button"
              onClick={openSettings}
              className="rounded-md bg-brand-fill px-3 py-1.5 text-[12.5px] text-on-brand hover:bg-brand-fill-hover"
            >
              Add project
            </button>
          </div>
        ) : null}

        <div className="flex max-w-[560px] flex-wrap justify-center gap-2.5">
          {projects.slice(0, PINNED_COUNT).map((project) => (
            <PinnedProject
              key={project.id}
              project={project}
              onSelect={spawn}
            />
          ))}
        </div>

        <div className="flex w-[560px] max-w-[92%] flex-wrap gap-6">
          <OptionStepper
            label="model"
            options={MODELS}
            value={newModel}
            onChange={setNewModel}
          />
          {/*
            Haiku does not think, so the scale beside it does not apply
            (HIVE-100). Faded and out of reach rather than hidden: a control
            that vanishes takes the layout with it and leaves the user wondering
            what they did, where one that dims in place explains itself and
            comes back the moment the model changes.

            The stored effort is deliberately left alone. Switching to haiku and
            back finds the scale exactly where it was, which is what makes this
            a *disabled* control rather than a destructive one.
          */}
          <OptionStepper
            label="thinking effort"
            options={EFFORTS}
            value={newEffort}
            onChange={setNewEffort}
            disabled={newModel === 'haiku'}
            disabledReason="not for haiku"
          />
        </div>

        <div className="flex w-[560px] max-w-[92%] flex-col gap-2">
          <div className="flex items-center gap-2 rounded-full border border-border bg-term-input px-3.5 py-2">
            <MagnifyingGlass
              size={14}
              aria-hidden="true"
              className="shrink-0 text-subtle"
            />
            <input
              ref={searchRef}
              value={pickerQuery}
              onChange={(event) => setPickerQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                // No-op with zero matches rather than spawning something
                // arbitrary — Enter means "the one I can see".
                const [first] = matches;
                if (first) spawn(first.id);
              }}
              placeholder="search all projects…"
              spellCheck={false}
              aria-label="Search all projects"
              className="min-w-0 flex-1 border-none bg-transparent font-mono text-[12.5px] text-ink caret-green outline-none placeholder:text-subtle"
            />
          </div>

          <div className="max-h-[220px] overflow-y-auto">
            {matches.length === 0 ? (
              <div className="flex flex-col gap-[3px] px-1 py-2">
                <p className="font-mono text-xs text-muted">{noMatchPhrase}</p>
                <p className="font-mono text-xs text-subtle">
                  {`no projects match "${pickerQuery.trim()}"`}
                </p>
              </div>
            ) : (
              matches.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  onSelect={spawn}
                />
              ))
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={closePicker}
          className="font-mono text-xs text-subtle hover:text-ink"
        >
          esc · cancel
        </button>

        <div className="mb-auto" />
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  );
}

/**
 * One of the pinned one-click starts.
 *
 * Its own component rather than an inline `.map()` body because it needs
 * `useProjectAccess`, and a hook cannot be called from inside a loop callback.
 */
function PinnedProject({
  project,
  onSelect,
}: {
  project: ProjectRowData;
  onSelect: (id: string) => void;
}) {
  const { id, name, icon } = project;
  const access = useProjectAccess(id);

  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      disabled={!access.spawnable}
      title={access.reason ?? undefined}
      className="flex items-center gap-2 rounded-full border border-border bg-chip px-3.5 py-2 font-mono text-[13px] text-ink hover:border-brand hover:bg-hover disabled:cursor-not-allowed disabled:text-subtle disabled:hover:border-border disabled:hover:bg-chip"
    >
      <Icon
        name={icon}
        size={15}
        className={access.spawnable ? 'text-brand' : 'text-subtle'}
      />
      {/*
        The name, not the id (HIVE-104). These tiles sit directly above the
        search rows, so an id here and a name there would be one screen
        disagreeing with itself about what a project is called.
      */}
      {name}
    </button>
  );
}

/** One search result. Owns its own count subscription. */
function ProjectRow({
  project,
  onSelect,
}: {
  project: ProjectRowData;
  onSelect: (id: string) => void;
}) {
  /*
    Destructured here rather than threaded in as four primitives, which is what
    this used to take. `key` was the reason it could not simply take the row:
    that name is React's, and a prop called `key` never arrives — so the row's
    alias had to be smuggled in under `projectKey`. As a *field* it is nothing
    special, and the workaround goes with the prop list.
  */
  const { id, name, key: projectKey, icon } = project;
  const sessions = useProjectSessions(id);
  const access = useProjectAccess(id);

  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      disabled={!access.spawnable}
      title={access.reason ?? undefined}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      <Icon
        name={icon}
        size={14}
        className={cn('shrink-0', access.spawnable ? 'text-brand' : 'text-subtle')}
      />
      {/* The same chip the Settings row shows, so the alias is learned in
          whichever of the two the user happens to be looking at (HIVE-94). */}
      <ProjectKey value={projectKey} />
      {/*
        The name, which is one of the three things the filter above matches on
        (HIVE-104). This drew the id, so the picker would take the *new* name,
        find the project, and label the hit with the *old* one — searching by a
        string the row never displays is worse than not matching on it at all.
      */}
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-[12.5px]',
          access.spawnable ? 'text-ink' : 'text-subtle',
        )}
      >
        {name}
      </span>
      {/*
        The refusal replaces the session count rather than joining it: a row
        that cannot be started has nothing useful to say about how many
        sessions it is running (story 090).
      */}
      <span className="shrink-0 font-mono text-[11px] text-subtle">
        {access.spawnable ? `${sessions.length} active` : 'unmapped'}
      </span>
    </button>
  );
}

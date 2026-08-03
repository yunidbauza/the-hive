import { MagnifyingGlass } from '@phosphor-icons/react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useRef } from 'react';

import { cn } from '@/lib/utils';
import type { Effort, Model } from '@/types/entity';

import { Icon } from '@components/ui/icon';
import { can } from '@config/runtime';
import { OptionStepper } from '@features/sessions/components/option-stepper';
import { useProjectAccess, useProjectConfig } from '@hooks/use-project-config';
import {
  useProjectSessions,
  useProjects,
  useSpawnSession,
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
 * What the story actually asks for is Radix's *behaviour*, and the parts that
 * matter here are kept: the focus trap, Escape, and the `aria-modal` semantics
 * that hide the rest of the tree from assistive tech — all of which live in
 * `Content`.
 *
 * Not kept: scroll locking. Radix implements that in `Dialog.Overlay`, which
 * this picker deliberately omits — an overlay would paint a scrim across the
 * whole app and destroy the full-stage look the concept specifies. Nothing is
 * lost: the shell is a fixed-height, non-scrolling layout, so there is no page
 * scroll to lock.
 */
export function NewSessionPicker() {
  const projects = useProjects();
  const spawnSession = useSpawnSession();
  const config = useProjectConfig();
  const { pickerQuery, newModel, newEffort } = usePickerState();
  const { closePicker, setPickerQuery, setNewModel, setNewEffort } =
    usePickerActions();
  const { openSettings } = useSettingsActions();

  const searchRef = useRef<HTMLInputElement>(null);

  // Case-insensitive substring match on the project id, which is what the
  // search box shows and what the user is reading.
  const query = pickerQuery.trim().toLowerCase();
  const matches =
    query === ''
      ? projects
      : projects.filter((project) => project.id.toLowerCase().includes(query));

  const spawn = (repo: string) => {
    // Refused rather than trusted: every button that reaches here is already
    // disabled when the project has no real directory, but Enter in the search
    // box reaches here too (story 090).
    if (!can.spawnSessionIn(repo)) return;
    // Task is empty on purpose: the picker starts a session, and the first
    // message gives it its job (story 043). `spawnSession` opens the new tab,
    // which also dismisses the picker.
    spawnSession(repo, '', newModel, newEffort);
  };

  return (
    <DialogPrimitive.Root
      open
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
        className="flex min-h-0 flex-1 flex-col items-center gap-7 overflow-y-auto bg-term-bg px-6 py-10 outline-none"
      >
        <div className="mt-auto" />

        <div className="flex flex-col gap-1.5 text-center">
          <DialogPrimitive.Title className="font-display text-[22px] tracking-[-0.02em] text-ink">
            Start a new session
          </DialogPrimitive.Title>
          <span className="text-[13px] text-subtle">
            Pick a project — a Claude Code terminal will open for it
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
              id={project.id}
              icon={project.icon}
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
          <OptionStepper
            label="thinking effort"
            options={EFFORTS}
            value={newEffort}
            onChange={setNewEffort}
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
              <p className="px-1 py-2 font-mono text-xs text-subtle">
                {`no projects match "${pickerQuery.trim()}"`}
              </p>
            ) : (
              matches.map((project) => (
                <ProjectRow
                  key={project.id}
                  id={project.id}
                  icon={project.icon}
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
  id,
  icon,
  onSelect,
}: {
  id: string;
  icon: string;
  onSelect: (id: string) => void;
}) {
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
      {id}
    </button>
  );
}

/** One search result. Owns its own count subscription. */
function ProjectRow({
  id,
  icon,
  onSelect,
}: {
  id: string;
  icon: string;
  onSelect: (id: string) => void;
}) {
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
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-[12.5px]',
          access.spawnable ? 'text-ink' : 'text-subtle',
        )}
      >
        {id}
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

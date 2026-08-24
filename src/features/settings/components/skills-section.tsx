import { useEffect, useState } from 'react';

import { useSwarmPhrase } from '@/hooks/use-swarm-phrase';
import {
  deleteSkill,
  frontmatterName,
  loadSkills,
  readSkill,
  saveSkill,
  skillNameProblem,
} from '@/lib/skills';

import { SwarmCreature } from '@components/ui/swarm-creature';
import { SettingsSectionHeader } from '@features/settings/components/settings-section-header';
import { SkillDiscardConfirm } from '@features/settings/components/skill-discard-confirm';
import { SkillEditor } from '@features/settings/components/skill-editor';
import { useSkills } from '@hooks/use-skills';

/**
 * The Skills section of settings (HIVE-96).
 *
 * ## What this manages
 *
 * Markdown files under `~/.hive/skills`, which main injects into every session
 * The Hive starts and into no other `claude`. Editing them in a text editor
 * works and keeps working — this pane is a second way in, not the only one, and
 * main re-reads the tree before every spawn precisely so the two are the same
 * feature.
 *
 * The built-in `/done` is **not** listed and cannot be opened. It is written by
 * the app on every launch, so an edit here would be silently reverted; leaving
 * it out is the honest rendering of a file the user does not own.
 *
 * ## Layout
 *
 * Master–detail: a 150px list beside the editor, both always visible, so
 * switching between skills is one click and the set stays in view while you
 * type. Chosen over a drill-in on browser-rendered mockups.
 */

/**
 * What a new skill starts as.
 *
 * A template rather than an empty box, because the frontmatter is not
 * guessable and a file without it is one main will refuse. `name` is left blank
 * deliberately: it is the one field the user must supply, the folder is named
 * from it, and starting it at `new-skill` would invite a tree full of them.
 */
const TEMPLATE = `---
name:
description: What this skill does, in one line
disable-model-invocation: true
---

Write the instruction here. The session runs it when you type the command.
`;

export function SkillsSection() {
  const snapshot = useSkills();
  const phrase = useSwarmPhrase('empty.settingsSkills');

  /** Which skill is open, or `null` for a new one that has never been saved. */
  const [open, setOpen] = useState<string | null>(null);
  const [buffer, setBuffer] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /**
   * A pending question, held rather than asked immediately.
   *
   * Switching away from a dirty buffer has to *ask* before it acts, so the
   * intended action is parked here until the answer arrives. A callback rather
   * than a flag because the two questions this pane asks — abandon an edit,
   * delete a file — resume differently.
   */
  const [pending, setPending] = useState<{
    question: string;
    detail: string;
    confirmLabel: string;
    act: () => void;
  } | null>(null);
  /**
   * Why the last write did not happen, or `null`.
   *
   * Main's own words, verbatim — `projects-section.tsx` renders `snapshot.errors`
   * the same way and for the same reason: "not a directory", the OS message
   * from a failed write, are the details that make a failure fixable, and
   * rephrasing them here would throw exactly those away.
   */
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadSkills();
  }, []);

  const skills = snapshot?.skills ?? [];
  const invalid = snapshot?.invalid ?? [];
  const dirty = buffer !== null && buffer !== saved;
  const empty = skills.length === 0 && invalid.length === 0 && buffer === null;

  /**
   * The names already spoken for, excluding the one being edited.
   *
   * Re-saving a skill under its own name is not a collision with itself, and
   * refusing it would make an edit unsaveable the moment it was reopened.
   *
   * **Invalid skills count.** They are folders on disk with a SKILL.md in them,
   * so a save under one of their names overwrites a real file — and the most
   * likely invalid skill is one whose frontmatter name and folder disagree,
   * which is exactly the name a user is then likely to type. Listing only the
   * valid ones made that silent data loss.
   */
  const taken = [...skills, ...invalid]
    .map((entry) => entry.name)
    .filter((name) => name !== open);
  const typed = buffer === null ? '' : frontmatterName(buffer);
  const problem = buffer === null ? null : skillNameProblem(typed, taken);

  /** Run `act`, or ask first when there is unsaved work to lose. */
  const guard = (
    act: () => void,
    question: string,
    detail: string,
    confirmLabel: string,
  ): void => {
    if (!dirty) {
      act();
      return;
    }
    setPending({ question, detail, confirmLabel, act });
  };

  /**
   * The question to ask before throwing away the open buffer.
   *
   * A never-saved skill has no name yet, and asking "Discard changes to /?"
   * was both nonsense on screen and, because the question doubles as the
   * confirm's `aria-label`, nonsense read aloud.
   */
  const discardQuestion =
    open === null ? 'Discard this new skill?' : `Discard changes to /${open}?`;
  const discardDetail =
    open === null
      ? 'It has never been saved, so there is nothing on disk to keep.'
      : 'The file on disk is unchanged. Your edits in this box are lost.';

  const openSkill = (name: string): void => {
    guard(
      () => {
        setOpen(name);
        setBuffer(null);
        setSaved(null);
        setError(null);
        void readSkill(name).then((file) => {
          // `null` is the browser demo, or a read that failed and already
          // reported itself. Either way there is nothing to put in the editor.
          if (file === null) return;
          /*
            Drop a response the user has moved on from.

            Two quick clicks race: the first row leaves `buffer` null, so the
            dirty guard does not stop the second, and whichever `skills:read`
            resolves last wins. Without this check that could be the *first*
            row's body, landing under the second row's name and path — and
            Delete would then act on the name, not on the text on screen.
          */
          setOpen((current) => {
            if (current !== name) return current;
            setBuffer(file.body);
            setSaved(file.body);
            return current;
          });
        });
      },
      discardQuestion,
      discardDetail,
      'Discard',
    );
  };

  const newSkill = (): void => {
    guard(
      () => {
        setOpen(null);
        setBuffer(TEMPLATE);
        // Never equal to the buffer, so a fresh template counts as unsaved —
        // which it is: nothing has been written yet.
        setSaved(null);
        setError(null);
      },
      discardQuestion,
      discardDetail,
      'Discard',
    );
  };

  const save = (): void => {
    if (buffer === null || problem !== null) return;
    void saveSkill(typed, buffer).then((failure) => {
      /*
        Only claim success when there was one.

        `saveSkill` used to resolve either way, so this ran unconditionally: the
        badge flipped to "saved" and the path header pointed at a file main had
        refused to write. Being told a skill is saved while it is not is worse
        than the failure itself, because the user stops looking.
      */
      if (failure !== null) {
        setError(failure);
        return;
      }
      setError(null);
      // The folder is named from the frontmatter, so a rename lands as a new
      // skill and the old one is removed by the user's own Delete — this story
      // does not move files behind their back.
      setOpen(typed);
      setSaved(buffer);
    });
  };

  const remove = (): void => {
    const target = open;
    if (target === null) {
      // Never saved, so there is no file. Abandoning it is a local matter.
      setBuffer(null);
      setSaved(null);
      setError(null);
      return;
    }
    setPending({
      question: `Delete /${target}?`,
      detail: `Removes the folder under ${snapshot?.skillsRoot ?? 'the skills folder'}. Sessions already running keep the command until they end.`,
      confirmLabel: 'Delete',
      act: () => {
        void deleteSkill(target).then((failure) => {
          // Same rule as `save`, and it matters more here: emptying the editor
          // over a row that is still in the list tells the user a destructive
          // action succeeded while showing them that it did not.
          if (failure !== null) {
            setError(failure);
            return;
          }
          setError(null);
          setOpen(null);
          setBuffer(null);
          setSaved(null);
        });
      },
    });
  };

  const rows = [
    ...skills.map((skill) => ({ name: skill.name, reason: null as string | null })),
    ...invalid.map((skill) => ({ name: skill.name, reason: skill.reason })),
  ];

  const description =
    'Slash commands available only inside sessions The Hive starts. Saved as SKILL.md under ~/.hive/skills. A skill can end with /done to close its session.';

  /*
    No snapshot is the browser demo, which has no bridge to ask and no disk to
    write to — the same header-only shape `runtime-section.tsx` uses, and for
    the same reason: a pane of dead controls teaches the user the app is broken.
  */
  if (!snapshot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <SettingsSectionHeader
          title="Skills"
          description="Custom skills are only available in the desktop app."
        />
      </div>
    );
  }

  if (empty) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
        <SettingsSectionHeader title="Skills" description={description} />

        {/*
          The dashed card from `projects-section.tsx`, not the shared
          `EmptyState`: that component is documented as rail-only at 44px and
          explicitly not a centred block. A bordered box saying "No skills yet"
          reads as a furnished, empty place; a bare heading above a button reads
          as a broken render.
        */}
        <div className="flex flex-col items-center gap-1 rounded-[7px] border border-dashed border-border px-4 py-6 text-center">
          <SwarmCreature creature="hive" size={72} />
          <span className="text-[11.5px] text-muted">{phrase}</span>
          <span className="text-[13px] text-muted">No skills yet.</span>
          <span className="text-[11.5px] text-subtle">
            Write one and every session you start will have it.
          </span>
        </div>

        <button
          type="button"
          onClick={newSkill}
          className="w-fit rounded-md bg-brand-fill px-3 py-1.5 text-[12.5px] text-on-brand hover:bg-brand-fill-hover"
        >
          + New skill
        </button>

        <p className="mt-auto pt-2 text-[11px] text-subtle">
          Skills folder: {snapshot.skillsRoot}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-hidden px-5 py-4">
      <SettingsSectionHeader title="Skills" description={description} />

      {/*
        `min-w-0` on the editor column, for the reason `skill-editor.tsx`'s
        header gives: a grid item's default `min-width: auto` refuses to shrink
        below its content, so the absolute path in that header widened the
        column past the pane and pushed Delete and Save off the right edge.
        Caught on a screenshot of the built app, which is the only place a
        clipped panel is visible — every assertion still passed.
      */}
      {/*
        Why a skill will not be injected, in main's own words.

        This used to be a `title` on the row, which is unreachable: the row is
        `disabled` — it has nothing to open — and Chromium delivers no pointer
        events to a disabled control, so the native tooltip never appeared. The
        whole reason `readUserSkills` returns its rejects instead of logging
        them is that the user can act on them, and a reason nobody can read is
        the same as no reason at all.
      */}
      {invalid.map((skill) => (
        <p
          key={skill.name}
          className="rounded-[5px] border border-amber px-2.5 py-1.5 text-[11.5px] text-amber"
        >
          {skill.name}: {skill.reason}
        </p>
      ))}

      {error === null ? null : (
        <p
          role="alert"
          className="rounded-[5px] border border-red px-2.5 py-1.5 text-[11.5px] text-red"
        >
          {error}
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[150px_minmax(0,1fr)] gap-3">
        <div className="flex flex-col overflow-y-auto rounded-[7px] border border-border">
          {rows.map((row) => {
            const active = row.name === open;
            const broken = row.reason !== null;

            return (
              <button
                key={row.name}
                type="button"
                // An invalid skill has nothing to open: main could not read a
                // name out of it, so there is no file this pane could address.
                disabled={broken}
                onClick={() => openSkill(row.name)}
                className={`flex items-center justify-between gap-2 border-b border-border-soft px-2.5 py-1.5 text-left text-[12.5px] last:border-b-0 ${
                  active ? 'bg-active text-ink' : 'text-muted'
                } ${broken ? 'cursor-default' : 'hover:bg-hover hover:text-ink'}`}
              >
                <span className="truncate font-mono">
                  {broken ? row.name : `/${row.name}`}
                </span>
                {broken ? (
                  <span className="shrink-0 text-[11px] text-amber">invalid</span>
                ) : null}
                {active && dirty ? (
                  <span className="shrink-0 text-[11px] text-brand">edited</span>
                ) : null}
              </button>
            );
          })}

          <button
            type="button"
            onClick={newSkill}
            className="border-t border-border-soft px-2.5 py-1.5 text-left font-mono text-[12.5px] text-brand hover:bg-hover"
          >
            + New skill
          </button>
        </div>

        {buffer === null ? (
          <div className="flex items-center justify-center rounded-[7px] border border-dashed border-border px-4 text-center text-[11.5px] text-subtle">
            Select a skill, or write a new one.
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-2">
            <SkillEditor
              path={open === null ? null : `${snapshot.skillsRoot}/${open}/SKILL.md`}
              body={buffer}
              dirty={dirty}
              problem={problem}
              onChange={setBuffer}
              onSave={save}
              onDelete={remove}
            />

            {pending === null ? null : (
              <SkillDiscardConfirm
                question={pending.question}
                detail={pending.detail}
                confirmLabel={pending.confirmLabel}
                onConfirm={() => {
                  pending.act();
                  setPending(null);
                }}
                onCancel={() => setPending(null)}
              />
            )}
          </div>
        )}
      </div>

      <p className="text-[11px] text-subtle">
        Skills folder: {snapshot.skillsRoot}
      </p>
    </div>
  );
}

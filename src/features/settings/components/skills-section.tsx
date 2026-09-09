import { useEffect, useState } from 'react';

import { useSwarmPhrase } from '@/hooks/use-swarm-phrase';
import {
  deleteSkill,
  dropIntoSkill,
  frontmatterName,
  importIntoSkill,
  loadSkills,
  makeSkillDir,
  moveSkillFile,
  readSkillFile,
  removeSkillFile,
  renameSkill,
  saveSkill,
  skillDropTokens,
  skillNameProblem,
  writeSkillFile,
} from '@/lib/skills';

import { SwarmCreature } from '@components/ui/swarm-creature';
import { REMOTE_DISABLED_REASON } from '@config/runtime';
import { SettingsSectionHeader } from '@features/settings/components/settings-section-header';
import { SkillBundle } from '@features/settings/components/skill-bundle';
import { SkillDiscardConfirm } from '@features/settings/components/skill-discard-confirm';
import { SkillEditor } from '@features/settings/components/skill-editor';
import { SkillPathPrompt } from '@features/settings/components/skill-path-prompt';
import { useRemoteCapabilities } from '@hooks/use-project-config';
import { useSkills } from '@hooks/use-skills';
import type { FsRefusalReason } from '@shared/fs-contract';

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
 * A 190px column beside the editor, and that column **drills in** (HIVE-148).
 * Pick a skill and the list becomes that skill's file tree under a `‹ Skills`
 * crumb, with its SKILL.md already open; the editor keeps its full width at
 * every depth.
 *
 * This reverses what stood here, and the reversal is worth recording rather
 * than quietly overwriting. Master–detail was chosen over a drill-in on
 * browser-rendered mockups, and it was the right choice **while a skill was one
 * file**: a flat list of names has nothing to drill into, and keeping the set
 * in view cost nothing. A skill is a folder now, and a folder cannot be a
 * column of names.
 *
 * The alternatives were weighed again and lost for reasons the first round
 * never faced. A file-chip strip cannot show a folder as a folder. A third
 * column leaves the editor about 232px on a 1440px window, which is not an
 * editor. What the drill-in costs is the set of skills leaving the screen while
 * you are inside one, and the crumb is the whole of the answer to that.
 *
 * 190 rather than the 150 this pane opened at, and the same 190 the agents
 * pane took: a row here is `/name` in monospace with an `invalid` or `edited`
 * flag beside it, and at 150 a name of any length ellipsised while the detail
 * pane sat on width it was not short of. The two panes are the same shape and
 * are read one after the other, so a reader switching between them should not
 * find the list moving under them.
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
  const { importSkillFiles } = useRemoteCapabilities();

  /** Which skill is open, or `null` for a new one that has never been saved. */
  const [open, setOpen] = useState<string | null>(null);
  const [buffer, setBuffer] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /**
   * Which skill's files the 190px column is showing, or `null` for the list
   * (HIVE-148).
   *
   * A second level of navigation in one column rather than a third column: at
   * 190 + 190 the editor is left about 232px on a 1440px window, which is not
   * an editor. Drilling in keeps the editor's full width at every depth.
   */
  const [drilled, setDrilled] = useState<string | null>(null);
  /**
   * Which file inside that bundle is open, or `null` for its SKILL.md.
   *
   * Kept beside `open` rather than folded into it: `open` is a *skill* name and
   * every existing rule in this component — the dirty guard, the rename, the
   * `taken` list — is written about skill names. Overloading it to sometimes
   * mean a file path would quietly change what all of them mean.
   */
  const [openPath, setOpenPath] = useState<string | null>(null);
  /** A refused file's reason and size, or `null` when the buffer is real. */
  const [refusal, setRefusal] = useState<{
    reason: FsRefusalReason;
    size: number;
  } | null>(null);
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
    /**
     * Does editing the buffer invalidate this question? (HIVE-99)
     *
     * Only the rename one, and the difference is what each question *quotes*.
     * "Rename /standup to /stand-up?" reads its destination out of the buffer,
     * and this confirm is deliberately not modal — it appears beside a live
     * editor the user can keep typing in. Type on, and the question is
     * asking about text that is no longer on screen, while `act` would write
     * the text that was. Neither honouring the stale question nor silently
     * switching to the new one is honest, so the question goes away and Save
     * asks the current one.
     *
     * "Discard changes to /standup?" quotes nothing from the buffer — more
     * typing only makes it more true — so it stays put, and the existing
     * Escape-from-the-editor behaviour is unchanged.
     */
    staleOnEdit?: boolean;
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

  /** Type into the buffer, retiring any question that quoted it (HIVE-99). */
  const edit = (next: string): void => {
    setBuffer(next);
    if (pending?.staleOnEdit === true) setPending(null);
  };

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

  /**
   * Drill into a skill's files, opening its SKILL.md (HIVE-148).
   *
   * Behind the same dirty guard as every other navigation here, and for the
   * same reason: the buffer belongs to whatever was last opened, and a drill-in
   * is a move away from it.
   */
  const drillInto = (name: string): void => {
    guard(
      () => {
        setDrilled(name);
        setOpen(name);
        setOpenPath('SKILL.md');
        setRefusal(null);
        setBuffer(null);
        setSaved(null);
        setError(null);
        void openFile(name, 'SKILL.md');
      },
      discardQuestion,
      discardDetail,
      'Discard',
    );
  };

  /**
   * Read one file out of a bundle into the editor.
   *
   * The same stale-response check `openSkill` documents, keyed on the *path*
   * as well as the name: two quick clicks in the tree race exactly as two
   * clicks in the skill list do, and whichever read resolves last would
   * otherwise land under the other row's header.
   */
  const openFile = async (name: string, path: string): Promise<void> => {
    const file = await readSkillFile(name, path);

    setOpenPath((current) => {
      if (current !== path) return current;
      /*
        A rejected read, not `null` left to mean nothing happened (HIVE-148
        review). `readSkillFile` resolves `null` for a channel that threw —
        `EISDIR` through a symlink `bundle.ts` used to call a file,
        `ENOENT` through a dangling one, `OutsideSkillError` through one
        resolving outside the bundle — and every caller here had already
        cleared the buffer before this ran. Returning without setting `error`
        left the pane on its own empty-state text with no way to tell a
        failed read from nothing selected, and no error line to explain it.
      */
      if (file === null) {
        setError(`"${path}" could not be read.`);
        return current;
      }
      if (file.refused === null) {
        setRefusal(null);
        setBuffer(file.body ?? '');
        setSaved(file.body ?? '');
      } else {
        // A font is not a failure. The panel keeps a path, a size and a Delete.
        setRefusal({ reason: file.refused, size: file.size });
        setBuffer('');
        setSaved('');
      }
      return current;
    });
  };

  const openInBundle = (path: string): void => {
    if (drilled === null) return;
    guard(
      () => {
        setOpenPath(path);
        setRefusal(null);
        setBuffer(null);
        setSaved(null);
        setError(null);
        void openFile(drilled, path);
      },
      discardQuestion,
      discardDetail,
      'Discard',
    );
  };

  /**
   * A one-field question about a path, or `null`.
   *
   * New file, new folder and rename are the same question with a different
   * verb, so they share one piece of state rather than three flags that can
   * disagree about which is showing.
   */
  const [prompt, setPrompt] = useState<{
    question: string;
    hint: string;
    confirmLabel: string;
    initial: string;
    act: (path: string) => void;
  } | null>(null);

  /** Bring files in from outside, through main's own picker. */
  const importToBundle = (): void => {
    if (drilled === null) return;
    // Belt over the disabled menu item below (HIVE-144): `skills:file:import`
    // opens a dialog on the server, which has no window — and would copy the
    // server's files, not the user's.
    if (!importSkillFiles) return;
    void importIntoSkill(drilled, '').then(setError);
  };

  const newFile = (): void => {
    if (drilled === null) return;
    const skillName = drilled;
    setPrompt({
      question: 'New file',
      hint: 'A path inside the skill, at most four folders deep.',
      confirmLabel: 'Create',
      initial: '',
      act: (path) => {
        /*
          Refused here, before main ever sees it (HIVE-148 review). Writing
          an empty body to a path that already holds a file — including
          `SKILL.md`, which the manifest may not even list (`skill-bundle.tsx`
          adds that row itself when a large bundle's walk order left it out)
          — would silently empty it. `write` is the verb for `SKILL.md`,
          which the pane already uses for it; every other existing file is
          edited by opening it, not by typing its path into "New file" a
          second time. Reported the way every other refusal in this pane is:
          into `error`, a sentence, never a resolved promise the caller
          mistakes for success.
        */
        const bundle = skills.find((entry) => entry.name === skillName);
        const taken =
          path === 'SKILL.md' ||
          (bundle?.manifest.entries.some(
            (entry) => entry.path === path && entry.kind === 'file',
          ) ??
            false);
        if (taken) {
          setError(`"${path}" already exists in this skill.`);
          return;
        }

        /*
          Created empty, and opened. A template would be this pane guessing at
          a file type it has no way to know — the bundle holds Python, JSON,
          shell and fonts, and only the shebang rule cares which.
        */
        void writeSkillFile(skillName, path, '').then((failure) => {
          setError(failure);
          if (failure !== null) return;
          setOpenPath(path);
          setRefusal(null);
          setBuffer('');
          setSaved('');
        });
      },
    });
  };

  const newFolder = (): void => {
    if (drilled === null) return;
    const skillName = drilled;
    setPrompt({
      question: 'New folder',
      hint: 'A path inside the skill, at most four folders deep.',
      confirmLabel: 'Create',
      initial: '',
      act: (path) => {
        void makeSkillDir(skillName, path).then(setError);
      },
    });
  };

  /** Rename the open file inside its bundle. */
  const renameOpenFile = (): void => {
    if (drilled === null || openPath === null) return;
    const skillName = drilled;
    const from = openPath;
    setPrompt({
      question: `Rename ${from}`,
      hint: 'Moving it into a folder that does not exist creates one.',
      confirmLabel: 'Rename',
      initial: from,
      act: (to) => {
        if (to === from) return;
        void moveSkillFile(skillName, from, to).then((failure) => {
          setError(failure);
          if (failure !== null) return;
          // Follow the file, the way `commit` follows a renamed skill: leaving
          // the pane on a path that no longer exists is how HIVE-99's
          // unrecoverable state began.
          setOpenPath(to);
          void openFile(skillName, to);
        });
      },
    });
  };

  /**
   * Copy dropped files in.
   *
   * The renderer never sees a path: `skillDropTokens` asks preload to mint an
   * opaque id per `File` the browser vouched for, and only those ids cross.
   * A drop of files preload could not vouch for mints nothing, so nothing is
   * sent rather than something wrong being sent.
   */
  const dropIntoBundle = (dir: string, files: readonly File[]): void => {
    if (drilled === null) return;
    const tokens = skillDropTokens([...files]);
    if (tokens.length === 0) return;
    void dropIntoSkill(drilled, dir, tokens).then(setError);
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

  /**
   * Write the buffer, moving the folder first when the name changed.
   *
   * `from` is the name the file is currently under, or `null` when there is
   * nothing to move — a skill saved under its own name, or one that has never
   * been on disk at all.
   */
  const commit = (from: string | null, body: string): void => {
    /*
      Only claim success when there was one.

      `saveSkill` used to resolve either way, so the success path ran
      unconditionally: the badge flipped to "saved" and the path header pointed
      at a file main had refused to write. Being told a skill is saved while it
      is not is worse than the failure itself, because the user stops looking.
    */
    const settle = (moved: boolean, failure: string | null): void => {
      /*
        Follow the file the moment it moves, even into a failure.

        A move that lands before a failed write leaves the folder under the new
        name with the old frontmatter inside it. Leaving `open` behind then
        makes the pane's own `taken` list contain the name the user is trying
        to save — `skillNameProblem` answers "you already have a skill called
        …", Save goes disabled, and the invalid row cannot be opened either, so
        the only way out is a text editor. Moving `open` with the file turns
        the retry back into an ordinary Save.
      */
      if (moved) setOpen(typed);
      if (failure !== null) {
        setError(failure);
        return;
      }
      setError(null);
      setSaved(body);
    };

    if (from === null) {
      void saveSkill(typed, body).then((failure) =>
        settle(failure === null, failure),
      );
      return;
    }

    void renameSkill(from, typed, body).then(({ moved, error }) =>
      settle(moved, error),
    );
  };

  /**
   * Is the editor showing a file *other than* the skill's own SKILL.md?
   *
   * The difference decides what Save and Delete mean, and getting it wrong is
   * not cosmetic: saving `scripts/build.py` through the skill-level verb would
   * write its bytes into SKILL.md under the frontmatter name, and deleting it
   * would remove the whole bundle.
   */
  const inFile =
    drilled !== null && openPath !== null && openPath !== 'SKILL.md';

  const save = (): void => {
    if (buffer === null) return;

    if (inFile && drilled !== null && openPath !== null) {
      const body = buffer;
      void writeSkillFile(drilled, openPath, body).then((failure) => {
        if (failure !== null) {
          setError(failure);
          return;
        }
        setError(null);
        setSaved(body);
      });
      return;
    }

    if (problem !== null) return;
    const body = buffer;

    /*
      A changed name is a **rename**, and it asks first (HIVE-99).

      The folder is mirrored from the frontmatter, so editing `name:` and
      pressing Save used to write the new folder and leave the old one — still
      valid, still listed, still injected. One action produced two live
      commands and the user was left to find the fork themselves.

      Moving a file the user did not ask to delete is the thing HIVE-96 would
      not do silently, and this does not do it silently either: it asks, in the
      confirm this pane already owns, and only then moves. `open === null` is a
      skill that has never been saved — there is nothing on disk to move, so
      there is nothing to ask about.
    */
    if (open !== null && typed !== open) {
      setPending({
        question: `Rename /${open} to /${typed}?`,
        // The second sentence is not decoration. A running session was started
        // with the old plugin directory and keeps the command it was given —
        // worth saying, because the user's next move is to try it in a live
        // terminal and be confused when it still works.
        detail:
          'The old command stops working. Sessions already running keep it until they end.',
        confirmLabel: 'Rename',
        act: () => commit(open, body),
        // The question quotes `typed`, and `act` closes over `body`. Both are
        // this render's — so an edit retires the question rather than letting
        // it answer for text that is no longer on screen.
        staleOnEdit: true,
      });
      return;
    }

    // `null`, not `open`: an unchanged name has nothing to move, and asking
    // main to rename a folder onto itself would be a syscall to say so.
    commit(null, body);
  };

  const remove = (): void => {
    /*
      Inside a bundle, Delete removes the *file* on screen — not the skill.
      Removing the skill is the crumb, the list, and that row's own Delete,
      which still asks and still counts what it takes.
    */
    if (inFile && drilled !== null && openPath !== null) {
      const path = openPath;
      const skillName = drilled;
      setPending({
        question: `Delete ${path}?`,
        detail:
          'Removes it from the skill folder. Sessions already running keep the copy they were given.',
        confirmLabel: 'Delete',
        act: () => {
          void removeSkillFile(skillName, path).then((failure) => {
            if (failure !== null) {
              setError(failure);
              return;
            }
            setError(null);
            // Back to the file that is always there, rather than an empty
            // panel over a row that no longer exists.
            setOpenPath('SKILL.md');
            setRefusal(null);
            setBuffer(null);
            setSaved(null);
            void openFile(skillName, 'SKILL.md');
          });
        },
      });
      return;
    }

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
      detail: `Removes ${String(fileCount)} ${fileCount === 1 ? 'file' : 'files'} under ${snapshot?.skillsRoot ?? 'the skills folder'}/${target}. Sessions already running keep the command until they end.`,
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

  /** The drilled skill's own summary, or `undefined` when showing the list. */
  const drilledSkill = skills.find((skill) => skill.name === drilled);

  /**
   * Back out of a drill-in when a bundle file is left addressing a skill
   * that just fell out of the valid list (HIVE-148 review).
   *
   * `drilledSkill !== undefined` is what the column below already reads to
   * decide whether it shows `SkillBundle` or the list, and it already swaps
   * back on its own — that much needs no fix. What does: `drilled` and
   * `openPath` were never cleared alongside it, so `inFile` kept answering
   * as though a file inside that bundle were still open, and Save/Delete
   * kept targeting a skill no longer on screen. Reachable straight from
   * finding 1's own repair — typing an existing bundle path into "New file"
   * used to blank it, `readUserSkills` then reports the skill invalid on the
   * next sync, and it drops out of `skills` while a bundle file was open.
   *
   * Scoped to `inFile`, deliberately not to every `drilledSkill === undefined`
   * — HIVE-99's own recovery state relies on the opposite: mid-rename, with
   * `openPath` still `'SKILL.md'` (`inFile` false), the skill is reported
   * *invalid* rather than gone, `open` already followed the move, and the
   * pane must keep the editor exactly as it is so Save can retry. Resetting
   * there would silently discard the one state that recovery depends on.
   */
  useEffect(() => {
    if (drilled !== null && drilledSkill === undefined && inFile) {
      setDrilled(null);
      setOpenPath(null);
      setRefusal(null);
      setBuffer(null);
      setSaved(null);
      setError(null);
    }
  }, [drilled, drilledSkill, inFile]);

  /**
   * How many files deleting this skill would take with it.
   *
   * Counted from the manifest rather than guessed: "Removes the folder" was
   * accurate when a skill was one file, and is not a sentence to show someone
   * about to delete a bundle of forty.
   */
  const fileCount =
    drilledSkill?.manifest.entries.filter((entry) => entry.kind === 'file')
      .length ?? 0;

  const description =
    'Slash commands available only inside sessions The Hive starts. Saved as SKILL.md under ~/.hive/skills. A skill can end with /done handoff to close its session.';

  /*
    No snapshot is the browser demo, which has no bridge to ask and no disk to
    write to — the same header-only shape `runtime-section.tsx` uses, and for
    the same reason: a pane of dead controls teaches the user the app is broken.
  */
  if (!snapshot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
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
          explicitly not a centred block. A bordered box around the creature and
          an invitation reads as a furnished, empty place; a bare heading above a
          button reads as a broken render.
        */}
        <div className="flex flex-col items-center gap-1 rounded-[7px] border border-dashed border-border px-4 py-6 text-center">
          <SwarmCreature creature="hive" size={72} />
          <span className="text-[11.5px] text-muted">{phrase}</span>
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

      <div className="grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)] gap-3">
        {drilledSkill !== undefined ? (
          <SkillBundle
            skill={drilledSkill}
            openPath={openPath}
            dirty={dirty}
            onBack={() => {
              guard(
                () => {
                  setDrilled(null);
                  setOpenPath(null);
                  setRefusal(null);
                  setBuffer(null);
                  setSaved(null);
                  setError(null);
                },
                discardQuestion,
                discardDetail,
                'Discard',
              );
            }}
            onOpen={openInBundle}
            onNewFile={newFile}
            onNewFolder={newFolder}
            onImport={importToBundle}
            importDisabled={!importSkillFiles}
            importDisabledReason={
              importSkillFiles ? null : REMOTE_DISABLED_REASON.importSkillFiles
            }
            onDrop={dropIntoBundle}
          />
        ) : (
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
                // A valid skill drills into its files; SKILL.md opens with it,
                // so the one-click path to the thing people edit most is
                // unchanged from when a skill was a single file.
                onClick={() => {
                  drillInto(row.name);
                }}
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
        )}

        {/*
          `prompt` and `pending` used to render only inside the `buffer !==
          null` branch below (HIVE-148 review). A read that fails — the
          previous fix's own new error state — leaves `buffer` `null` on
          purpose, so the pane can show its error line instead of a stale
          editor. But `+ Add → New file` still opens through `setPrompt`
          regardless, and with the old nesting that state rendered nothing at
          all: the question existed, had no box to show it in, and no key ever
          reached it. Both now sit beside whichever of the placeholder or the
          editor is showing, one grid cell, not inside either branch.
        */}
        <div className="flex min-h-0 flex-col gap-2">
          {buffer === null ? (
            <div className="flex flex-1 items-center justify-center rounded-[7px] border border-dashed border-border px-4 text-center text-[11.5px] text-subtle">
              Select a skill, or write a new one.
            </div>
          ) : (
            <SkillEditor
              path={
                open === null
                  ? null
                  : `${snapshot.skillsRoot}/${open}/${openPath ?? 'SKILL.md'}`
              }
              body={buffer}
              dirty={dirty}
              /*
                The frontmatter name rule governs SKILL.md and nothing else. A
                `scripts/build.py` has no frontmatter, so carrying `problem`
                here would disable Save on every other file in the bundle for a
                rule that does not apply to it.
              */
              problem={openPath === null || openPath === 'SKILL.md' ? problem : null}
              refused={refusal?.reason ?? null}
              size={refusal?.size ?? 0}
              onChange={edit}
              onSave={save}
              onDelete={remove}
              // A SKILL.md is renamed by editing its frontmatter, which is a
              // rename of the whole skill and already asks its own question.
              onRename={inFile ? renameOpenFile : undefined}
            />
          )}

          {prompt === null ? null : (
            <SkillPathPrompt
              question={prompt.question}
              hint={prompt.hint}
              confirmLabel={prompt.confirmLabel}
              initial={prompt.initial}
              onConfirm={(path) => {
                prompt.act(path);
                setPrompt(null);
              }}
              onCancel={() => {
                setPrompt(null);
              }}
            />
          )}

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
      </div>

      <p className="text-[11px] text-subtle">
        Skills folder: {snapshot.skillsRoot}
      </p>
    </div>
  );
}

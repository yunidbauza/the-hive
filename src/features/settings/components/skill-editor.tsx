import { useEffect, useRef } from 'react';

import { EditorSurface } from '@components/editor/editor-surface';
import { languageFor } from '@lib/explorer/language';
import { useEditorAppearance } from '@stores/appearance-store';

/**
 * The markdown grammar, resolved once at module scope.
 *
 * `EditorSurface` re-imports the grammar whenever this identity changes, so a
 * loader built in render would fetch the chunk on every keystroke. A SKILL.md
 * is always markdown — there is no file name to branch on here as there is in
 * the explorer — so the loader is a constant rather than a memo.
 */
const SKILL_LANGUAGE = languageFor('SKILL.md')?.load ?? null;

interface SkillEditorProps {
  /** The file being edited, or `null` while its contents are still arriving. */
  path: string | null;
  body: string;
  dirty: boolean;
  /** Why the typed name cannot be saved, or `null`. Disables Save when set. */
  problem: string | null;
  onChange: (body: string) => void;
  onSave: () => void;
  onDelete: () => void;
}

/**
 * The editor half of Settings › Skills (HIVE-96).
 *
 * ## Why CodeMirror and not a plain `<textarea>`
 *
 * This used to argue the other way: the editor seam exists for **repo files**,
 * a SKILL.md is a few lines of frontmatter and a paragraph, and mounting a full
 * editor for it would give the user a code editor for writing a sentence.
 *
 * Two things overtook that. The footer's whole job is to explain a refusal, and
 * a refusal about the frontmatter is about a *line* the reader then had to
 * count with a finger. And Settings' other document pane — the agent Source tab
 * — mounted `EditorSurface` for exactly those reasons, which made this the odd
 * one out: two panes, two floors away from each other, where ⌘F worked in one
 * and offered to search the page in the other.
 *
 * `EditorSurface` brings the gutter, the floating find panel, and `Mod-s` bound
 * *inside* the view — the only place a save shortcut can be bound and still
 * fire while CodeMirror holds focus. The chunk is lazy, so a session that never
 * opens a skill never loads it.
 *
 * `env-editor.tsx` still argues against a text box for env vars, and still
 * correctly: that argument is about *structured* data — name/value pairs, which
 * are genuinely better as rows — and does not reach a document.
 */
export function SkillEditor({
  path,
  body,
  dirty,
  problem,
  onChange,
  onSave,
  onDelete,
}: SkillEditorProps) {
  const appearance = useEditorAppearance();

  /**
   * Save, or refuse exactly as the button does.
   *
   * The Save button carries a literal `disabled` while `problem` is set, so a
   * shortcut that wrote anyway would be a second, *louder* route past a rule
   * the visible control enforces — and it would write a skill under a name the
   * pane had already said it would not accept. Doing nothing is not silence:
   * the footer is showing that reason in red the whole time, which is the same
   * explanation the disabled button offers.
   *
   * (The agent editor's ⌘S needs no such guard, because its Save is never
   * disabled — `agents-section.tsx` refuses inside the handler instead.)
   */
  const save = (): void => {
    if (problem === null) onSave();
  };

  /**
   * The live `save`, for a listener bound once on mount.
   *
   * `problem` and `onSave` both change between renders, so binding directly
   * would either re-attach on every keystroke or, with an empty dependency
   * array, capture the first render's rule forever — and "forever" here means a
   * pane that keeps saving under a name it has since started refusing.
   */
  const saveRef = useRef(save);
  saveRef.current = save;

  /**
   * ⌘S from anywhere in the pane, and exactly once.
   *
   * CodeMirror's own binding covers the editor, which is most of this pane —
   * this is for the rest of it: the footer buttons, and the moment after a
   * click on the skill list when nothing here holds focus at all.
   *
   * A native listener on the frame rather than a JSX `onKeyDown`, the way
   * `agent-editor.tsx` and `editor-pane.tsx` both bind theirs: a keyboard
   * handler on a non-interactive `<div>` is what `jsx-a11y` exists to reject,
   * and the rule is right — the shortcut must never be the only way to save,
   * which is why the Save button below stays exactly where it is. Scoped to the
   * frame rather than to `window`, because settings is an overlay over a shell
   * full of live terminals.
   *
   * `defaultPrevented` keeps the two bindings from doubling up: CodeMirror
   * prevents the default when it handles `Mod-s`, and the event still bubbles
   * out here.
   */
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = frame.current;
    if (host === null) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 's' || !(event.metaKey || event.ctrlKey)) return;
      if (event.defaultPrevented) return;

      event.preventDefault();
      saveRef.current();
    };

    host.addEventListener('keydown', onKeyDown);

    return () => {
      host.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div
      ref={frame}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[7px] border border-border"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border-soft px-2.5 py-1.5">
        {/*
          The path, not the name. The name is already on the row that is
          selected, and what the header adds is *where the bytes go* — which is
          the fact a user needs when they go looking for the file outside the
          app.

          `min-w-0` is load-bearing, not decoration: a flex item's default
          `min-width: auto` refuses to shrink below its content, so `truncate`
          never engages and a long path pushes the state badge off the panel
          instead of ellipsising. Every path here is absolute and most are long.
        */}
        <span className="min-w-0 truncate font-mono text-[11px] text-subtle">
          {path ?? 'New skill'}
        </span>
        <span
          className={
            dirty
              ? 'shrink-0 text-[11px] text-brand'
              : 'shrink-0 text-[11px] text-subtle'
          }
        >
          {dirty ? 'unsaved' : 'saved'}
        </span>
      </div>

      {/*
        `readOnly` is hard-`false`, and deliberately not `!appearance.editable`.
        That setting is the explorer's guard against editing repo files by
        accident; this pane exists to write this one file, and a settings editor
        that silently refused every keystroke because of a preference set three
        panes away would read as broken.

        The `fileKey` is the path, so the caret and the undo history survive a
        click away and back — and a *different* skill gets a different key,
        which is what stops one skill's undo stack reaching into another's file.
        A never-saved skill has no path, and every never-saved skill is the same
        draft, so they share one key.
      */}
      <EditorSurface
        ariaLabel="Skill source"
        fileKey={path ?? 'new-skill'}
        value={body}
        languageLoad={SKILL_LANGUAGE}
        readOnly={false}
        fontFamily={appearance.fontFamily}
        fontSize={appearance.fontSize}
        wordWrap={appearance.wordWrap}
        lineNumbers={appearance.lineNumbers}
        tabWidth={appearance.tabWidth}
        onChange={onChange}
        onSave={save}
      />

      <div className="flex items-center justify-between gap-3 border-t border-border-soft px-2.5 py-1.5">
        {/*
          One line, two jobs: the naming rule while everything is fine, and the
          reason while it is not. A disabled Save with no explanation is the
          failure this replaces.
        */}
        <span
          className={
            problem === null
              ? 'min-w-0 text-[11px] text-subtle'
              : 'min-w-0 text-[11px] text-red'
          }
        >
          {problem ?? 'The name in the frontmatter names the folder and the command.'}
        </span>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-border px-2.5 py-1 text-[12px] text-red hover:bg-hover"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={problem !== null}
            className="rounded-md bg-brand-fill px-2.5 py-1 text-[12px] text-on-brand hover:bg-brand-fill-hover disabled:opacity-60"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

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
 * ## Why a plain `<textarea>` and not CodeMirror
 *
 * The editor seam (`src/components/editor/`) exists for **repo files** — a
 * project's source, opened from the explorer, where syntax and a gutter earn
 * their weight. A SKILL.md is a short form: a few lines of frontmatter and a
 * paragraph of instruction. Mounting a full editor for it would pull the
 * explorer's whole stack into settings and give the user a code editor for
 * writing a sentence.
 *
 * This is the first `<textarea>` in settings, and `env-editor.tsx` argues
 * against one — for env vars, which are a list of name/value pairs and are
 * genuinely better as rows. The argument is about *structured* data and does not
 * reach a document.
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
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[7px] border border-border">
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

      <textarea
        aria-label="Skill source"
        spellCheck={false}
        value={body}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-0 flex-1 resize-none bg-panel px-2.5 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none"
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

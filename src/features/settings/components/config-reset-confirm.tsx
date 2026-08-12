import { useEffect, useRef, type KeyboardEvent } from 'react';

interface ConfigResetConfirmProps {
  /** Projects in the current snapshot. Zero is valid — the file may be empty. */
  projectCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm resetting the config file (story 107).
 *
 * ## Why inline
 *
 * `project-remove-confirm.tsx` exactly, rather than a second dialect of
 * "confirm a destructive thing". The epic's first binding decision is that
 * settings is a full-stage overlay and explicitly not a modal, because "a modal
 * floating over thirteen live terminals fights the attention model" — and that
 * reasoning does not stop applying because this particular action is the larger
 * one. Expanding in place keeps the group that asked the question as the thing
 * being answered.
 *
 * ## What it says is the design
 *
 * Reset is the **only** write in the app that discards what it did not write.
 * Every other verb spreads the document it read, so unknown top-level keys and
 * the user's own `"//"` comments survive; this one replaces them. Naming the
 * comments specifically is the point rather than a flourish: the template is
 * deliberately comment-heavy, the product encourages hand-editing, and a user
 * who has annotated their config is exactly the user this confirmation exists
 * for.
 *
 * It does **not** claim anything happens to their repositories. Resetting
 * forgets where they are; the directories on disk are untouched and the PTYs
 * already running keep running, exactly as with a removed project. Wording this
 * as data loss would be false, and false is worse than frightening.
 */
export function ConfigResetConfirm({
  projectCount,
  onConfirm,
  onCancel,
}: ConfigResetConfirmProps) {
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    /*
      Focus lands on Cancel, never Reset: the destructive option should not be
      one stray Enter away the moment the group changes shape.

      In an effect rather than with `autoFocus`, which `jsx-a11y` bans — rightly,
      for the usual case of a page stealing focus on load. This is the opposite:
      the user just asked for this, and a confirmation they had to go find with
      the mouse would be the accessibility problem.
    */
    cancel.current?.focus();
  }, []);

  const projects = projectCount === 1 ? '1 project' : `${projectCount} projects`;

  /**
   * Escape backs out, listened for on the buttons rather than the container.
   *
   * The container carries `role="alertdialog"`, which `jsx-a11y` classes as
   * non-interactive — and it is right that a plain region should not listen for
   * keys. Focus starts on Cancel and the only other stop is Reset, so the two
   * buttons cover every position focus can hold inside this confirmation.
   */
  const escapes = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    /*
      Stops bubble-phase ancestors seeing it. Keeping the settings dialog open
      is a separate matter — Radix decides on a document-capture listener that
      runs first, which `data-escape-scope` below is what answers.
    */
    event.stopPropagation();
    onCancel();
  };

  return (
    <div
      role="alertdialog"
      // Claims Escape from the settings dialog — see `settings-overlay.tsx`.
      data-escape-scope=""
      aria-label="Reset the config file?"
      className="rounded-[7px] border border-red bg-red/8 px-3 py-2.5"
    >
      <p className="text-[12.5px] text-ink">
        Reset the config file to the first-run template?
      </p>
      <p className="mt-0.5 text-[11.5px] text-subtle">
        {projects}, every per-project shell, command and environment override,
        and your notification preferences are forgotten. Any comments you added
        to the file go too — this is the one write that does not preserve them.
        Nothing on disk is deleted: the repositories stay where they are, and
        sessions already running keep running.
      </p>
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          ref={cancel}
          type="button"
          onClick={onCancel}
          onKeyDown={escapes}
          className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          onKeyDown={escapes}
          className="rounded-md bg-red px-2.5 py-1 text-[12px] font-medium text-bg hover:opacity-90"
        >
          Reset config
        </button>
      </div>
    </div>
  );
}

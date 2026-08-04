import { useEffect, useRef, type KeyboardEvent } from 'react';

interface ProjectRemoveConfirmProps {
  projectName: string;
  /** How many of this project's sessions are not done. Zero is valid. */
  liveSessionCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm removing a project, in the row's own place (story 103).
 *
 * ## Why inline
 *
 * Story 101 disabled this remove and left a tooltip; the epic's first binding
 * decision is that settings is a full-stage overlay and explicitly *not* a
 * modal, because "a modal floating over thirteen live terminals fights the
 * attention model". Expanding the row keeps that instinct: the row is already
 * the subject of the question, so nothing has to float to ask it, the list does
 * not move under an accidental Cancel, and no new primitive is needed. The
 * alternatives — a centred `ui/dialog.tsx` card, and a 102-style focused
 * sub-view — were both rejected on browser-rendered mockups.
 *
 * ## What it says is the design
 *
 * Removing a project deletes its config entry. It does **not** kill anything:
 * the PTYs keep running and the tabs stay open, and the sessions simply stop
 * resolving to a mapped project, exactly like a session whose folder was never
 * mapped. Wording this as data loss would be false, and killing a user's live
 * terminals as a side-effect of a settings edit would be a far larger action
 * than this story is authorised to take.
 */
export function ProjectRemoveConfirm({
  projectName,
  liveSessionCount,
  onConfirm,
  onCancel,
}: ProjectRemoveConfirmProps) {
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    /*
      Focus lands on Cancel, never Remove: the destructive option should not be
      one stray Enter away the moment the row changes shape.

      Done in an effect rather than with `autoFocus`, which `jsx-a11y` bans —
      rightly, for the usual case of a page stealing focus on load. This is the
      opposite: the user just chose "Remove", and a confirmation they have to go
      find with the mouse would be the accessibility problem.
    */
    cancel.current?.focus();
  }, []);

  const sessions =
    liveSessionCount === 1
      ? '1 live session will keep running'
      : `${liveSessionCount} live sessions will keep running`;

  /**
   * Escape backs out, handled on the buttons rather than the container.
   *
   * The container carries `role="alertdialog"`, which `jsx-a11y` classes as
   * non-interactive — and it is right that a plain region should not be
   * listening for keys. The buttons *are* interactive, focus starts on Cancel
   * and the only other stop is Remove, so listening on both covers every
   * position focus can hold inside this confirmation. Escape pressed outside it
   * belongs to whatever does have focus, which is the correct behaviour rather
   * than a gap.
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
      aria-label={`Remove ${projectName}?`}
      className="border-b border-border-soft bg-red/8 px-3 py-2.5 last:border-b-0"
    >
      <p className="text-[12.5px] text-ink">
        Remove <span className="font-medium">{projectName}</span> from your
        projects?
      </p>
      <p className="mt-0.5 text-[11.5px] text-subtle">
        {sessions} — they just stop resolving to a folder. The directory on disk
        is untouched.
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
          Remove
        </button>
      </div>
    </div>
  );
}

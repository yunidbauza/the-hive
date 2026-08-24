import { useEffect, useRef } from 'react';

interface SkillDiscardConfirmProps {
  /** The whole question, e.g. `Discard changes to /ship-it?` */
  question: string;
  /** What the destructive button says — `Discard`, or `Delete`. */
  confirmLabel: string;
  /** The line under the question. What actually happens, in the user's terms. */
  detail: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm losing something, inside the pane that asked (HIVE-96).
 *
 * The same shape as `project-remove-confirm.tsx`, and for the same reasons that
 * file records: settings is a full-stage overlay and deliberately not a modal,
 * so nothing floats to ask a question about something already on screen, and
 * the answer arrives without the list moving under an accidental Cancel.
 *
 * Generalised over its question rather than copied twice, because this pane asks
 * two of them — abandon an edit, and delete a file — and they differ only in
 * wording. A second near-identical component would drift the moment one of the
 * two grew a detail.
 */
export function SkillDiscardConfirm({
  question,
  confirmLabel,
  detail,
  onConfirm,
  onCancel,
}: SkillDiscardConfirmProps) {
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    /*
      Focus lands on the safe button, never the destructive one: the option that
      loses work should not be one stray Enter away the moment the pane changes
      shape. An effect rather than `autoFocus`, which `jsx-a11y` bans for the
      ordinary case of a page stealing focus on load — this is the opposite, and
      a confirmation the user has to go find with the mouse would be the real
      accessibility problem.
    */
    cancel.current?.focus();
  }, []);

  /**
   * Escape backs out — from anywhere, on the document, in the capture phase.
   *
   * `project-remove-confirm.tsx` listens on its two buttons instead, and that
   * is sound *there*: it replaces the row it was launched from, so focus is
   * always one of those two. This confirm is different. It appears **beside a
   * live `<textarea>`**, and the caret usually stays in it — the user was
   * typing when they clicked another row. Escape pressed there reached neither
   * button, and `data-escape-scope` below had already told the settings overlay
   * to decline (`escapeIsClaimed` falls back to a document query, so any target
   * counts). The key did nothing at all: the overlay would not close and the
   * confirm would not cancel.
   *
   * Capture, so it runs before the textarea or anything else; `preventDefault`
   * and `stopPropagation` so the keystroke ends here rather than reaching Radix
   * and closing the whole overlay behind the question.
   */
  useEffect(() => {
    const escapes = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };

    document.addEventListener('keydown', escapes, true);
    return () => document.removeEventListener('keydown', escapes, true);
  }, [onCancel]);

  return (
    <div
      role="alertdialog"
      // Claims Escape from the settings overlay — see `settings-overlay.tsx`.
      data-escape-scope=""
      aria-label={question}
      className="rounded-[6px] border border-border-soft bg-red/8 px-3 py-2.5"
    >
      <p className="text-[12.5px] text-ink">{question}</p>
      <p className="mt-0.5 text-[11.5px] text-subtle">{detail}</p>
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          ref={cancel}
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
        >
          Keep editing
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md bg-red px-2.5 py-1 text-[12px] font-medium text-bg hover:opacity-90"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

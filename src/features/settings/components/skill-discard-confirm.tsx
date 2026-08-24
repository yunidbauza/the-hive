import { useEffect, useRef, type KeyboardEvent } from 'react';

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
   * Escape backs out, handled on the buttons rather than the container.
   *
   * The container is `role="alertdialog"`, which `jsx-a11y` classes as
   * non-interactive — rightly, for a plain region. The buttons are interactive,
   * focus starts on Cancel and the only other stop is the destructive one, so
   * listening on both covers every position focus can hold in here.
   */
  const escapes = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    /*
      Stops bubble-phase ancestors seeing it. Keeping the settings overlay open
      is a separate matter, decided by Radix on a document-capture listener that
      runs first — `data-escape-scope` below is what answers that one.
    */
    event.stopPropagation();
    onCancel();
  };

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
          onKeyDown={escapes}
          className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
        >
          Keep editing
        </button>
        <button
          type="button"
          onClick={onConfirm}
          onKeyDown={escapes}
          className="rounded-md bg-red px-2.5 py-1 text-[12px] font-medium text-bg hover:opacity-90"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

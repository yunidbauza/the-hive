import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from '@lib/utils';

interface InlineConfirmProps {
  /** The dialog's accessible name. */
  label: string;
  title: ReactNode;
  /** The body: what goes, and what does not. */
  children: ReactNode;
  confirmLabel: string;
  /** The border, which differs between a group and a list row. */
  className: string;
  /** The safe button's text. `Keep editing` where cancelling returns to a draft. */
  cancelLabel?: string;
  /**
   * Where Escape is caught.
   *
   * `bubble` (the default): on the two buttons, stopped before ancestors. Sound
   * where the confirm replaces the row it was launched from, because focus is
   * then always one of those two buttons.
   *
   * `document`: a capture-phase listener, for a confirm that sits **beside a
   * live editor** — the user was typing when they clicked another row, so the
   * caret is in CodeMirror and Escape reaches neither button. Before this
   * existed the key did nothing at all in that case: `data-escape-scope` had
   * already told the settings overlay to decline (`escapeIsClaimed` falls back
   * to a document query, so any target counts), and no button saw the key. The
   * listener captures, so it runs before CodeMirror; it preventDefaults and
   * stops propagation so the keystroke ends there rather than reaching Radix
   * and closing the whole overlay behind the question.
   */
  escape?: 'bubble' | 'document';
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A destructive action confirmed in place (stories 103 and 107).
 *
 * Settings is a full-stage overlay and explicitly not a modal, so the group or
 * row that asked the question expands to answer it rather than a card floating
 * over live terminals.
 */
export function InlineConfirm({
  label,
  title,
  children,
  confirmLabel,
  className,
  cancelLabel = 'Cancel',
  escape = 'bubble',
  onConfirm,
  onCancel,
}: InlineConfirmProps) {
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    /*
      Focus lands on Cancel, never the destructive button: it should not be
      one stray Enter away the moment the row changes shape.

      In an effect rather than with `autoFocus`, which `jsx-a11y` bans for the
      usual case of a page stealing focus on load. Here the user just asked
      for this, and a confirmation they had to go find with the mouse would be
      the accessibility problem.
    */
    cancel.current?.focus();
  }, []);

  useEffect(() => {
    if (escape !== 'document') return;

    const escapes = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };

    document.addEventListener('keydown', escapes, true);
    return () => document.removeEventListener('keydown', escapes, true);
  }, [escape, onCancel]);

  const escapes = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    /*
      Stops bubble-phase ancestors seeing it. Keeping the settings dialog open
      is a separate matter: Radix decides on a document-capture listener that
      runs first, which `data-escape-scope` below is what answers.
    */
    event.stopPropagation();
    onCancel();
  };

  return (
    <div
      role="alertdialog"
      // Claims Escape from the settings dialog; see `settings-overlay.tsx`.
      data-escape-scope=""
      aria-label={label}
      className={cn('bg-red/8 px-3 py-2.5', className)}
    >
      <p className="text-[12.5px] text-ink">{title}</p>
      <p className="mt-0.5 text-[11.5px] text-subtle">{children}</p>
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          ref={cancel}
          type="button"
          onClick={onCancel}
          onKeyDown={escapes}
          className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
        >
          {cancelLabel}
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

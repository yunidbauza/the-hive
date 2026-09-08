import { useEffect, useState } from 'react';

import { TextField } from '@components/ui/text-field';

/**
 * Ask for one path inside a bundle (HIVE-148).
 *
 * New file, new folder, rename — three questions with one shape, because they
 * differ only in the verb and what they start from. Written here rather than
 * reaching for a native prompt for the reason `skill-discard-confirm.tsx` gives
 * about its own question: a native dialog steals the window, cannot be styled,
 * and cannot show the rule it is enforcing beside the box.
 *
 * ## Why it validates nothing beyond emptiness
 *
 * `assertSkillPath` is the rule, and it lives at the IPC boundary where it
 * cannot be bypassed. Restating it here would be a second copy to keep in step
 * — and a wrong one, since it also normalises. A refused path comes back as
 * main's own sentence and lands in the pane's error line, which is where every
 * other refusal in this pane already appears.
 */
interface SkillPathPromptProps {
  question: string;
  /** The rule, shown under the box while nothing is wrong. */
  hint: string;
  confirmLabel: string;
  /** What the box starts with — the old path for a rename, empty otherwise. */
  initial?: string;
  onConfirm: (path: string) => void;
  onCancel: () => void;
}

export function SkillPathPrompt({
  question,
  hint,
  confirmLabel,
  initial = '',
  onConfirm,
  onCancel,
}: SkillPathPromptProps) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();

  const submit = (): void => {
    if (trimmed === '') return;
    onConfirm(trimmed);
  };

  /**
   * Escape backs out, on the document, in the capture phase.
   *
   * The same arrangement `skill-discard-confirm.tsx` documents at length, and
   * for the same reason: this question appears **beside a live editor** and the
   * caret usually stays in it, so a listener on the buttons would never see the
   * key — while `data-escape-scope` above has already told the overlay to
   * decline it. Without this, Escape would do nothing at all.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onCancel]);

  return (
    <div
      role="alertdialog"
      aria-label={question}
      // Read by `settings-overlay.tsx` on a document-capture listener, so
      // Escape cancels this question rather than closing the whole overlay
      // behind it. Same contract as `skill-discard-confirm.tsx`.
      data-escape-scope="skill-path-prompt"
      className="flex flex-col gap-1.5 rounded-[7px] border border-border bg-panel px-2.5 py-2"
    >
      <TextField
        label={question}
        value={value}
        hint={hint}
        onChange={setValue}
        onCommit={submit}
      />
      <div className="flex items-center justify-end gap-3">
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={trimmed === ''}
            className="rounded-md bg-brand-fill px-2.5 py-1 text-[12px] text-on-brand hover:bg-brand-fill-hover disabled:opacity-60"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

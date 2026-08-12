import { CaretDown } from '@phosphor-icons/react';
import { useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * A labelled dropdown (story 105).
 *
 * A **native `<select>`**, styled — not a hand-rolled listbox. The lists here
 * are short, flat, and unremarkable (font faces, sizes, scrollback depths), and
 * for that shape the platform menu wins outright: it is keyboard- and
 * screen-reader-correct with no code, it does not need a portal or a focus trap
 * fighting the settings overlay's own, and on a laptop it renders the OS menu
 * the user already knows.
 *
 * The caret is drawn rather than left to the UA because `appearance-none` is
 * what makes the control take the app's border and background at all.
 */

export interface SelectFieldOption {
  value: string;
  label: string;
}

interface SelectFieldProps {
  label: string;
  value: string;
  options: readonly SelectFieldOption[];
  onChange: (value: string) => void;
  /** Rendered under the control — the "not installed falls back" note. */
  hint?: string;
  className?: string;
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
  className,
}: SelectFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    /**
     * `htmlFor` rather than wrapping the control in the `<label>`.
     *
     * A wrapping label folds *all* of its text into the accessible name, so the
     * hint below would become part of it — "Font A face your system does not
     * have falls back to the default." The hint is a description, and
     * `aria-describedby` is what says so.
     */
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-[12.5px] text-muted">
        {label}
      </label>

      <span className="relative inline-flex items-center">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={hint ? hintId : undefined}
          className={cn(
            'w-full appearance-none rounded-[6px] border border-border bg-panel-2 py-1.5 pr-7 pl-2.5',
            'text-[12.5px] text-ink outline-none hover:bg-hover',
            'focus-visible:ring-1 focus-visible:ring-brand',
          )}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <CaretDown
          size={11}
          weight="bold"
          // The caret is decoration over a control that already announces
          // itself; letting it take pointer events would swallow the click
          // that opens the menu.
          className="pointer-events-none absolute right-2.5 text-subtle"
        />
      </span>

      {hint ? (
        <span id={hintId} className="text-[11.5px] text-subtle">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

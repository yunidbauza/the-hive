import { useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * A labelled single-line input (story 104).
 *
 * The third form primitive, after story 105's `SegmentedControl` and
 * `SelectField`. Same labelling arrangement as `SelectField` and for the same
 * reason: `htmlFor` rather than a wrapping `<label>`, because a wrapping label
 * folds every string inside it — including the hint — into the accessible
 * name, so a screen reader would announce the control as "Shell A blank field
 * inherits the default."
 *
 * Deliberately uncontrolled-adjacent: the caller owns the value and decides
 * when to commit. Runtime settings write to a file, so committing on every
 * keystroke would mean a whole-file atomic write per character.
 */

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Fired on Enter and on blur — the commit points. */
  onCommit?: () => void;
  placeholder?: string;
  hint?: string;
  /** Marks the value as inherited rather than set here. */
  muted?: boolean;
  className?: string;
}

export function TextField({
  label,
  value,
  onChange,
  onCommit,
  placeholder,
  hint,
  muted = false,
  className,
}: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-[12.5px] text-muted">
        {label}
      </label>

      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommit?.();
          }
          /**
           * Escape belongs to this field, not to the settings overlay.
           *
           * The overlay marks subtrees that claim Escape with
           * `data-escape-scope` (story 103) — but this field does not claim it,
           * so the keystroke is left alone and closing settings still works.
           * Noted here so the next person does not add a handler by reflex.
           */
        }}
        className={cn(
          'rounded-[6px] border border-border bg-panel-2 px-2.5 py-1.5',
          'text-[12.5px] outline-none placeholder:text-subtle',
          'focus-visible:ring-1 focus-visible:ring-brand',
          muted ? 'text-subtle' : 'text-ink',
        )}
      />

      {hint ? (
        <span id={hintId} className="text-[11.5px] text-subtle">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

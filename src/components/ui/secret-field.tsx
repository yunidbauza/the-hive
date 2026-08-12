import { Eye, EyeSlash } from '@phosphor-icons/react';
import { useId, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * A write-only credential input (HIVE-67).
 *
 * Deliberately **not** a `type` prop on `TextField`. The two look similar and
 * mean different things: a `TextField` displays the value the app holds, and
 * this field cannot, because the app does not hold one — a stored token can be
 * replaced and cleared but never read back. Folding them together would put a
 * masked box on screen that implies a round trip which does not exist, and the
 * first person to wonder "why is my token not showing" would be asking a
 * reasonable question about a lie the component told them.
 *
 * So the value here is always a *new* token on its way in. Whatever is already
 * stored is described in prose beside the field rather than dotted out inside
 * it.
 *
 * The reveal toggle exists because the realistic failure is a truncated paste,
 * and a credential you cannot look at is one you cannot check before saving.
 *
 * Same labelling arrangement as `TextField` — `htmlFor` rather than a wrapping
 * `<label>` — for the reason `text-field.tsx:5-18` gives: a wrapping label folds
 * the hint into the accessible name.
 */

interface SecretFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Fired on Enter and on blur — the commit points, as in `TextField`. */
  onCommit?: () => void;
  placeholder?: string;
  hint?: string;
  className?: string;
}

export function SecretField({
  label,
  value,
  onChange,
  onCommit,
  placeholder,
  hint,
  className,
}: SecretFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [revealed, setRevealed] = useState(false);

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-[12.5px] text-muted">
        {label}
      </label>

      <div className="flex items-center gap-1.5">
        <input
          id={id}
          type={revealed ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          aria-describedby={hint ? hintId : undefined}
          /**
           * A password manager offering to fill an Atlassian API token would
           * fill the wrong thing, and a spell-checker sends what it checks to
           * whoever wrote it.
           */
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onCommit?.();
            }
            /**
             * Escape belongs to the settings overlay, not to this field — the
             * same rule `text-field.tsx` follows. Noted so the next person does
             * not add a handler by reflex and break closing the pane.
             */
          }}
          className={cn(
            'min-w-0 flex-1 rounded-[6px] border border-border bg-panel-2 px-2.5 py-1.5',
            'text-[12.5px] text-ink outline-none placeholder:text-subtle',
            'focus-visible:ring-1 focus-visible:ring-brand',
          )}
        />

        <button
          type="button"
          aria-label={revealed ? 'Hide the token' : 'Show the token'}
          onClick={() => setRevealed((current) => !current)}
          className={cn(
            'rounded-[6px] border border-transparent p-1.5 text-subtle',
            'hover:bg-hover hover:text-ink',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand',
          )}
        >
          {revealed ? <EyeSlash size={14} /> : <Eye size={14} />}
        </button>
      </div>

      {hint ? (
        <span id={hintId} className="text-[11.5px] text-subtle">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

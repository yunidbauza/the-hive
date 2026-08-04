import { useId, useRef } from 'react';

import { cn } from '@/lib/utils';

/**
 * A small set of mutually exclusive choices, shown all at once (story 105).
 *
 * The first form primitive in `components/ui/` — before this the app had no
 * input, select, switch, or radio at all, because nothing until settings needed
 * one. Two controls in the appearance section want this shape (theme, density)
 * and neither wants a dropdown: three short labels are faster to read side by
 * side than behind a menu, and the choice is one a user makes by comparing.
 *
 * It is a **radio group**, not a row of buttons. Arrow keys move between
 * options and select as they go, Home/End jump to the ends, and exactly one
 * option is in the tab order — the roving-tabindex pattern the ARIA authoring
 * practices describe for radios. A row of `<button>`s would put every option in
 * the tab order and announce none of them as a choice.
 */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  /** Labels the group for assistive tech. Rendered by the caller, not here. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  const groupId = useId();
  const refs = useRef(new Map<T, HTMLButtonElement>());

  /**
   * Move selection *and* focus together.
   *
   * In a radio group the two are the same gesture: arrowing to an option
   * chooses it. Focusing without selecting would leave the user's screen reader
   * announcing an option that is not the one in effect.
   */
  const move = (offset: number) => {
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + offset + options.length) % options.length];
    onChange(next.value);
    refs.current.get(next.value)?.focus();
  };

  const jump = (target: SegmentedOption<T>) => {
    onChange(target.value);
    refs.current.get(target.value)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-[7px] border border-border-soft bg-panel-2 p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;

        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) refs.current.set(option.value, node);
              else refs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            id={`${groupId}-${option.value}`}
            aria-checked={selected}
            // Roving tabindex: one stop for the whole group, not one per option.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              switch (event.key) {
                case 'ArrowRight':
                case 'ArrowDown':
                  event.preventDefault();
                  move(1);
                  break;
                case 'ArrowLeft':
                case 'ArrowUp':
                  event.preventDefault();
                  move(-1);
                  break;
                case 'Home':
                  event.preventDefault();
                  jump(options[0]);
                  break;
                case 'End':
                  event.preventDefault();
                  jump(options[options.length - 1]);
                  break;
                default:
                  break;
              }
            }}
            className={cn(
              'rounded-[5px] px-2.5 py-1 text-[12.5px] outline-none',
              'focus-visible:ring-1 focus-visible:ring-brand',
              selected
                ? 'bg-active text-ink'
                : 'text-muted hover:bg-hover hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

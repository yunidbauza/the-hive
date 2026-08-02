import { useRef } from 'react';

import { cn } from '@/lib/utils';

interface OptionStepperProps<T extends string> {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}

/** Keys that step the selection, and which way. */
const STEP: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * A horizontal stepper: a track, a filled portion, and one dot per option.
 *
 * Bespoke rather than a shadcn primitive, and deliberately so (story 044):
 * nothing else in the app uses it, and the concept's look — a green fill
 * growing to the selected dot — is not a radio group with different paint. It
 * lives in this slice because this slice is its only consumer.
 *
 * The semantics *are* a radio group, though, so that is the role it exposes —
 * and, crucially, the keyboard contract that role promises is implemented
 * rather than merely announced. `role="radio"` tells a screen-reader user that
 * arrow keys move the selection and that the group is a single tab stop;
 * exposing the role without honouring either is worse than using plain buttons,
 * because it advertises an interaction that does not exist.
 */
export function OptionStepper<T extends string>({
  label,
  options,
  value,
  onChange,
}: OptionStepperProps<T>) {
  const index = Math.max(options.indexOf(value), 0);
  const buttons = useRef(new Map<T, HTMLButtonElement | null>());

  /**
   * Percentage across the *centres* of the first and last dots, not the width
   * of the container: the fill has to stop under a dot, and dots sit at the
   * ends rather than inset.
   */
  const fill = options.length > 1 ? (index / (options.length - 1)) * 100 : 0;

  const step = (event: React.KeyboardEvent) => {
    const delta = STEP[event.key];
    if (delta === undefined) return;

    event.preventDefault();
    // Clamped, not wrapped — the fill is a scale, and running off one end to
    // reappear at the other would read as the value jumping.
    const next = options[Math.min(Math.max(index + delta, 0), options.length - 1)];
    if (next === value) return;

    onChange(next);
    // Focus follows selection, which is what makes the next arrow press
    // continue from here rather than from wherever focus was left behind.
    buttons.current.get(next)?.focus();
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <span className="font-mono text-[11px] tracking-[0.06em] text-term-head uppercase">
        {label}
      </span>

      <div className="relative px-[7px]">
        {/* Track and fill are decorative; the dots below carry the semantics. */}
        <div
          aria-hidden="true"
          className="absolute inset-x-[7px] top-[6px] h-0.5 rounded bg-term-track"
        />
        <div
          aria-hidden="true"
          className="absolute top-[6px] left-[7px] h-0.5 rounded bg-green transition-[width] duration-250"
          style={{ width: `calc(${fill}% - ${(fill / 100) * 14}px)` }}
        />

        <div role="radiogroup" aria-label={label} className="relative flex">
          {options.map((option) => {
            const selected = option === value;

            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selected}
                /**
                 * Roving tabindex: the group is one tab stop, not four. Without
                 * it, the two steppers would cost eight tab presses to walk
                 * past, and the focus order would flatly contradict the
                 * grouping the role announces.
                 */
                tabIndex={selected ? 0 : -1}
                ref={(node) => {
                  buttons.current.set(option, node);
                }}
                onClick={() => onChange(option)}
                onKeyDown={step}
                className="flex flex-1 flex-col items-center gap-2 first:items-start last:items-end"
              >
                <span
                  className={cn(
                    'rounded-full border transition-all',
                    selected
                      ? 'size-[14px] border-green bg-green shadow-[0_0_8px_var(--cc-green)]'
                      : 'size-[10px] border-term-track bg-term-bg',
                  )}
                />
                <span
                  className={cn(
                    'font-mono text-[11px]',
                    selected ? 'font-bold text-ink' : 'text-subtle',
                  )}
                >
                  {option}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

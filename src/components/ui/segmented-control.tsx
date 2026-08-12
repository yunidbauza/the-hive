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
  /**
   * Greys the group out and refuses every interaction.
   *
   * Added for the editor's split-direction control, which is meaningless while
   * placement is Full. Disabled rather than hidden: a control that appears the
   * first time you pick an option makes that option feel like it did nothing,
   * because the thing it enabled arrived somewhere the eye was not.
   *
   * Disables every option at once. For individual ones see `disabledValues`.
   */
  disabled?: boolean;
  /**
   * Options that exist but cannot be chosen *here*.
   *
   * Deliberately narrow, and not the same thing as `disabled`. The rule this
   * atom started with was that a group with one dead option lies about its own
   * size — true when the deadness is a passing state of the form, as with the
   * editor's split direction, where the honest fix is to disable the group.
   *
   * It is the wrong rule when the option is unavailable on *this machine*:
   * notification delivery cannot reach the desktop on a Linux box with no
   * notification daemon (HIVE-75). Hiding it there would quietly change what
   * the control means between two computers, and disabling the whole group
   * would take away the two choices that do still work. So the option stays,
   * greyed, and keyboard traversal steps over it.
   */
  disabledValues?: readonly T[];
  className?: string;
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  disabledValues,
  className,
}: SegmentedControlProps<T>) {
  const groupId = useId();
  const refs = useRef(new Map<T, HTMLButtonElement>());

  const isDead = (option: T) => disabled || (disabledValues?.includes(option) ?? false);
  const selectable = options.filter((option) => !isDead(option.value));

  /**
   * The group's single tab stop — and the anchor every keyboard move starts
   * from, which is the same thing said twice: it is where the user is standing.
   *
   * Normally the selected option, but a disabled button cannot take focus — and
   * the selected option really can be the dead one, which is the ordinary case
   * for a kind defaulting to desktop delivery on a machine that has none. The
   * group would then have no tab stop at all and drop out of the keyboard
   * order entirely, so it falls back to the first option that can be reached.
   */
  const tabStop = isDead(value) ? selectable[0]?.value : value;

  /**
   * Move selection *and* focus together.
   *
   * In a radio group the two are the same gesture: arrowing to an option
   * chooses it. Focusing without selecting would leave the user's screen reader
   * announcing an option that is not the one in effect.
   *
   * The walk steps over dead options rather than landing on one and stopping:
   * an arrow key that appears to do nothing reads as a broken control, not as
   * a boundary.
   *
   * It anchors on `tabStop` rather than on `value`, and the difference is not
   * cosmetic. The two diverge in exactly the case above — selection dead, focus
   * parked on the first live option — where anchoring on `value` computes the
   * step from an option the user is *not* on: Right re-selected whatever was
   * already under the cursor, and Left moved one to the right.
   */
  const move = (offset: number) => {
    if (tabStop === undefined) return;
    const total = options.length;
    const start = options.findIndex((option) => option.value === tabStop);

    for (let step = 1; step <= total; step += 1) {
      const index = (((start + offset * step) % total) + total) % total;
      const next = options[index];
      if (!isDead(next.value)) {
        onChange(next.value);
        refs.current.get(next.value)?.focus();
        return;
      }
    }
  };

  const jump = (target: SegmentedOption<T> | undefined) => {
    if (!target || isDead(target.value)) return;
    onChange(target.value);
    refs.current.get(target.value)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-[7px] border border-border-soft bg-panel-2 p-0.5',
        disabled && 'opacity-45',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const dead = isDead(option.value);

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
            disabled={dead}
            // Roving tabindex: one stop for the whole group, not one per option.
            tabIndex={option.value === tabStop ? 0 : -1}
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
                /*
                  First and last *selectable*, not first and last. The APG puts
                  Home/End on the ends of the reachable set, and in the
                  notifications pane the dead option is the last one — so
                  passing `options[length - 1]` made End a no-op in every row on
                  a machine with no notification daemon.
                */
                case 'Home':
                  event.preventDefault();
                  jump(selectable[0]);
                  break;
                case 'End':
                  event.preventDefault();
                  jump(selectable[selectable.length - 1]);
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
              dead && 'cursor-not-allowed',
              /*
                The hover overrides must not reach the *selected* segment.
                `:hover` still matches a disabled button, so on the row whose
                selection is the dead option these would paint over `bg-active`
                and mute the ink — the row would read as having nothing chosen
                for as long as the pointer rested on it.
              */
              dead && !selected && 'hover:bg-transparent hover:text-muted',
              // Only the individually dead one dims itself; `disabled` already
              // fades the whole group, and fading twice reads as a third state.
              !disabled && dead && 'opacity-50',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

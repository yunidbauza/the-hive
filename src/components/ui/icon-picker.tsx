import { useId } from 'react';

import { cn } from '@/lib/utils';

import { Icon } from '@components/ui/icon';

/**
 * A grid of glyphs, one of which is chosen.
 *
 * ## Why this exists rather than a text input
 *
 * The icon field it replaces accepted any string and drew a question mark for
 * almost all of them — `GLYPHS` is keyed `ph-robot`, so the frontmatter's own
 * `icon: Robot` missed it, and every agent row in the rail rendered the
 * fallback with nothing to explain it. A control whose options come from the
 * registry cannot reach that state: what you can pick is exactly what can be
 * drawn.
 *
 * ## One flat grid, and why the headings went
 *
 * The options were once six labelled groups. Six headings and six sub-grids
 * made the icon field the tallest control in the pane by a wide margin, in a
 * form that already scrolls past a dozen rows — and the labels were carrying
 * almost nothing, because the options already announce themselves ("envelope",
 * "slack logo") and the grouping was never anything a reader had to act on.
 *
 * They cost nothing to remove because they were never structural. This has
 * always been **one** `radiogroup` with one roving tabindex across the whole
 * list — six radio groups would have meant six tab stops for a single choice —
 * and the headings were already `role="presentation"`. So the grouping survives
 * where it was actually doing the work: related glyphs are still adjacent in
 * the array, and a wrapping grid keeps them near each other on screen.
 *
 * Arrow keys move linearly rather than by row. The grid reflows with the pane's
 * width, so "the cell above" is not a fact this component knows — and a
 * Left/Right that wraps at the ends is the behaviour the ARIA authoring
 * practices describe for a single-select group whose layout is presentational.
 */

interface IconPickerProps {
  /** Labels the group for assistive tech. Rendered by the caller, not here. */
  label: string;
  /** The options, in display order. Every name must be drawable by {@link Icon}. */
  names: readonly string[];
  /** The chosen name, or one that is not on offer when the file names one. */
  value: string;
  onChange: (name: string) => void;
  className?: string;
}

/** `ph-slack-logo` → `slack logo`, for the option's accessible name. */
function spoken(name: string): string {
  return name.replace(/^ph-/, '').replace(/-/g, ' ');
}

export function IconPicker({
  label,
  names,
  value,
  onChange,
  className,
}: IconPickerProps) {
  const id = useId();

  /*
    Where the roving tabindex sits when the file names an icon this picker does
    not offer — a hand-written `icon: Robot`, or one the app has since dropped.
    Without this every option falls to -1, the whole control leaves the tab
    order, and the one user who most needs to change the value is the one who
    cannot reach it.
  */
  const selected = names.indexOf(value);
  const focusable = selected === -1 ? 0 : selected;

  const move = (from: number, delta: number) => {
    const next = (from + delta + names.length) % names.length;
    const name = names[next];

    if (name === undefined) return;

    onChange(name);
    document.getElementById(`${id}-${next}`)?.focus();
  };

  const cell = (name: string, index: number) => {
    const active = name === value;

    return (
      <button
        key={name}
        id={`${id}-${index}`}
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={spoken(name)}
        tabIndex={index === focusable ? 0 : -1}
        onClick={() => onChange(name)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            move(index, 1);
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            move(index, -1);
          } else if (event.key === 'Home') {
            event.preventDefault();
            move(0, 0);
          } else if (event.key === 'End') {
            event.preventDefault();
            move(names.length - 1, 0);
          }
        }}
        className={cn(
          'flex aspect-square items-center justify-center rounded-[4px] outline-none',
          active
            ? 'bg-active text-brand ring-1 ring-brand'
            : 'text-muted hover:bg-hover hover:text-ink',
          'focus-visible:ring-1 focus-visible:ring-brand',
        )}
      >
        <Icon name={name} size={15} />
      </button>
    );
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'grid grid-cols-[repeat(auto-fill,minmax(28px,1fr))] gap-1 rounded-[5px] border border-border-soft bg-panel-2 p-1.5',
        className,
      )}
    >
      {names.map(cell)}
    </div>
  );
}

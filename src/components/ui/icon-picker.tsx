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
 * ## Groups are one control, not several
 *
 * Thirty-six glyphs in an undifferentiated block is a wall, so the options
 * arrive grouped. But there is **one** `radiogroup` spanning every group and
 * one roving tabindex across the flattened list — six radio groups would mean
 * six tab stops for a single choice, and arrowing off the end of "Watching"
 * would dead-end rather than continue into "Messaging".
 *
 * Headings are `presentation`: they organise the grid for the eye, and the
 * options already carry distinct accessible names ("envelope", "slack logo"),
 * so announcing a heading before each would add length without adding meaning.
 *
 * Arrow keys move linearly rather than by row. The grid reflows with the pane's
 * width, so "the cell above" is not a fact this component knows — and a
 * Left/Right that wraps at the ends is the behaviour the ARIA authoring
 * practices describe for a single-select group whose layout is presentational.
 */

export interface IconGroup {
  label: string;
  names: readonly string[];
}

interface IconPickerProps {
  /** Labels the group for assistive tech. Rendered by the caller, not here. */
  label: string;
  /** The options, grouped. Every name must be drawable by {@link Icon}. */
  groups: readonly IconGroup[];
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
  groups,
  value,
  onChange,
  className,
}: IconPickerProps) {
  const id = useId();

  /*
    One list across every group, which is what makes the roving tabindex and
    the arrow keys behave as a single control rather than six.
  */
  const flat = groups.flatMap((group) => group.names);

  /*
    Where the roving tabindex sits when the file names an icon this picker does
    not offer — a hand-written `icon: Robot`, or one the app has since dropped.
    Without this every option falls to -1, the whole control leaves the tab
    order, and the one user who most needs to change the value is the one who
    cannot reach it.
  */
  const selected = flat.indexOf(value);
  const focusable = selected === -1 ? 0 : selected;

  const move = (from: number, delta: number) => {
    const next = (from + delta + flat.length) % flat.length;
    const name = flat[next];

    if (name === undefined) return;

    onChange(name);
    document.getElementById(`${id}-${next}`)?.focus();
  };

  const cell = (name: string) => {
    const index = flat.indexOf(name);
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
            move(flat.length - 1, 0);
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
        'flex flex-col gap-2 rounded-[5px] border border-border-soft bg-panel-2 p-1.5',
        className,
      )}
    >
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <span
            role="presentation"
            className="px-0.5 text-[10px] tracking-wide text-subtle"
          >
            {group.label}
          </span>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(28px,1fr))] gap-1">
            {group.names.map(cell)}
          </div>
        </div>
      ))}
    </div>
  );
}

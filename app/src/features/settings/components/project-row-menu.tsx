import { DotsThreeVertical } from '@phosphor-icons/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@components/ui/dropdown-menu';

interface ProjectRowMenuProps {
  /** Named in the trigger's accessible name — every row has one of these. */
  projectName: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRename: () => void;
  onRepoint: () => void;
  onRemove: () => void;
}

/**
 * Every action on a project row, in one menu (story 103).
 *
 * ## Why a menu
 *
 * The alternative considered was three hover-revealed icon buttons. This list
 * is read far more often than it is edited, and the row already carries the
 * `demo` and `no git` tags on its right edge — four controls plus two tags in
 * the same ~120px buys one click and costs the resting state, which is the
 * state the row is in almost always.
 *
 * ## Why Move up / Move down live here
 *
 * They are the keyboard path for reordering. The alternative was a lift mode on
 * the drag grip (Space to lift, arrows to move) — the convention a DnD library
 * would have supplied. Two reasons this won: nothing about a grip announces
 * that Space lifts it, and menu items are ordinary clicks, so the reorder logic
 * is provable in unit tests. A lift mode would have made drag the only path to
 * that code, which is the fragile one.
 *
 * ## The primitive's own classes are inert here
 *
 * `dropdown-menu.tsx` is shadcn's, and this is its first consumer. Its defaults
 * name shadcn's palette (`bg-popover`, `bg-accent`, `text-destructive`), none of
 * which is defined in `tokens.css` — this app's colour comes from `--cc-*`. In
 * Tailwind v4 a utility whose token does not exist is simply never generated,
 * so those classes are no-ops rather than wrong colours. Every surface, border
 * and text colour below is therefore supplied explicitly; without them the menu
 * would render as unstyled text over the list.
 */
export function ProjectRowMenu({
  projectName,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRename,
  onRepoint,
  onRemove,
}: ProjectRowMenuProps) {
  const item =
    'rounded-[4px] px-2 py-1 text-[12.5px] text-muted focus:bg-hover focus:text-ink data-[disabled]:opacity-35';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${projectName}`}
        className="shrink-0 rounded p-1 text-subtle hover:bg-hover hover:text-ink"
      >
        <DotsThreeVertical size={13} weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[11rem] rounded-[7px] border border-border bg-panel p-1 shadow-lg"
      >
        {/*
          Disabled at the ends of the list rather than removed: an item that
          vanishes on the first row makes the menu a different shape per row,
          and `disabled` still announces that the action exists.
        */}
        <DropdownMenuItem
          disabled={!canMoveUp}
          onSelect={onMoveUp}
          className={item}
        >
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canMoveDown}
          onSelect={onMoveDown}
          className={item}
        >
          Move down
        </DropdownMenuItem>

        <DropdownMenuSeparator className="my-1 bg-border-soft" />

        <DropdownMenuItem onSelect={onRename} className={item}>
          Rename…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRepoint} className={item}>
          Change folder…
        </DropdownMenuItem>

        <DropdownMenuSeparator className="my-1 bg-border-soft" />

        <DropdownMenuItem
          onSelect={onRemove}
          className={`${item} text-red focus:text-red`}
        >
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

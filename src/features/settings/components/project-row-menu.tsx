import { DotsThreeVertical } from '@phosphor-icons/react';
import { useRef } from 'react';

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
  onChangeKey: () => void;
  onRepoint: () => void;
  onRemove: () => void;
}

/**
 * Every action on a project row, in one menu (story 103).
 *
 * ## Why a menu
 *
 * The alternative considered was three hover-revealed icon buttons. This list
 * is read far more often than it is edited, and the row already carries a
 * `no git` tag on its right edge — four controls plus a tag in the same ~120px
 * buys one click and costs the resting state, which is the state the row is in
 * almost always.
 *
 * (The `demo` tag the row once carried went with story 103: the settings list
 * only ever holds config projects, so that branch was unreachable here.)
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
  onChangeKey,
  onRepoint,
  onRemove,
}: ProjectRowMenuProps) {
  const item =
    'rounded-[4px] px-2 py-1 text-[12.5px] text-muted focus:bg-hover focus:text-ink data-[disabled]:opacity-35';

  /**
   * Whether the chosen item replaces the row with something that focuses itself.
   *
   * Radix returns focus to the trigger when the menu closes, which is right for
   * *Move up* and *Change folder…* — the row is still a row afterwards. It is
   * wrong for *Rename…* and *Remove*: both swap the row's contents for a
   * control that focuses itself on mount, and the restore lands after that,
   * stealing focus straight back. For rename that is not merely untidy — the
   * steal blurs the input, blur commits, an unchanged name cancels, and the
   * editor closes before a key is pressed.
   */
  const handsOffFocus = useRef(false);

  /** Run an action, recording whether it takes focus with it. */
  const select = (action: () => void, takesFocus = false) => {
    handsOffFocus.current = takesFocus;
    action();
  };

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
        onCloseAutoFocus={(event) => {
          if (!handsOffFocus.current) return;
          handsOffFocus.current = false;
          event.preventDefault();
        }}
        className="min-w-[11rem] rounded-[7px] border border-border bg-panel p-1 shadow-lg"
      >
        {/*
          Disabled at the ends of the list rather than removed: an item that
          vanishes on the first row makes the menu a different shape per row,
          and `disabled` still announces that the action exists.
        */}
        <DropdownMenuItem
          disabled={!canMoveUp}
          onSelect={() => select(onMoveUp)}
          className={item}
        >
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canMoveDown}
          onSelect={() => select(onMoveDown)}
          className={item}
        >
          Move down
        </DropdownMenuItem>

        <DropdownMenuSeparator className="my-1 bg-border-soft" />

        <DropdownMenuItem
          onSelect={() => select(onRename, true)}
          className={item}
        >
          Rename…
        </DropdownMenuItem>
        {/*
          Between *Rename…* and *Change folder…*: the three edits are ordered by
          how much they change, and renaming what a project is called sits
          nearer to renaming what it is typed as than either does to moving it
          on disk (HIVE-94).
        */}
        <DropdownMenuItem
          onSelect={() => select(onChangeKey, true)}
          className={item}
        >
          Change key…
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => select(onRepoint)}
          className={item}
        >
          Change folder…
        </DropdownMenuItem>

        <DropdownMenuSeparator className="my-1 bg-border-soft" />

        <DropdownMenuItem
          onSelect={() => select(onRemove, true)}
          className={`${item} text-red focus:text-red`}
        >
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

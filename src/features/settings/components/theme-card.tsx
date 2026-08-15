import { Check, DotsThreeVertical } from '@phosphor-icons/react';
import type { CSSProperties } from 'react';
import { useRef } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@components/ui/dropdown-menu';
import { Tag } from '@components/ui/tag';
import type { HiveTheme, ThemeModeColors, ThemeModeName } from '@lib/theme/contract';

interface ThemeCardProps {
  theme: HiveTheme;
  id: string;
  isActive: boolean;
  isBuiltIn: boolean;
  onActivate: (id: string) => void;
  onExport: (id: string) => void;
  onRemove: (id: string) => void;
}

/**
 * One tile in the Themes gallery: a theme's light and dark modes at once
 * (HIVE-80, story 9).
 *
 * ## The diagonal
 *
 * The dark mode fills the whole tile; the light mode is layered on top and
 * clipped to the lower-right triangle. This is the load-bearing idea of the
 * card, not decoration — it is what makes "a theme is a pair" legible without
 * a word of explanation, and it means nobody activates a theme having seen
 * only half of it. A 1px hairline gradient traces the seam between the two.
 *
 * ## Colour is data here, not design
 *
 * The card's own chrome (border, background, hover) obeys the no-hex rule and
 * uses `--cc-*` tokens through Tailwind utilities. The swatch interior is the
 * one legitimate exception: it paints an arbitrary imported theme's own
 * colours, which are runtime data with no token that could name them, via
 * inline `style` reading `theme.modes[mode].ui.*`.
 *
 * ## The footer's three-way slot
 *
 * The approved mock's footer right slot holds exactly one element — the
 * active check or the `Imported` chip. This story adds a `⋯` menu, so the
 * slot now carries up to three things in practice: the `⋯` pins to the far
 * right, and the check-or-chip sits to its left. They are effectively
 * mutually exclusive (a card is rarely both active and imported-but-unnamed),
 * and the active state is already carried by the ring around the whole card,
 * so the footer never crowds.
 */
export function ThemeCard({
  theme,
  id,
  isActive,
  isBuiltIn,
  onActivate,
  onExport,
  onRemove,
}: ThemeCardProps) {
  const item =
    'rounded-[4px] px-2 py-1 text-[12.5px] text-muted focus:bg-hover focus:text-ink data-[disabled]:opacity-35';

  // See `project-row-menu.tsx`: Radix returns focus to the trigger when the
  // menu closes, which is wrong for actions that replace this card's own
  // controls with something that focuses itself on mount (none here yet, but
  // keeping the same shape as the established pattern costs nothing and
  // keeps the two menus consistent).
  const handsOffFocus = useRef(false);

  const select = (action: () => void, takesFocus = false) => {
    handsOffFocus.current = takesFocus;
    action();
  };

  return (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={() => onActivate(id)}
      className={`flex w-full flex-col gap-2 rounded-[7px] border bg-panel p-[9px] text-left hover:bg-hover ${
        isActive
          ? 'border-brand-fill shadow-[0_0_0_1px_var(--cc-brand-fill)]'
          : 'border-border'
      }`}
    >
      <ThemeSwatch theme={theme} />

      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-ink">
            {theme.name}
          </div>
          <div className="truncate text-[11px] text-muted">
            {isBuiltIn ? 'Built in' : theme.author}
          </div>
        </div>

        {isActive ? (
          <span
            aria-hidden="true"
            className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-brand-fill text-on-brand"
          >
            <Check size={11} weight="bold" />
          </span>
        ) : !isBuiltIn ? (
          <Tag tone="subtle" className="shrink-0">
            Imported
          </Tag>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Theme actions"
            onClick={(event) => event.stopPropagation()}
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
            className="min-w-[9rem] rounded-[7px] border border-border bg-panel p-1 shadow-lg"
          >
            <DropdownMenuItem
              disabled={isActive}
              onSelect={() => select(() => onActivate(id))}
              className={item}
            >
              Activate
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => select(() => onExport(id))}
              className={item}
            >
              Export…
            </DropdownMenuItem>
            {!isBuiltIn ? (
              <DropdownMenuItem
                onSelect={() => select(() => onRemove(id), true)}
                className={`${item} text-red focus:text-red`}
              >
                Remove
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </button>
  );
}

/** The dark-fills / light-triangle swatch, drawn from the theme's own tokens. */
function ThemeSwatch({ theme }: { theme: HiveTheme }) {
  return (
    <div className="relative aspect-[16/9] overflow-hidden rounded-[5px] border border-border">
      <SwatchHalf mode="dark" colors={theme.modes.dark} />
      <SwatchHalf
        mode="light"
        colors={theme.modes.light}
        className="absolute inset-0"
        style={{ clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }}
      />
      {/* The seam: a 1px hairline on the diagonal. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(to top right, transparent calc(50% - 0.5px), rgba(255,255,255,0.30) calc(50% - 0.5px), rgba(255,255,255,0.30) calc(50% + 0.5px), transparent calc(50% + 0.5px))',
        }}
      />
    </div>
  );
}

interface SwatchHalfProps {
  mode: ThemeModeName;
  colors: ThemeModeColors;
  className?: string;
  style?: CSSProperties;
}

/**
 * A miniature app chrome — title bar, rail, stage — painted entirely from one
 * mode's own `ui` colours. Inline `style` here is the authorised exception to
 * the no-hex rule: these are an arbitrary imported theme's runtime colours,
 * not a design decision, and there is no token that could name them.
 */
function SwatchHalf({ mode, colors, className, style }: SwatchHalfProps) {
  const { ui } = colors;

  return (
    <div
      data-mode={mode}
      className={className ?? 'absolute inset-0'}
      style={{ ...style, background: ui.bg }}
    >
      <div
        className="flex items-center gap-[3px] px-[5px]"
        style={{ height: '22%', background: ui.panel }}
      >
        <span
          className="size-[4px] shrink-0 rounded-full"
          style={{ background: ui.brand }}
        />
        <span
          className="size-[4px] shrink-0 rounded-full"
          style={{ background: ui.green }}
        />
        <span
          className="size-[4px] shrink-0 rounded-full"
          style={{ background: ui.amber }}
        />
      </div>

      <div className="flex" style={{ height: '78%' }}>
        <div
          className="shrink-0"
          style={{ width: '26%', background: ui.panel2 }}
        />
        <div
          className="flex flex-1 flex-col justify-center gap-[3px] px-[6px]"
          style={{ background: ui.bg }}
        >
          <span
            className="block h-[3px] rounded-full"
            style={{ width: '70%', background: ui.border }}
          />
          <span
            className="block h-[3px] rounded-full"
            style={{ width: '45%', background: ui.border }}
          />
          <span
            className="block h-[3px] rounded-full"
            style={{ width: '58%', background: ui.border }}
          />
        </div>
      </div>
    </div>
  );
}

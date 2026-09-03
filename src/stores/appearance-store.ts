import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';

import {
  clampRailWidths,
  isRailDefault,
  RAIL_MAX_PX,
  RAIL_MIN,
  type RailWidthInput,
  type RailWidths,
} from '@lib/rail-width';
import {
  DEFAULT_TERMINAL_FONT,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_TERMINAL_SCROLLBACK,
  terminalFontStack,
  type TerminalFontId,
} from '@lib/terminal/fonts';
import { applyThemeColors } from '@lib/theme/apply';
import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { BUILT_IN_THEMES } from '@lib/theme/built-in-themes';
import { BUILT_IN_THEME_ID, type HiveTheme } from '@lib/theme/contract';
import { isHiveTheme } from '@lib/theme/validate';

/**
 * Appearance — the first *persisted* state in the app (story 105).
 *
 * ## Why this is a third store, and why it is not the config file
 *
 * Everything else in the settings epic writes `~/.hive/config.json` through
 * main's single write path. That file describes the **workspace**: where
 * projects live, which shell to spawn, what command starts an agent — facts a
 * session needs before it can run. Appearance is a fact about the person looking
 * at the screen, needed by the renderer before its first paint and by nothing
 * else. Reading it over the async bridge would paint dark and then flip, on
 * every launch; and the browser target (`pnpm dev`) has no bridge at all, so the
 * config path would need this fallback anyway rather than replacing it.
 *
 * It is not `ui-store` either. That store is view state — `activeTab`, `picker`,
 * `selId` — and persisting it would restore a picker that was open at quit.
 * `partialize` could whitelist fields, but then every future `ui-store` field
 * becomes a question somebody has to remember to answer, and answering it wrong
 * is silent. A separate store makes the boundary structural: everything here is
 * persisted, nothing there is.
 *
 * `theme` moved here out of `ui-store` for that reason.
 */

/** What the user chose. `system` defers to the OS; it is not a third palette. */
export type ThemePreference = 'system' | 'dark' | 'light';

/** What the DOM actually gets. */
export type ResolvedTheme = 'dark' | 'light';

export type Density = 'comfortable' | 'compact';

/** Which rail a width belongs to. */
export type RailSide = 'left' | 'right';

/**
 * Where an opened file renders.
 *
 * `full` hides the terminal behind the editor; `split` shows both. This is a
 * *setting* rather than a decision the app makes, because the two are genuinely
 * different working modes — reading a file end to end, and watching a session
 * edit one — and neither is right for the other.
 */
export type EditorPlacement = 'full' | 'split';

/** How a split stage is divided. Only consulted when placement is `split`. */
export type EditorSplitAxis = 'horizontal' | 'vertical';

/**
 * How many files can be open at once.
 *
 * `tabs` keeps a strip of them; `single` replaces whatever was open and
 * closes on Escape. Independent of {@link EditorPlacement} — the four
 * combinations are four real layouts, and the one rule that unifies them is
 * that a `Terminal` entry appears in the strip exactly when the terminal is
 * hidden, which is only ever `full` + `tabs`.
 */
export type EditorNav = 'tabs' | 'single';

interface AppearanceState {
  theme: ThemePreference;
  terminalFont: TerminalFontId;
  terminalFontSize: number;
  terminalScrollback: number;
  density: Density;

  /**
   * How wide the user dragged each rail, or `null` for "follow density"
   * (HIVE-105).
   *
   * Appearance on this store's own test — a durable choice about how the screen
   * looks, needed before the first paint, and meaningless to the browser
   * target's absent config file. It is also the arrangement `editorSplitRatio`
   * already established: persisted like everything here, but written by
   * dragging rather than by a control in Settings, because a width has no
   * sensible discrete choices and a number field would be a worse interface
   * than the handle itself.
   *
   * **`null` is a real state, not a missing one.** It means the rail is
   * following `--cc-rail-w-*` from the stylesheet, so a later density change
   * still moves it; a width that happened to equal today's default would not.
   * That is what double-click-to-reset restores.
   *
   * Stored *intent*, not painted pixels — bounded only by the per-rail minimum
   * and the absolute cap, never by the current window. The window-dependent
   * bounds live in `clampRailWidths` and are applied on the way to the screen,
   * so shrinking the window and growing it back returns the rail to the width
   * that was actually chosen. See `@lib/rail-width`.
   */
  railWidthLeft: number | null;
  railWidthRight: number | null;

  /**
   * Whether each rail is showing its icon strip instead of its panel.
   *
   * Persisted like everything else here, which is exactly right for this one:
   * a rail the user collapsed should still be collapsed at the next launch, and
   * because it is persisted the strip paints on the *first* frame rather than
   * after a hydration flash. See {@link applyStoredRailWidths}.
   */
  railCollapsedLeft: boolean;
  railCollapsedRight: boolean;

  /**
   * The line under the wordmark, top-left — whose hive this is.
   *
   * Appearance rather than config, on this store's own test: it is a fact about
   * the person looking at the screen, it is needed on the first paint of the
   * header, and the browser target has no config file to read it from. That it
   * happens to name a team does not make it workspace state — no session, PTY
   * or ticket ever reads it.
   *
   * Empty is a legitimate answer, and means the line is not drawn at all.
   */
  teamName: string;

  /**
   * The editor block.
   *
   * Here rather than in a store of its own for the reason this store exists at
   * all: every one of these is a durable choice about how the screen looks, it
   * is needed before the editor's first paint, and the browser target has no
   * config file to read it from. `editor-store.ts` holds the *buffers*, which
   * are none of those things.
   */
  editorPlacement: EditorPlacement;
  editorSplitAxis: EditorSplitAxis;
  /**
   * The terminal's share of a split stage, 0.2–0.8.
   *
   * Persisted like the rest, but written by dragging the divider rather than by
   * a control in settings. A ratio has no sensible discrete choices, and a
   * number field for it would be a worse interface than the divider itself.
   */
  editorSplitRatio: number;
  /**
   * The fleet table's share of the overmind column, 0.2–0.8.
   *
   * The same arrangement as `editorSplitRatio`, for the same reason: it is
   * written by dragging a divider, has no discrete choices a settings control
   * could offer, and has to be right on the first frame. Half by default —
   * the table used to size itself to its content and take the whole column
   * once the fleet was long enough, leaving the transcript its 10rem floor and
   * nothing more. A table and a conversation share this column, and neither
   * is the one to give way unasked.
   */
  consoleSplitRatio: number;
  /**
   * The receipts' share of an agent's run log, 0.2–0.8.
   *
   * The third divider, same arrangement as the two above. It was a fixed 40%
   * ceiling on the receipts for as long as the log existed, and 0.4 stays the
   * default because the rule behind it still holds — the output is prose of
   * unknown length and should open as the larger half. What changed is that a
   * reader hunting through fifty receipts can now pull the seam down instead
   * of scrolling a box eight rows tall.
   */
  runLogSplitRatio: number;
  editorNav: EditorNav;
  /**
   * Whether the editor accepts keystrokes and offers a save. **On by default.**
   *
   * **Not a security control.** It lives in `localStorage`, so it gates the UI
   * and nothing else; the filesystem is gated by containment in main.
   *
   * ## Why the default flipped
   *
   * It shipped off, arguing that the thing editing the file is the agent in the
   * terminal and a second editable buffer over the same file is a way to lose
   * work. The premise was right and the conclusion was not: a read-only editor
   * does not prevent the conflict, it prevents the *user* from taking part in
   * it. The agent is already equipped to deal with a file that changed under
   * it — that is the ordinary condition of working in a repository — and a
   * one-character fix mid-session should not require leaving the app.
   *
   * The staleness machinery this store's sibling (`editor-store.ts`) already
   * carries is what makes that safe to say out loud: a buffer whose file moved
   * underneath is marked stale, and a dirty one that moved is a conflict. Those
   * states exist precisely so both parties can edit.
   *
   * The toggle stays, for anyone who wants the old guard back.
   */
  editorEditable: boolean;
  editorFont: TerminalFontId;
  editorFontSize: number;
  editorWordWrap: boolean;
  editorLineNumbers: boolean;
  editorTabWidth: number;

  /**
   * The imported theme library (HIVE-80).
   *
   * Keyed by an id the app assigns on import, never by the theme's own
   * `name` — two imports of files both called "Nord" must not collide, and a
   * theme's author is free to rename it without breaking what is active.
   */
  themes: Record<string, HiveTheme>;
  /**
   * Which theme paints the app: {@link BUILT_IN_THEME_ID} or a key into
   * {@link themes}. Read through {@link activeThemeOf}, never indexed
   * directly — a dangling id (a theme removed elsewhere, a half-restored
   * store) must resolve to the built-in rather than throw.
   */
  activeThemeId: string;

  /**
   * The OS's current answer. **Not persisted** — it is an observation of the
   * environment, not a preference, and restoring a stale answer on a machine
   * that has since changed would be worse than asking again.
   */
  systemDark: boolean;

  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
  setTerminalFont: (font: TerminalFontId) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalScrollback: (lines: number) => void;
  setDensity: (density: Density) => void;
  /**
   * Record a dragged rail width. Bounded by the per-rail minimum and the
   * absolute cap only — see {@link AppearanceState.railWidthLeft}.
   */
  setRailWidth: (side: RailSide, width: number) => void;
  /** Hand the rail back to the stylesheet: `null`, not today's default number. */
  resetRailWidth: (side: RailSide) => void;
  setRailCollapsed: (side: RailSide, collapsed: boolean) => void;
  /** The click-the-active-tab gesture, and both keyboard chords. */
  toggleRailCollapsed: (side: RailSide) => void;
  setTeamName: (name: string) => void;
  setSystemDark: (dark: boolean) => void;

  setEditorPlacement: (placement: EditorPlacement) => void;
  setEditorSplitAxis: (axis: EditorSplitAxis) => void;
  setEditorSplitRatio: (ratio: number) => void;
  setConsoleSplitRatio: (ratio: number) => void;
  setRunLogSplitRatio: (ratio: number) => void;
  setEditorNav: (nav: EditorNav) => void;
  setEditorEditable: (editable: boolean) => void;
  setEditorFont: (font: TerminalFontId) => void;
  setEditorFontSize: (size: number) => void;
  setEditorWordWrap: (wrap: boolean) => void;
  setEditorLineNumbers: (show: boolean) => void;
  setEditorTabWidth: (width: number) => void;

  /** Add an imported theme to the library. Does not activate it. */
  addTheme: (id: string, theme: HiveTheme) => void;
  /** Make a library theme (or the built-in id) the one that paints the app. */
  activateTheme: (id: string) => void;
  /**
   * Drop a theme from the library. If it was active, `activeThemeId` returns
   * to {@link BUILT_IN_THEME_ID} in this same call — the app must never be
   * observable pointing at a theme that is no longer there.
   */
  removeTheme: (id: string) => void;

  reset: () => void;
}

/**
 * Offered tab widths.
 *
 * Display-only while the editor is read-only — it changes how an existing tab
 * character is rendered, not what typing Tab inserts. That distinction becomes
 * visible the moment editing is switched on, which is why the setting is
 * labelled for the display and not for the insert.
 */
export const EDITOR_TAB_WIDTHS: readonly number[] = [2, 4, 8] as const;

/**
 * Offered editor font sizes.
 *
 * A superset of the terminal's, minus the half-point: 12.5 exists there because
 * it is what the terminal has always used, and carrying an odd default into a
 * second control would be inheriting a quirk rather than a decision.
 */
export const EDITOR_FONT_SIZES: readonly number[] = [
  10, 11, 12, 13, 14, 15, 16, 18,
] as const;

/**
 * What the header says under "The Hive" until someone says otherwise.
 *
 * A hive's workers are a swarm and this app is a command centre for them, so
 * the default names the room rather than any real team — anyone who has not
 * set theirs still gets a line that belongs to this app.
 */
export const DEFAULT_TEAM_NAME = 'Swarm Command';

/** The terminal's share of a split stage, clamped to something usable. */
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

export const clampSplitRatio = (ratio: number): number => {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
};

const MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** The OS preference right now, or dark when nothing can be asked (SSR, tests). */
function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia(MEDIA_QUERY).matches;
}

/**
 * Preference plus environment, in one place.
 *
 * Exported for the selectors below and for tests; the *stored* answer stays the
 * preference, and this is derived on every read rather than kept in state —
 * there is exactly one source of truth for what theme is showing.
 */
export function resolveTheme(
  theme: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

/**
 * Write the resolved theme to `<body data-theme>`, which is what the
 * `body[data-theme="light"]` override in tokens.css keys off.
 *
 * Dark is the default and carries no attribute, so the `:root` block applies
 * unmodified — one less thing to keep in sync. Unchanged from `ui-store`'s
 * version except that it is now fed the resolved value rather than the stored
 * preference.
 */
function applyTheme(theme: ResolvedTheme) {
  if (typeof document === 'undefined') return;

  if (theme === 'light') {
    document.body.setAttribute('data-theme', 'light');
  } else {
    document.body.removeAttribute('data-theme');
  }
}

/**
 * Write density to `<body data-density>`, the same mechanism as the theme.
 *
 * Comfortable is the default and carries no attribute, so the `:root` values in
 * tokens.css apply unmodified. One attribute write re-spaces both rails and
 * every row in them, and no component re-renders to do it.
 */
function applyDensity(density: Density) {
  if (typeof document === 'undefined') return;

  if (density === 'compact') {
    document.body.setAttribute('data-density', 'compact');
  } else {
    document.body.removeAttribute('data-density');
  }
}

/**
 * The theme actually active, resolved from the built-ins and then the library.
 *
 * `null` does **not** mean "no theme" — it means *the Hive*, and specifically
 * that nothing needs to be written: `tokens.css` is already that palette, so
 * `applyThemeColors(null)` removes the style element and lets the stylesheet
 * paint. Every other shipped theme resolves to a real theme object and
 * paints through the same generated `<style>` an imported theme does.
 *
 * A dangling `activeThemeId` — a theme removed elsewhere, a store that only
 * half-restored — resolves to `null` rather than throwing: a store in that
 * state still has to paint something.
 *
 * Built-ins are looked up **before** the library so a shipped id can never be
 * shadowed by a stored one, whatever found its way into `localStorage`.
 *
 * Every lookup is `Object.hasOwn`, never `in` or a bare `?? `. `'toString' in
 * BUILT_IN_THEMES` is `true` for any object literal and the lookup yields
 * `Object.prototype.toString` — a function rather than `undefined`, so `??`
 * does not fire and a stored `activeThemeId` of `"toString"` reached
 * `applyThemeColors` and the terminal-palette selector as a function, throwing
 * on `.modes` on every render. That is the same unrecoverable boot this
 * store's rehydrate guard was written to close, arriving through the id
 * instead of through the theme.
 */
export function activeThemeOf(
  state: Pick<AppearanceState, 'themes' | 'activeThemeId'>,
): HiveTheme | null {
  const { activeThemeId } = state;
  if (activeThemeId === BUILT_IN_THEME_ID) return null;
  if (Object.hasOwn(BUILT_IN_THEMES, activeThemeId)) return BUILT_IN_THEMES[activeThemeId];
  if (Object.hasOwn(state.themes, activeThemeId)) return state.themes[activeThemeId];
  return null;
}

/**
 * Write the rail widths to the same two custom properties the stylesheet
 * declares (HIVE-105) — the mechanism `applyDensity` uses, for the same reason:
 * one write re-sizes a rail and no component re-renders to do it.
 *
 * ## Why the properties, and not a width prop on each rail
 *
 * `--cc-rail-w-left` / `--cc-rail-w-right` are not only read by the rails.
 * `header.tsx` used to size its right-hand button cluster with
 * `calc(var(--cc-rail-w-right) - 1rem)` so the buttons sit over the activity
 * rail rather than straddling its border. Deliver the width by any other route
 * and the rails move while the header stays where it was — a bug that looks
 * like a header bug and is not.
 *
 * ## Why it removes the property instead of writing the default
 *
 * An inline property on `<body>` beats `body[data-density='compact']`, which is
 * exactly the precedence a user override should have. But that same precedence
 * would freeze a rail the user never touched: write `320px` inline and
 * switching to compact leaves it at 320px forever. So a rail sitting at its
 * default has its property *removed*, and the stylesheet — density rules
 * included — takes back over.
 *
 * A **collapsed** rail always takes the write branch, and that is correct: 44px
 * is never equal to a minimum, so `isRailDefault` is false, and the stylesheet
 * has no notion of a strip — the inline property is the only thing that can
 * paint one. The `widths.right === 0` guard still catches the unmounted case
 * and is untouched.
 *
 * ## `--cc-rail-w-left-open` / `--cc-rail-w-right-open`
 *
 * A second pair, carrying `openWidths` — the same clamp, computed with both
 * rails forced `expanded` regardless of what either is actually doing. They
 * exist because `header.tsx` used to size its zones from the plain pair above,
 * and a **collapsed** rail paints those at 44px: a header zone claiming that
 * width shrank to a box its content did not fit in, and the neighbouring zone
 * slid over to fill the gap. The plain pair is correct for the rails
 * themselves, which really are 44px wide when collapsed; it was never correct
 * for a header that must not reflow every time a rail is toggled. The `-open`
 * pair is what lets the header claim "where this rail's edge is when
 * expanded" as a fact independent of the rail's current display, so collapsing
 * one never moves anything beside it.
 *
 * The same remove-vs-default rule applies, for the same reason: an `-open`
 * property sitting at the density minimum is removed rather than written, so a
 * later density change still reaches it through the stylesheet instead of
 * finding a stale inline value. Unlike the plain pair, `-open` never takes an
 * unconditional write branch — it is never asked to paint a 44px strip, since
 * forcing `expanded` is the entire point.
 */
export function applyRailWidths(
  widths: RailWidths,
  min: { left: number; right: number },
  openWidths: RailWidths,
) {
  if (typeof document === 'undefined') return;

  const { style } = document.body;

  if (isRailDefault(widths.left, min.left)) {
    style.removeProperty('--cc-rail-w-left');
  } else {
    style.setProperty('--cc-rail-w-left', `${widths.left}px`);
  }

  /*
    The right rail is skipped entirely when it is unmounted: `clampRailWidths`
    reports 0 for it, which is not a width anybody should paint, and the header
    already drops its `calc()` column in that case.
  */
  if (widths.right === 0 || isRailDefault(widths.right, min.right)) {
    style.removeProperty('--cc-rail-w-right');
  } else {
    style.setProperty('--cc-rail-w-right', `${widths.right}px`);
  }

  if (isRailDefault(openWidths.left, min.left)) {
    style.removeProperty('--cc-rail-w-left-open');
  } else {
    style.setProperty('--cc-rail-w-left-open', `${openWidths.left}px`);
  }

  if (isRailDefault(openWidths.right, min.right)) {
    style.removeProperty('--cc-rail-w-right-open');
  } else {
    style.setProperty('--cc-rail-w-right-open', `${openWidths.right}px`);
  }
}

/**
 * Clamp and paint in one call, for the callers that have no separate render
 * pass to hang the two halves off — {@link applyStoredRailWidths} below, and
 * the store's own tests.
 *
 * `use-rail-widths` deliberately does *not* use this. A React component can
 * clamp during render (it is pure) and write during layout, and splitting the
 * two is what keeps a drag from costing a second render per pointer event.
 *
 * Takes its whole input rather than reading the store, because half of that
 * input is not store state — the window's width belongs to the DOM and
 * `showActivityRail` belongs to `ui-store`, which this store may not read.
 *
 * Also derives the `-open` pair `applyRailWidths` now writes, the same way
 * `use-rail-widths` does: the same input, run through `clampRailWidths` a
 * second time with both rails forced `expanded`.
 */
export function syncRailWidths(input: RailWidthInput): RailWidths {
  const widths = clampRailWidths(input);
  const openWidths = clampRailWidths({ ...input, left: 'expanded', right: 'expanded' });
  applyRailWidths(widths, input.min, openWidths);
  return widths;
}

/**
 * The rail widths implied by the store alone, for the paths that have no
 * `showActivityRail` to hand — rehydration and reset.
 *
 * Collapse **is** persisted, unlike `showActivityRail`, so this path has the
 * real answer and the strip paints on the first frame rather than after a
 * hydration flash. The right rail is still assumed mounted: `showActivityRail`
 * lives in `ui-store`, which this store may not read and which persists
 * nothing, so at rehydration — during module evaluation, before React mounts —
 * it is its initial `true` and there is no other answer it could have.
 *
 * `setDensity` is the one caller that can run later, with the rail genuinely
 * hidden. What it writes then is a `--cc-rail-w-right` for a rail nobody is
 * painting: unread, because the only other consumer of that property is the
 * header cluster, which drops its `calc()` column when the rail is hidden — and
 * corrected by `use-rail-widths` in the same commit phase regardless.
 */
function applyStoredRailWidths(
  state: Pick<
    AppearanceState,
    'railWidthLeft' | 'railWidthRight' | 'railCollapsedLeft' | 'railCollapsedRight' | 'density'
  >,
) {
  syncRailWidths({
    storedLeft: state.railWidthLeft,
    storedRight: state.railWidthRight,
    min: RAIL_MIN[state.density],
    windowWidth: typeof window === 'undefined' ? 0 : window.innerWidth,
    left: state.railCollapsedLeft ? 'collapsed' : 'expanded',
    right: state.railCollapsedRight ? 'collapsed' : 'expanded',
  });
}

/** Push everything that lives on `<body>` (and the theme style element) at once — rehydration and reset. */
function applyAll(
  state: Pick<
    AppearanceState,
    | 'theme'
    | 'systemDark'
    | 'density'
    | 'themes'
    | 'activeThemeId'
    | 'railWidthLeft'
    | 'railWidthRight'
    | 'railCollapsedLeft'
    | 'railCollapsedRight'
  >,
) {
  applyTheme(resolveTheme(state.theme, state.systemDark));
  applyDensity(state.density);
  /*
    After `applyDensity`, and it has to stay that way: the density attribute
    decides which `--cc-rail-w-*` the stylesheet offers, and this decides
    whether an inline override sits on top of it.
  */
  applyStoredRailWidths(state);
  applyThemeColors(activeThemeOf(state));
}

const initialAppearanceState = {
  /**
   * Dark, not `system`.
   *
   * This story adds `system` as an *option*; it does not change what the app
   * boots as. "Dark is the default" is story 011's decision, it is what
   * `:root` in tokens.css encodes, and the smoke spec calls the header's theme
   * button "the one observable proof of which theme booted". Quietly making a
   * light-mode machine open light would reverse a documented decision this
   * story has no mandate to reverse — and would do it invisibly, since the
   * only symptom is that the app looks different on someone else's laptop.
   */
  theme: 'dark' as ThemePreference,
  terminalFont: DEFAULT_TERMINAL_FONT,
  terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
  terminalScrollback: DEFAULT_TERMINAL_SCROLLBACK,
  density: 'comfortable' as Density,
  /** `null` — follow the stylesheet — until somebody drags a rail. */
  railWidthLeft: null as number | null,
  railWidthRight: null as number | null,
  railCollapsedLeft: false,
  railCollapsedRight: false,
  teamName: DEFAULT_TEAM_NAME,

  /** Full stage: the editor is a place you go, not a permanent tax on the terminal. */
  editorPlacement: 'full' as EditorPlacement,
  /**
   * Vertical, chosen against the merits and recorded as such.
   *
   * With both rails mounted the shell already spends ~590px on chrome, so a
   * vertical split leaves the terminal around 40 columns on a 1440px display —
   * narrow enough that agent output, tables and diffs wrap badly. `horizontal`
   * keeps the terminal full-width and is the better default on the merits; this
   * is the user's stated preference, the axis is a setting, and the divider is
   * draggable. Written down so the next reader does not "fix" it.
   */
  editorSplitAxis: 'vertical' as EditorSplitAxis,
  editorSplitRatio: 0.5,
  consoleSplitRatio: 0.5,
  runLogSplitRatio: 0.4,
  editorNav: 'tabs' as EditorNav,
  editorEditable: true,
  editorFont: DEFAULT_TERMINAL_FONT,
  editorFontSize: 13,
  editorWordWrap: true,
  editorLineNumbers: true,
  editorTabWidth: 2,

  themes: {} as Record<string, HiveTheme>,
  activeThemeId: BUILT_IN_THEME_ID as string,
};

/** The shape written to `localStorage` — {@link initialAppearanceState}'s fields, persisted. */
interface PersistedAppearanceState {
  theme: ThemePreference;
  terminalFont: TerminalFontId;
  terminalFontSize: number;
  terminalScrollback: number;
  density: Density;
  railWidthLeft: number | null;
  railWidthRight: number | null;
  railCollapsedLeft: boolean;
  railCollapsedRight: boolean;
  teamName: string;
  editorPlacement: EditorPlacement;
  editorSplitAxis: EditorSplitAxis;
  editorSplitRatio: number;
  consoleSplitRatio: number;
  runLogSplitRatio: number;
  editorNav: EditorNav;
  editorEditable: boolean;
  editorFont: TerminalFontId;
  editorFontSize: number;
  editorWordWrap: boolean;
  editorLineNumbers: boolean;
  editorTabWidth: number;
  themes: Record<string, HiveTheme>;
  activeThemeId: string;
}

/**
 * The theme library, revalidated on its way out of `localStorage`.
 *
 * **A user must never be able to reach a state the app cannot boot from**, and
 * before this it could: `localStorage` is reachable by another tab, a devtools
 * session, an older build of this app and a write that was interrupted, and a
 * malformed theme that is still valid *JSON* sails through `JSON.parse`. A
 * persisted `{ nord: { hiveThemeVersion: 1, name: 'Nord' } }` with
 * `activeThemeId: 'nord'` then threw inside `applyThemeColors` (swallowed,
 * because zustand swallows what `onRehydrateStorage` throws) and again in the
 * terminal-palette selector, which crashed the centre stage on every render —
 * and the entry stayed in storage, so every restart crashed identically, with
 * no path back from inside the app.
 *
 * So each entry is re-checked against {@link isHiveTheme} — the same shape
 * `importTheme` demands — and anything that fails is dropped. If the *active*
 * theme is one of the dropped ones, the id goes back to the built-in rather
 * than dangling: {@link activeThemeOf} tolerates a dangling id, but the gallery
 * would still ring a card that is no longer there.
 */
export function sanitizeThemeState(state: Record<string, unknown>): {
  themes: Record<string, HiveTheme>;
  activeThemeId: string;
} {
  const raw = state.themes;
  const themes: Record<string, HiveTheme> = {};
  /** Old id -> the id it was moved to, so the active pointer can follow it. */
  const rekeyed = new Map<string, string>();

  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [id, theme] of Object.entries(raw)) {
      if (!isHiveTheme(theme)) continue;

      // A library entry that collides with a shipped id is moved aside rather
      // than dropped. Before the shipped set landed only `hive` was
      // reserved, so a theme
      // imported as "Graphite" legitimately took the key `graphite`; now that
      // a built-in owns it, `activeThemeOf` resolves the shipped one first and
      // the imported theme becomes unreachable — while the gallery renders two
      // cards under one name, both ringed active. Re-keying keeps the person's
      // own theme, which dropping it would not.
      let key = id;
      if (Object.hasOwn(BUILT_IN_THEMES, key)) {
        let suffix = 2;
        while (
          Object.hasOwn(BUILT_IN_THEMES, `${id}-${suffix}`) ||
          Object.hasOwn(themes, `${id}-${suffix}`)
        ) {
          suffix += 1;
        }
        key = `${id}-${suffix}`;
        rekeyed.set(id, key);
      }

      themes[key] = theme;
    }
  }

  const requested = state.activeThemeId;
  // If the active id was the one just moved, follow it: that theme is what was
  // on screen before the upgrade, and the shipped theme is not a substitute
  // for it.
  const followed =
    typeof requested === 'string' ? (rekeyed.get(requested) ?? requested) : undefined;
  const activeThemeId =
    followed !== undefined &&
    (Object.hasOwn(BUILT_IN_THEMES, followed) || Object.hasOwn(themes, followed))
      ? followed
      : BUILT_IN_THEME_ID;

  return { themes, activeThemeId };
}

/**
 * Migrations. Exported for the test.
 *
 * **v1 → v2 (HIVE-80): the store gains a theme library.** Nobody's saved theme,
 * font, size, scrollback, density, team name or editor settings resets — the
 * two new fields are simply added, which is the whole job.
 *
 * **v2 → v3: the editor becomes editable by default.** A default change alone
 * would reach nobody who already has this app installed. The persist middleware
 * writes the whole partialized state on the first save of *anything* — one
 * theme flip is enough — so almost every existing install has
 * `editorEditable: false` on disk, not because the user chose it but because it
 * was the default when the value was written.
 *
 * Dropping the stored key is what lets the new default apply. It cannot
 * distinguish "never touched it" from "deliberately turned it off", and it does
 * not try to: the second group loses one toggle they can set again in Settings,
 * and the first group — everyone else — gets the change the release is for.
 * Turning it back off is one click; discovering the editor is still read-only
 * for reasons invisible in the UI is a bug report.
 *
 * Every other key is carried across untouched, as in v1 → v2.
 *
 * From v3 on there is nothing to add, only the library to re-check
 * ({@link sanitizeThemeState}) — a payload at the current version has been
 * writable by anything with a `localStorage` handle since the day it existed.
 */
export function migrateAppearance(
  persisted: unknown,
  version: number,
): Record<string, unknown> {
  const state = (persisted ?? {}) as Record<string, unknown>;

  if (version >= 3) return { ...state, ...sanitizeThemeState(state) };

  // v1 has no theme library at all; v2 has one that still needs re-checking.
  const withThemes: Record<string, unknown> =
    version >= 2
      ? { ...state, ...sanitizeThemeState(state) }
      : { ...state, themes: {}, activeThemeId: BUILT_IN_THEME_ID };

  // Deleted rather than set to `true`, so the default is stated in exactly one
  // place — `initialAppearanceState` — and this stays a migration rather than a
  // second definition of it.
  const { editorEditable: _dropped, ...rest } = withThemes;
  return rest;
}

export const APPEARANCE_STORAGE_KEY = 'hive.appearance';

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set, get) => ({
      ...initialAppearanceState,
      systemDark: prefersDark(),

      setTheme: (theme) => {
        applyTheme(resolveTheme(theme, get().systemDark));
        set({ theme });
      },

      /**
       * Commit to the opposite of what is on screen.
       *
       * From `system` this *leaves* system rather than cycling three ways: the
       * header's button is a two-state control the user pressed to change what
       * they are looking at, and landing them in a third state they never chose
       * is not what that press meant. Choosing `system` again is a deliberate
       * act, and the appearance section is where it is made.
       */
      toggleTheme: () => {
        const { theme, systemDark } = get();
        get().setTheme(resolveTheme(theme, systemDark) === 'dark' ? 'light' : 'dark');
      },

      setTerminalFont: (terminalFont) => set({ terminalFont }),
      setTerminalFontSize: (terminalFontSize) => set({ terminalFontSize }),
      setTerminalScrollback: (terminalScrollback) => set({ terminalScrollback }),

      setDensity: (density) => {
        applyDensity(density);
        set({ density });
        /*
          Re-run the override after the attribute changes. A rail the user never
          touched has no inline property, so this is what re-spaces it; a rail
          they did set keeps its width, but its *minimum* just moved and the
          override may now need clamping up to it.
        */
        applyStoredRailWidths({ ...get(), density });
      },

      /**
       * Clamped to `[min, RAIL_MAX_PX]` and no further.
       *
       * Deliberately not clamped against the window here. The window-dependent
       * bounds — the 30% share and the stage floor — belong to
       * `clampRailWidths` on the way to the screen, because a width stored
       * after being squeezed by a small window is a width the user never chose
       * and would never get back. What is stored is intent; what is painted is
       * intent within today's window.
       */
      setRailWidth: (side, width) => {
        if (!Number.isFinite(width)) return;

        const min = RAIL_MIN[get().density][side];
        const next = Math.round(Math.min(RAIL_MAX_PX, Math.max(min, width)));

        /*
          Writing a width is an unambiguous statement that the rail should be
          visible at that width, and it is the only thing drag-to-expand calls.
          Clearing here is what lets that gesture need no second action.
        */
        set(
          side === 'left'
            ? { railWidthLeft: next, railCollapsedLeft: false }
            : { railWidthRight: next, railCollapsedRight: false },
        );
      },

      resetRailWidth: (side) =>
        set(side === 'left' ? { railWidthLeft: null } : { railWidthRight: null }),

      setRailCollapsed: (side, collapsed) =>
        set(
          side === 'left'
            ? { railCollapsedLeft: collapsed }
            : { railCollapsedRight: collapsed },
        ),

      toggleRailCollapsed: (side) =>
        set((state) =>
          side === 'left'
            ? { railCollapsedLeft: !state.railCollapsedLeft }
            : { railCollapsedRight: !state.railCollapsedRight },
        ),

      /**
       * Stored exactly as typed.
       *
       * Not trimmed here, though it is tempting: the field writes on every
       * keystroke so the header updates live, and trimming on the way in eats
       * the space between two words as it is typed. The header trims for
       * display and the settings field trims when it commits.
       *
       * No fallback to the default on empty either — clearing the field is how
       * the line is turned off, and quietly refilling it would make that
       * impossible.
       */
      setTeamName: (teamName) => set({ teamName }),

      /**
       * The OS changed its mind while the app was open.
       *
       * Only repaints when the preference is actually `system`; a user pinned to
       * light does not want their screen to follow the OS at dusk.
       */
      setSystemDark: (systemDark) => {
        const { theme } = get();
        if (theme === 'system') applyTheme(resolveTheme(theme, systemDark));
        set({ systemDark });
      },

      setEditorPlacement: (editorPlacement) => set({ editorPlacement }),
      setEditorSplitAxis: (editorSplitAxis) => set({ editorSplitAxis }),
      /**
       * Clamped on the way in, not on the way out.
       *
       * The value arrives from a pointer drag, which can produce anything a
       * fast gesture past the edge of the window produces — including `NaN` on
       * a zero-width container. Storing the clamped value means every reader
       * gets a usable ratio without repeating the bound.
       */
      setEditorSplitRatio: (ratio) =>
        set({ editorSplitRatio: clampSplitRatio(ratio) }),
      /** The same clamp, for the same reason: the value arrives from a drag. */
      setConsoleSplitRatio: (ratio) =>
        set({ consoleSplitRatio: clampSplitRatio(ratio) }),
      setRunLogSplitRatio: (ratio) =>
        set({ runLogSplitRatio: clampSplitRatio(ratio) }),
      setEditorNav: (editorNav) => set({ editorNav }),
      setEditorEditable: (editorEditable) => set({ editorEditable }),
      setEditorFont: (editorFont) => set({ editorFont }),
      setEditorFontSize: (editorFontSize) => set({ editorFontSize }),
      setEditorWordWrap: (editorWordWrap) => set({ editorWordWrap }),
      setEditorLineNumbers: (editorLineNumbers) => set({ editorLineNumbers }),
      setEditorTabWidth: (editorTabWidth) => set({ editorTabWidth }),

      addTheme: (id, theme) =>
        set((state) => ({ themes: { ...state.themes, [id]: theme } })),

      activateTheme: (id) => {
        applyThemeColors(activeThemeOf({ themes: get().themes, activeThemeId: id }));
        set({ activeThemeId: id });
      },

      removeTheme: (id) => {
        const { themes, activeThemeId } = get();
        // A built-in is not a key of `themes`, so this is also what makes a
        // shipped theme unremovable — the gallery hides the control, and this
        // is the guard behind it.
        if (!Object.hasOwn(themes, id)) return;

        const { [id]: _removed, ...rest } = themes;
        const wasActive = activeThemeId === id;
        if (wasActive) applyThemeColors(null);

        set({
          themes: rest,
          activeThemeId: wasActive ? BUILT_IN_THEME_ID : activeThemeId,
        });
      },

      reset: () => {
        const systemDark = prefersDark();
        applyAll({ ...initialAppearanceState, systemDark });
        set({ ...initialAppearanceState, systemDark });
      },
    }),
    {
      name: APPEARANCE_STORAGE_KEY,
      version: 3,
      /**
       * `migrateAppearance` is typed loosely (`Record<string, unknown>`) so the
       * test can hand it a bare v1 payload; the persist option needs the exact
       * {@link PersistedAppearanceState} shape, which is what that function
       * actually produces.
       */
      migrate: (persistedState, version) =>
        migrateAppearance(persistedState, version) as unknown as PersistedAppearanceState,
      /**
       * Where the theme library is actually re-checked.
       *
       * `migrate` only runs when the stored version differs from this one, so
       * it can never be the gate: the overwhelmingly common case is a v2
       * payload rehydrating into a v2 store, which skips migration entirely.
       * `merge` runs on every rehydrate, whichever path got here, which is what
       * makes {@link sanitizeThemeState} unskippable.
       */
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Record<string, unknown>;
        return {
          ...currentState,
          ...persisted,
          ...sanitizeThemeState(persisted),
        } as AppearanceState;
      },
      storage: createJSONStorage(() => localStorage),
      /**
       * The whitelist is the point of this store existing. Actions are excluded
       * by zustand already; `systemDark` is excluded deliberately (see above).
       */
      partialize: (state): PersistedAppearanceState => ({
        theme: state.theme,
        terminalFont: state.terminalFont,
        terminalFontSize: state.terminalFontSize,
        terminalScrollback: state.terminalScrollback,
        density: state.density,
        railWidthLeft: state.railWidthLeft,
        railWidthRight: state.railWidthRight,
        railCollapsedLeft: state.railCollapsedLeft,
        railCollapsedRight: state.railCollapsedRight,
        teamName: state.teamName,
        editorPlacement: state.editorPlacement,
        editorSplitAxis: state.editorSplitAxis,
        editorSplitRatio: state.editorSplitRatio,
        consoleSplitRatio: state.consoleSplitRatio,
        runLogSplitRatio: state.runLogSplitRatio,
        editorNav: state.editorNav,
        editorEditable: state.editorEditable,
        editorFont: state.editorFont,
        editorFontSize: state.editorFontSize,
        editorWordWrap: state.editorWordWrap,
        editorLineNumbers: state.editorLineNumbers,
        editorTabWidth: state.editorTabWidth,
        themes: state.themes,
        activeThemeId: state.activeThemeId,
      }),
      /**
       * `localStorage` is synchronous, so this runs during module evaluation —
       * before React renders anything. That is what makes the restored theme
       * paint on the first frame instead of flipping on the second.
       *
       * Whatever reaches this point is bootable, and that is a guarantee two
       * different mechanisms have to make between them. A syntactically corrupt
       * entry never parses, so it arrives as an `error` and leaves `state` at
       * the defaults. Valid JSON of the *wrong shape* parses perfectly and used
       * to arrive intact — so `merge` above re-checks the theme library and
       * drops what is not a theme. Neither case needs a branch here:
       * `applyAll` is called with whatever the store actually holds, and what it
       * holds is now always paintable.
       */
      onRehydrateStorage: () => (state) => {
        if (state) applyAll(state);
      },
    },
  ),
);

/**
 * Follow the OS while the app is open.
 *
 * Called once from the composition root. Returns its own teardown so a test can
 * subscribe and unsubscribe without leaking a listener between cases.
 * `addEventListener` on a `MediaQueryList` is the modern form; the deprecated
 * `addListener` is not worth a fallback in an Electron app and a current browser.
 */
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};

  const query = window.matchMedia(MEDIA_QUERY);
  const onChange = (event: MediaQueryListEvent) => {
    useAppearanceStore.getState().setSystemDark(event.matches);
  };

  // The OS may have changed between module evaluation and this call.
  useAppearanceStore.getState().setSystemDark(query.matches);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Selector hooks — the same rule as the other two stores.
 *
 * Components never read the store object directly and never call `getState()`.
 */
const themeActionsSelector = (state: AppearanceState) => ({
  setTheme: state.setTheme,
  toggleTheme: state.toggleTheme,
});

const themeLibraryActionsSelector = (state: AppearanceState) => ({
  addTheme: state.addTheme,
  activateTheme: state.activateTheme,
  removeTheme: state.removeTheme,
});

const terminalAppearanceSelector = (state: AppearanceState) => ({
  fontFamily: terminalFontStack(state.terminalFont),
  fontSize: state.terminalFontSize,
  scrollback: state.terminalScrollback,
  /**
   * The one place colour crosses into the terminal (story 105, extended by
   * HIVE-80).
   *
   * `components/terminal/**` may not import `stores/**`, so the composition
   * root reads this and passes it as a prop — the terminal is handed colours,
   * exactly as it is handed a font stack, and never learns that a theme was
   * picked.
   *
   * **A stored reference, never a copy.** `useTerminalAppearance` wraps this in
   * `useShallow`, which compares one level deep, and the surface's re-theme
   * effect depends on this object's identity: a spread here would hand every
   * live terminal a new palette on every render.
   */
  palette: (activeThemeOf(state) ?? BUILT_IN_THEME).modes[
    resolveTheme(state.theme, state.systemDark)
  ].terminal,
});

const appearanceActionsSelector = (state: AppearanceState) => ({
  setTheme: state.setTheme,
  setTerminalFont: state.setTerminalFont,
  setTerminalFontSize: state.setTerminalFontSize,
  setTerminalScrollback: state.setTerminalScrollback,
  setDensity: state.setDensity,
  setTeamName: state.setTeamName,
});

const appearanceSettingsSelector = (state: AppearanceState) => ({
  theme: state.theme,
  terminalFont: state.terminalFont,
  terminalFontSize: state.terminalFontSize,
  terminalScrollback: state.terminalScrollback,
  density: state.density,
  teamName: state.teamName,
});

/**
 * The theme actually on screen.
 *
 * Everything that paints reads this, never the stored preference — `system` is
 * not a palette and no consumer should have to know that.
 */
export const useTheme = (): ResolvedTheme =>
  useAppearanceStore((state) => resolveTheme(state.theme, state.systemDark));

/**
 * The same answer as {@link useTheme}, for a caller that is not a component.
 *
 * A hook cannot be called from a store action, and the one caller that needs
 * this is exactly that: `hive-store` reads the theme when it spawns a session,
 * so `claude` can be told which way round to paint its own UI in the terminal
 * it is about to draw into.
 *
 * Exported as a function rather than leaving the caller to `getState()` and
 * `resolveTheme` for itself, so `system` is resolved in the one place that
 * knows how — a caller that read `state.theme` directly would hand `'system'`
 * to something expecting a palette.
 */
export const currentTheme = (): ResolvedTheme => {
  const { theme, systemDark } = useAppearanceStore.getState();
  return resolveTheme(theme, systemDark);
};

/** The stored preference — the appearance section's radio group, and nothing else. */
export const useThemePreference = () => useAppearanceStore((state) => state.theme);

/** Theme actions, referentially stable across unrelated state changes. */
export const useThemeActions = () =>
  useAppearanceStore(useShallow(themeActionsSelector));

/** The imported theme library, keyed by import id. */
export const useThemes = (): Record<string, HiveTheme> =>
  useAppearanceStore((state) => state.themes);

/** The id of the theme currently painting the app — {@link BUILT_IN_THEME_ID} or a library key. */
export const useActiveThemeId = (): string =>
  useAppearanceStore((state) => state.activeThemeId);

/** The active theme itself, or `null` when the built-in is active. */
export const useActiveTheme = (): HiveTheme | null =>
  useAppearanceStore((state) => activeThemeOf(state));

/** Theme-library actions, referentially stable across unrelated state changes. */
export const useThemeLibraryActions = () =>
  useAppearanceStore(useShallow(themeLibraryActionsSelector));

/**
 * Everything the terminal needs, resolved.
 *
 * Returns the font *stack* rather than the id: `components/terminal/**` may not
 * import from `lib` conventions it does not own, and more to the point it should
 * not know that "menlo" is a choice a user made. It takes a font stack.
 *
 * `palette` arrives on the same terms (HIVE-80) — eleven resolved colours, not
 * the name of a mode and not the name of a theme.
 */
export const useTerminalAppearance = () =>
  useAppearanceStore(useShallow(terminalAppearanceSelector));

/** Rail density. */
export const useDensity = () => useAppearanceStore((state) => state.density);

/**
 * The header's sublabel, trimmed — empty means the line is not drawn.
 *
 * Trimming here rather than in the setter keeps the settings field typable
 * (see `setTeamName`), and keeps every reader from having to remember it.
 */
export const useTeamName = (): string =>
  useAppearanceStore((state) => state.teamName.trim());

/** The appearance section's current values and its setters. */
export const useAppearanceSettings = () =>
  useAppearanceStore(useShallow(appearanceSettingsSelector));
export const useAppearanceActions = () =>
  useAppearanceStore(useShallow(appearanceActionsSelector));

/**
 * Everything the CodeMirror surface needs, resolved.
 *
 * Returns the font *stack* rather than the id, for the reason
 * `useTerminalAppearance` does: `components/editor/**` takes a stack and has no
 * business knowing that "menlo" was a thing a user picked from a list.
 *
 * Deliberately narrower than {@link useEditorSettings}: the surface re-renders
 * on a font change, and subscribing it to `editorPlacement` as well would
 * reconstruct the editor every time the layout toggled.
 */
const editorAppearanceSelector = (state: AppearanceState) => ({
  fontFamily: terminalFontStack(state.editorFont),
  fontSize: state.editorFontSize,
  wordWrap: state.editorWordWrap,
  lineNumbers: state.editorLineNumbers,
  tabWidth: state.editorTabWidth,
  editable: state.editorEditable,
});

/**
 * How the stage is arranged. Read by `center-stage.tsx` and the tab strip.
 *
 * Separate from the appearance selector above because the two have different
 * consumers and different change rates: dragging the divider must not
 * reconstruct the editor, and changing the font must not re-lay-out the stage.
 */
const editorLayoutSelector = (state: AppearanceState) => ({
  placement: state.editorPlacement,
  splitAxis: state.editorSplitAxis,
  splitRatio: state.editorSplitRatio,
  nav: state.editorNav,
});

const editorSettingsSelector = (state: AppearanceState) => ({
  editorPlacement: state.editorPlacement,
  editorSplitAxis: state.editorSplitAxis,
  editorNav: state.editorNav,
  editorEditable: state.editorEditable,
  editorFont: state.editorFont,
  editorFontSize: state.editorFontSize,
  editorWordWrap: state.editorWordWrap,
  editorLineNumbers: state.editorLineNumbers,
  editorTabWidth: state.editorTabWidth,
});

const editorSettingsActionsSelector = (state: AppearanceState) => ({
  setEditorPlacement: state.setEditorPlacement,
  setEditorSplitAxis: state.setEditorSplitAxis,
  setEditorNav: state.setEditorNav,
  setEditorEditable: state.setEditorEditable,
  setEditorFont: state.setEditorFont,
  setEditorFontSize: state.setEditorFontSize,
  setEditorWordWrap: state.setEditorWordWrap,
  setEditorLineNumbers: state.setEditorLineNumbers,
  setEditorTabWidth: state.setEditorTabWidth,
});

export const useEditorAppearance = () =>
  useAppearanceStore(useShallow(editorAppearanceSelector));

export const useEditorLayout = () =>
  useAppearanceStore(useShallow(editorLayoutSelector));

/** Whether the editor accepts input. Its own hook — the tab strip needs only this. */
export const useEditorEditable = () =>
  useAppearanceStore((state) => state.editorEditable);

/** Written by dragging the divider, not by a settings control. */
export const useSetEditorSplitRatio = () =>
  useAppearanceStore((state) => state.setEditorSplitRatio);

/**
 * The fleet table's share of the overmind column, and its setter.
 *
 * Its own pair rather than a field on `useEditorLayout`: the console split
 * changes on every `pointermove` of its divider, and the editor layout
 * selector is subscribed to by the tab strip, which has no business
 * re-rendering while the fleet table is dragged.
 */
export const useConsoleSplitRatio = () =>
  useAppearanceStore((state) => state.consoleSplitRatio);

export const useSetConsoleSplitRatio = () =>
  useAppearanceStore((state) => state.setConsoleSplitRatio);

/** The receipts' share of an agent's run log, and its setter — the third divider. */
export const useRunLogSplitRatio = () =>
  useAppearanceStore((state) => state.runLogSplitRatio);

export const useSetRunLogSplitRatio = () =>
  useAppearanceStore((state) => state.setRunLogSplitRatio);

/**
 * The stored rail widths, their collapse flags, and the density they are
 * bounded by (HIVE-105).
 *
 * Deliberately these fields and no more. `use-rail-widths` is the only
 * consumer, it runs at the composition root, and widening this selector would
 * re-run the clamp — and touch `<body>` — every time an unrelated appearance
 * field changed. The collapse flags belong here rather than behind a second
 * hook because every consumer of the widths also needs to know whether a rail
 * is currently a strip.
 */
const railWidthSelector = (state: AppearanceState) => ({
  railWidthLeft: state.railWidthLeft,
  railWidthRight: state.railWidthRight,
  railCollapsedLeft: state.railCollapsedLeft,
  railCollapsedRight: state.railCollapsedRight,
  density: state.density,
});

export const useRailWidthState = () => useAppearanceStore(useShallow(railWidthSelector));

/** Written by dragging a rail's handle, for the same reason as the divider above. */
export const useSetRailWidth = () => useAppearanceStore((state) => state.setRailWidth);

/** Double-click on a handle — back to following the stylesheet. */
export const useResetRailWidth = () => useAppearanceStore((state) => state.resetRailWidth);

/** The strip gesture and both chords. */
export const useToggleRailCollapsed = () =>
  useAppearanceStore((state) => state.toggleRailCollapsed);

/** Drag-past-the-edge, and the header bell un-collapsing the activity rail. */
export const useSetRailCollapsed = () => useAppearanceStore((state) => state.setRailCollapsed);

/** The editor section's current values and its setters. */
export const useEditorSettings = () =>
  useAppearanceStore(useShallow(editorSettingsSelector));
export const useEditorSettingsActions = () =>
  useAppearanceStore(useShallow(editorSettingsActionsSelector));

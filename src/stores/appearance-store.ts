import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';

import type { SwarmPalette } from '@lib/swarm/palette';
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
import { swarmPaletteOf } from '@lib/theme/colour';
import { BUILT_IN_THEME_ID, type HiveTheme, type UiColors } from '@lib/theme/contract';
import {
  activeThemeOf,
  APPEARANCE_STORAGE_KEY,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '@lib/theme/persisted';
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

export { activeThemeOf, APPEARANCE_STORAGE_KEY, resolveTheme } from '@lib/theme/persisted';
export type { ThemePreference } from '@lib/theme/persisted';

export type Density = 'comfortable' | 'compact';

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

/**
 * How a `.md` file opens (the markdown preview). Preview by default: in this
 * app markdown is mostly read — specs, plans, `AGENTS.md` — not written.
 */
export type MarkdownOpensIn = 'preview' | 'source';

/** Round two's session panel tabs (HIVE-201). Ticket is HIVE-202's, PR is HIVE-209's. */
export type SessionPanelTab = 'plan' | 'ticket' | 'pr' | 'files';

const SESSION_PANEL_TABS: readonly SessionPanelTab[] = ['plan', 'ticket', 'pr', 'files'];

interface AppearanceState {
  theme: ThemePreference;
  terminalFont: TerminalFontId;
  terminalFontSize: number;
  terminalScrollback: number;
  density: Density;
  /**
   * Round two's session panel (HIVE-201): open or closed is one setting for
   * the app, and the last tab follows you from session to session. Ticket and
   * PR exist from the start so HIVE-202 and HIVE-209 need no migration.
   */
  sessionPanelOpen: boolean;
  sessionPanelTab: SessionPanelTab;
  /** The list and session panels' widths in px, dragged from their seams; see {@link PANEL_WIDTHS}. */
  listPanelWidth: number;
  sessionPanelWidth: number;

  /**
   * The line under the wordmark — whose hive this is. The activity bar's brand
   * tooltip shows it.
   *
   * Appearance rather than config, on this store's own test: it is a fact about
   * the person looking at the screen, it is needed on the first paint, and the browser target has no config file to read it from. That it
   * happens to name a team does not make it workspace state — no session, PTY
   * or ticket ever reads it.
   *
   * Empty is a legitimate answer, and means the line is not drawn at all.
   */
  teamName: string;

  /**
   * What's new (1.0): the `major.minor` whose screen was last shown, closed any
   * way, and the "Don't show What's new again" box. Persisted here, with every
   * other per-install preference, so neither replays on the next launch.
   */
  whatsNewSeen: string | null;
  whatsNewOff: boolean;

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
  /**
   * The Form pane's share of the agent page's Definition, beside its Source.
   * The editor holds both panes to a minimum px width on top of this clamp.
   */
  agentSplitRatio: number;
  editorNav: EditorNav;
  markdownOpensIn: MarkdownOpensIn;
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
  /** Open or close round two's session panel (HIVE-201). */
  setSessionPanelOpen: (open: boolean) => void;
  toggleSessionPanel: () => void;
  /** The tab the session panel shows (HIVE-201). */
  setSessionPanelTab: (tab: SessionPanelTab) => void;
  setTeamName: (name: string) => void;
  setWhatsNewSeen: (version: string) => void;
  setWhatsNewOff: (off: boolean) => void;
  setSystemDark: (dark: boolean) => void;

  setEditorPlacement: (placement: EditorPlacement) => void;
  setEditorSplitAxis: (axis: EditorSplitAxis) => void;
  setEditorSplitRatio: (ratio: number) => void;
  setConsoleSplitRatio: (ratio: number) => void;
  setRunLogSplitRatio: (ratio: number) => void;
  setAgentSplitRatio: (ratio: number) => void;
  setListPanelWidth: (px: number) => void;
  setSessionPanelWidth: (px: number) => void;
  setEditorNav: (nav: EditorNav) => void;
  setMarkdownOpensIn: (value: MarkdownOpensIn) => void;
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
 * What the brand tooltip says under "The Hive" until someone says otherwise.
 *
 * A hive's workers are a swarm and this app is a command centre for them, so
 * the default names the room rather than any real team — anyone who has not
 * set theirs still gets a line that belongs to this app.
 */
export const DEFAULT_TEAM_NAME = 'Swarm Command';

/** The terminal's share of a split stage, clamped to something usable. */
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

/** The agent editor's Form share before anyone drags its seam. */
export const DEFAULT_AGENT_SPLIT_RATIO = 0.45;

export const clampSplitRatio = (ratio: number): number => {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
};

/**
 * The two rails' drag bounds, px. Their minimums are also their CSS
 * `min-width`: when a window cannot hold both rails at their saved widths
 * beside {@link STAGE_MIN}, flexbox pulls them in toward these (HIVE-223).
 */
export const PANEL_WIDTHS = {
  list: { min: 220, max: 400, initial: 300 },
  session: { min: 260, max: 480, initial: 320 },
} as const;

/** The narrowest the centre stage may be drawn while both rails sit beside it (HIVE-223). */
export const STAGE_MIN = 520;

export type PanelRail = keyof typeof PANEL_WIDTHS;

/** Whole pixels inside the rail's bounds; anything that is not a number reads as the initial width. */
export const clampPanelWidth = (rail: PanelRail, px: unknown): number => {
  const { min, max, initial } = PANEL_WIDTHS[rail];
  if (typeof px !== 'number' || !Number.isFinite(px)) return initial;
  return Math.round(Math.min(max, Math.max(min, px)));
};

const MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** The OS preference right now, or dark when nothing can be asked (SSR, tests). */
function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia(MEDIA_QUERY).matches;
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
 * tokens.css apply unmodified. One attribute write re-spaces every list row and
 * card, and no component re-renders to do it.
 */
function applyDensity(density: Density) {
  if (typeof document === 'undefined') return;

  if (density === 'compact') {
    document.body.setAttribute('data-density', 'compact');
  } else {
    document.body.removeAttribute('data-density');
  }
}

/** Push everything that lives on `<body>` (and the theme style element) at once — rehydration and reset. */
function applyAll(
  state: Pick<AppearanceState, 'theme' | 'systemDark' | 'density' | 'themes' | 'activeThemeId'>,
) {
  applyTheme(resolveTheme(state.theme, state.systemDark));
  applyDensity(state.density);
  applyThemeColors(activeThemeOf(state));
}

const initialAppearanceState = {
  /**
   * Dark, not `system`.
   *
   * This story adds `system` as an *option*; it does not change what the app
   * boots as. "Dark is the default" is story 011's decision, it is what
   * `:root` in tokens.css encodes, and the smoke spec seeds the theme it
   * expects to boot with. Quietly making a
   * light-mode machine open light would reverse a documented decision this
   * story has no mandate to reverse — and would do it invisibly, since the
   * only symptom is that the app looks different on someone else's laptop.
   */
  theme: 'dark' as ThemePreference,
  terminalFont: DEFAULT_TERMINAL_FONT,
  terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
  terminalScrollback: DEFAULT_TERMINAL_SCROLLBACK,
  density: 'comfortable' as Density,
  /** Open, on Plan: Files is where the Explorer lived, so open shows the user what moved (D14). */
  sessionPanelOpen: true,
  sessionPanelTab: 'plan' as SessionPanelTab,
  listPanelWidth: PANEL_WIDTHS.list.initial,
  sessionPanelWidth: PANEL_WIDTHS.session.initial,
  teamName: DEFAULT_TEAM_NAME,
  whatsNewSeen: null as string | null,
  whatsNewOff: false,

  /** Full stage: the editor is a place you go, not a permanent tax on the terminal. */
  editorPlacement: 'full' as EditorPlacement,
  /**
   * Vertical, chosen against the merits and recorded as such.
   *
   * With the bar, the list panel and the session panel open the shell
   * spends ~680px on chrome, so a
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
  agentSplitRatio: DEFAULT_AGENT_SPLIT_RATIO,
  editorNav: 'tabs' as EditorNav,
  markdownOpensIn: 'preview' as MarkdownOpensIn,
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
  sessionPanelOpen: boolean;
  sessionPanelTab: SessionPanelTab;
  listPanelWidth: number;
  sessionPanelWidth: number;
  teamName: string;
  whatsNewSeen: string | null;
  whatsNewOff: boolean;
  editorPlacement: EditorPlacement;
  editorSplitAxis: EditorSplitAxis;
  editorSplitRatio: number;
  consoleSplitRatio: number;
  runLogSplitRatio: number;
  agentSplitRatio: number;
  editorNav: EditorNav;
  markdownOpensIn: MarkdownOpensIn;
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

/** What HIVE-213 retired with Classic; dropped from every payload older than v4. */
const CLASSIC_KEYS: readonly string[] = [
  'layout',
  'railWidthLeft',
  'railWidthRight',
  'railCollapsedLeft',
  'railCollapsedRight',
  'planPinned',
  'showPlanPanel',
];

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
 * **v3 → v4 (HIVE-213): Classic is deleted.** `layout`, the four rail keys,
 * `planPinned` and `showPlanPanel` are dropped from the stored payload, because
 * `merge` spreads it over the defaults and a stale key would otherwise ride into
 * live state. Every other key is carried across untouched, as in v1 → v2.
 *
 * From v4 on there is nothing to add, only the library to re-check
 * ({@link sanitizeThemeState}) — a payload at the current version has been
 * writable by anything with a `localStorage` handle since the day it existed.
 */
export function migrateAppearance(
  persisted: unknown,
  version: number,
): Record<string, unknown> {
  const stored = (persisted ?? {}) as Record<string, unknown>;

  if (version >= 4) return { ...stored, ...sanitizeThemeState(stored) };

  // Before v4 the stored object may carry Classic's keys, and `merge` would spread them into live state.
  const state = Object.fromEntries(Object.entries(stored).filter(([key]) => !CLASSIC_KEYS.includes(key)));

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
       * bar's toggle is a two-state control the user pressed to change what
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
      },

      setSessionPanelOpen: (sessionPanelOpen) => set({ sessionPanelOpen }),
      toggleSessionPanel: () => set((state) => ({ sessionPanelOpen: !state.sessionPanelOpen })),
      setSessionPanelTab: (sessionPanelTab) => set({ sessionPanelTab }),

      /**
       * Stored exactly as typed.
       *
       * Not trimmed here, though it is tempting: the field writes on every
       * keystroke so the brand tooltip updates live, and trimming on the way in
       * eats the space between two words as it is typed. Readers trim for
       * display and the settings field trims when it commits.
       *
       * No fallback to the default on empty either — clearing the field is how
       * the line is turned off, and quietly refilling it would make that
       * impossible.
       */
      setTeamName: (teamName) => set({ teamName }),
      setWhatsNewSeen: (whatsNewSeen) => set({ whatsNewSeen }),
      setWhatsNewOff: (whatsNewOff) => set({ whatsNewOff }),

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
      setAgentSplitRatio: (ratio) =>
        set({ agentSplitRatio: clampSplitRatio(ratio) }),
      setListPanelWidth: (px) => set({ listPanelWidth: clampPanelWidth('list', px) }),
      setSessionPanelWidth: (px) => set({ sessionPanelWidth: clampPanelWidth('session', px) }),
      setEditorNav: (editorNav) => set({ editorNav }),
      setMarkdownOpensIn: (markdownOpensIn) => set({ markdownOpensIn }),
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
      version: 4,
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
       * it can never be the gate: the overwhelmingly common case is a current
       * payload rehydrating into a current store, which skips migration entirely.
       * `merge` runs on every rehydrate, whichever path got here, which is what
       * makes {@link sanitizeThemeState} unskippable.
       */
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Record<string, unknown>;
        return {
          ...currentState,
          ...persisted,
          ...sanitizeThemeState(persisted),
          // No version bump for HIVE-201: an absent or bad value reads as the default.
          sessionPanelOpen:
            typeof persisted.sessionPanelOpen === 'boolean' ? persisted.sessionPanelOpen : true,
          sessionPanelTab: SESSION_PANEL_TABS.includes(persisted.sessionPanelTab as SessionPanelTab)
            ? (persisted.sessionPanelTab as SessionPanelTab)
            : 'plan',
          // No version bump for the rails either: absent or bad reads as the initial width.
          listPanelWidth: clampPanelWidth('list', persisted.listPanelWidth),
          sessionPanelWidth: clampPanelWidth('session', persisted.sessionPanelWidth),
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
        sessionPanelOpen: state.sessionPanelOpen,
        sessionPanelTab: state.sessionPanelTab,
        listPanelWidth: state.listPanelWidth,
        sessionPanelWidth: state.sessionPanelWidth,
        teamName: state.teamName,
        editorPlacement: state.editorPlacement,
        editorSplitAxis: state.editorSplitAxis,
        editorSplitRatio: state.editorSplitRatio,
        consoleSplitRatio: state.consoleSplitRatio,
        runLogSplitRatio: state.runLogSplitRatio,
        agentSplitRatio: state.agentSplitRatio,
        editorNav: state.editorNav,
        markdownOpensIn: state.markdownOpensIn,
        editorEditable: state.editorEditable,
        editorFont: state.editorFont,
        editorFontSize: state.editorFontSize,
        editorWordWrap: state.editorWordWrap,
        editorLineNumbers: state.editorLineNumbers,
        editorTabWidth: state.editorTabWidth,
        themes: state.themes,
        activeThemeId: state.activeThemeId,
        whatsNewSeen: state.whatsNewSeen,
        whatsNewOff: state.whatsNewOff,
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

/** The imported theme library, keyed by import id. */
export const useThemes = (): Record<string, HiveTheme> =>
  useAppearanceStore((state) => state.themes);

/** The id of the theme currently painting the app — {@link BUILT_IN_THEME_ID} or a library key. */
export const useActiveThemeId = (): string =>
  useAppearanceStore((state) => state.activeThemeId);

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

/** One palette per ui object, so a re-read hands back the same reference. */
const swarmPalettes = new WeakMap<UiColors, SwarmPalette>();

/**
 * The swarm canvas's colours (HIVE-199), built like the terminal's palette:
 * from the active theme's resolved mode, never from `getComputedStyle`.
 *
 * Memoised on the theme's `ui` object rather than rebuilt per read, so an
 * unrelated appearance write returns the same reference and Home does not
 * repaint for it; a theme or mode switch is a different `ui` object and a new
 * palette.
 */
export const useSwarmPalette = (): SwarmPalette =>
  useAppearanceStore((state) => {
    const ui = (activeThemeOf(state) ?? BUILT_IN_THEME).modes[
      resolveTheme(state.theme, state.systemDark)
    ].ui;
    let palette = swarmPalettes.get(ui);
    if (palette === undefined) {
      palette = swarmPaletteOf(ui);
      swarmPalettes.set(ui, palette);
    }
    return palette;
  });

/**
 * The brand tooltip's sublabel, trimmed — empty means the line is not drawn.
 *
 * Trimming here rather than in the setter keeps the settings field typable
 * (see `setTeamName`), and keeps every reader from having to remember it.
 */
export const useTeamName = (): string =>
  useAppearanceStore((state) => state.teamName.trim());

const whatsNewSelector = (state: AppearanceState) => ({
  seen: state.whatsNewSeen,
  off: state.whatsNewOff,
  setSeen: state.setWhatsNewSeen,
  setOff: state.setWhatsNewOff,
});

/** What's new's persisted state and its two setters (1.0). */
export const useWhatsNewPrefs = () => useAppearanceStore(useShallow(whatsNewSelector));

/** What is on screen, `system` resolved against the OS (HIVE-213, the bar's toggle). */
export const useResolvedTheme = (): ResolvedTheme =>
  useAppearanceStore((state) => resolveTheme(state.theme, state.systemDark));
export const useToggleTheme = () => useAppearanceStore((state) => state.toggleTheme);

/** The appearance section's current values and its setters. */
export const useAppearanceSettings = () =>
  useAppearanceStore(useShallow(appearanceSettingsSelector));
export const useAppearanceActions = () =>
  useAppearanceStore(useShallow(appearanceActionsSelector));

/** Whether round two's session panel is open (HIVE-201). */
export const useSessionPanelOpen = () => useAppearanceStore((state) => state.sessionPanelOpen);
/** The session panel's last tab (HIVE-201). */
export const useSessionPanelTab = () => useAppearanceStore((state) => state.sessionPanelTab);
export const useSetSessionPanelOpen = () => useAppearanceStore((state) => state.setSessionPanelOpen);
export const useToggleSessionPanel = () => useAppearanceStore((state) => state.toggleSessionPanel);
export const useSetSessionPanelTab = () => useAppearanceStore((state) => state.setSessionPanelTab);
/** A rail's width in px, and its setter. */
export const useListPanelWidth = () => useAppearanceStore((state) => state.listPanelWidth);
export const useSessionPanelWidth = () => useAppearanceStore((state) => state.sessionPanelWidth);
export const useSetListPanelWidth = () => useAppearanceStore((state) => state.setListPanelWidth);
export const useSetSessionPanelWidth = () => useAppearanceStore((state) => state.setSessionPanelWidth);

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
  markdownOpensIn: state.markdownOpensIn,
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
  setMarkdownOpensIn: state.setMarkdownOpensIn,
});

export const useEditorAppearance = () =>
  useAppearanceStore(useShallow(editorAppearanceSelector));

export const useEditorLayout = () =>
  useAppearanceStore(useShallow(editorLayoutSelector));

/** The preview's default — read by the view hook, not by the store holding buffers. */
export const useMarkdownOpensIn = () => useAppearanceStore((state) => state.markdownOpensIn);

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

/** The Form pane's share of the agent page's Definition, and its setter. */
export const useAgentSplitRatio = () =>
  useAppearanceStore((state) => state.agentSplitRatio);

export const useSetAgentSplitRatio = () =>
  useAppearanceStore((state) => state.setAgentSplitRatio);

/** The editor section's current values and its setters. */
export const useEditorSettings = () =>
  useAppearanceStore(useShallow(editorSettingsSelector));
export const useEditorSettingsActions = () =>
  useAppearanceStore(useShallow(editorSettingsActionsSelector));

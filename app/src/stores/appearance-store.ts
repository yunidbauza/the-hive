import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';

import {
  DEFAULT_TERMINAL_FONT,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_TERMINAL_SCROLLBACK,
  terminalFontStack,
  type TerminalFontId,
} from '@lib/terminal/fonts';

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
 * `selIdx` — and persisting it would restore a picker that was open at quit.
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
  editorNav: EditorNav;
  /**
   * Whether the editor accepts keystrokes and offers a save.
   *
   * **Not a security control.** It lives in `localStorage`, so it gates the UI
   * and nothing else; the filesystem is gated by containment in main. It is
   * here because most of the time this app is used, the thing editing the file
   * is the agent in the terminal, and a second editable buffer over the same
   * file is a way to lose work rather than a convenience.
   */
  editorEditable: boolean;
  editorFont: TerminalFontId;
  editorFontSize: number;
  editorWordWrap: boolean;
  editorLineNumbers: boolean;
  editorTabWidth: number;

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
  setSystemDark: (dark: boolean) => void;

  setEditorPlacement: (placement: EditorPlacement) => void;
  setEditorSplitAxis: (axis: EditorSplitAxis) => void;
  setEditorSplitRatio: (ratio: number) => void;
  setEditorNav: (nav: EditorNav) => void;
  setEditorEditable: (editable: boolean) => void;
  setEditorFont: (font: TerminalFontId) => void;
  setEditorFontSize: (size: number) => void;
  setEditorWordWrap: (wrap: boolean) => void;
  setEditorLineNumbers: (show: boolean) => void;
  setEditorTabWidth: (width: number) => void;

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

/** Push everything that lives on `<body>` at once — rehydration and reset. */
function applyAll(state: Pick<AppearanceState, 'theme' | 'systemDark' | 'density'>) {
  applyTheme(resolveTheme(state.theme, state.systemDark));
  applyDensity(state.density);
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
  editorNav: 'tabs' as EditorNav,
  editorEditable: false,
  editorFont: DEFAULT_TERMINAL_FONT,
  editorFontSize: 13,
  editorWordWrap: true,
  editorLineNumbers: true,
  editorTabWidth: 2,
};

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
      },

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
      setEditorNav: (editorNav) => set({ editorNav }),
      setEditorEditable: (editorEditable) => set({ editorEditable }),
      setEditorFont: (editorFont) => set({ editorFont }),
      setEditorFontSize: (editorFontSize) => set({ editorFontSize }),
      setEditorWordWrap: (editorWordWrap) => set({ editorWordWrap }),
      setEditorLineNumbers: (editorLineNumbers) => set({ editorLineNumbers }),
      setEditorTabWidth: (editorTabWidth) => set({ editorTabWidth }),

      reset: () => {
        const systemDark = prefersDark();
        applyAll({ ...initialAppearanceState, systemDark });
        set({ ...initialAppearanceState, systemDark });
      },
    }),
    {
      name: APPEARANCE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      /**
       * The whitelist is the point of this store existing. Actions are excluded
       * by zustand already; `systemDark` is excluded deliberately (see above).
       */
      partialize: (state) => ({
        theme: state.theme,
        terminalFont: state.terminalFont,
        terminalFontSize: state.terminalFontSize,
        terminalScrollback: state.terminalScrollback,
        density: state.density,
        editorPlacement: state.editorPlacement,
        editorSplitAxis: state.editorSplitAxis,
        editorSplitRatio: state.editorSplitRatio,
        editorNav: state.editorNav,
        editorEditable: state.editorEditable,
        editorFont: state.editorFont,
        editorFontSize: state.editorFontSize,
        editorWordWrap: state.editorWordWrap,
        editorLineNumbers: state.editorLineNumbers,
        editorTabWidth: state.editorTabWidth,
      }),
      /**
       * `localStorage` is synchronous, so this runs during module evaluation —
       * before React renders anything. That is what makes the restored theme
       * paint on the first frame instead of flipping on the second.
       *
       * A corrupt entry arrives here as an `error` and leaves `state` at the
       * defaults, which is the right outcome and needs no branch of its own:
       * `applyAll` is called with whatever the store actually holds.
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

const terminalAppearanceSelector = (state: AppearanceState) => ({
  fontFamily: terminalFontStack(state.terminalFont),
  fontSize: state.terminalFontSize,
  scrollback: state.terminalScrollback,
});

const appearanceActionsSelector = (state: AppearanceState) => ({
  setTheme: state.setTheme,
  setTerminalFont: state.setTerminalFont,
  setTerminalFontSize: state.setTerminalFontSize,
  setTerminalScrollback: state.setTerminalScrollback,
  setDensity: state.setDensity,
});

const appearanceSettingsSelector = (state: AppearanceState) => ({
  theme: state.theme,
  terminalFont: state.terminalFont,
  terminalFontSize: state.terminalFontSize,
  terminalScrollback: state.terminalScrollback,
  density: state.density,
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

/**
 * Everything the terminal needs, resolved.
 *
 * Returns the font *stack* rather than the id: `components/terminal/**` may not
 * import from `lib` conventions it does not own, and more to the point it should
 * not know that "menlo" is a choice a user made. It takes a font stack.
 */
export const useTerminalAppearance = () =>
  useAppearanceStore(useShallow(terminalAppearanceSelector));

/** Rail density. */
export const useDensity = () => useAppearanceStore((state) => state.density);

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

/** The editor section's current values and its setters. */
export const useEditorSettings = () =>
  useAppearanceStore(useShallow(editorSettingsSelector));
export const useEditorSettingsActions = () =>
  useAppearanceStore(useShallow(editorSettingsActionsSelector));

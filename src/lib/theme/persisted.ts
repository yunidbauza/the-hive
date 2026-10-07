import { applyThemeColors } from '@lib/theme/apply';
import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { BUILT_IN_THEMES } from '@lib/theme/built-in-themes';
import { BUILT_IN_THEME_ID, type HiveTheme } from '@lib/theme/contract';
import { isHiveTheme } from '@lib/theme/validate';

/** What the user chose. `system` defers to the OS; it is not a third palette. */
export type ThemePreference = 'system' | 'dark' | 'light';

/** What the DOM actually gets. */
export type ResolvedTheme = 'dark' | 'light';

export const APPEARANCE_STORAGE_KEY = 'hive.appearance';

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
export function activeThemeOf(state: {
  themes: Readonly<Record<string, HiveTheme>>;
  activeThemeId: string;
}): HiveTheme | null {
  const { activeThemeId } = state;
  if (activeThemeId === BUILT_IN_THEME_ID) return null;
  if (Object.hasOwn(BUILT_IN_THEMES, activeThemeId)) return BUILT_IN_THEMES[activeThemeId];
  if (Object.hasOwn(state.themes, activeThemeId)) return state.themes[activeThemeId];
  return null;
}

/** The store's own default when nothing is saved (`initialAppearanceState.theme`). */
const DEFAULT_PREFERENCE: ThemePreference = 'dark';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The saved appearance, read without the store (HIVE-224): for the About and
 * splash windows, documents on the same origin that may not import the app's runtime.
 * localStorage is a trust boundary, so an imported theme counts only if it is
 * still a valid theme, and anything unreadable is the built-in. Never throws.
 */
export function readPersistedAppearance(
  storage: Pick<Storage, 'getItem'>,
  prefersDark: boolean,
): { mode: ResolvedTheme; theme: HiveTheme } {
  let state: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null');
    if (isRecord(parsed) && isRecord(parsed.state)) state = parsed.state;
  } catch {
    // Unreadable: the built-in, below.
  }
  const preference =
    state.theme === 'system' || state.theme === 'dark' || state.theme === 'light' ? state.theme : DEFAULT_PREFERENCE;
  const themes = isRecord(state.themes)
    ? Object.fromEntries(
        Object.entries(state.themes).filter((entry): entry is [string, HiveTheme] => isHiveTheme(entry[1])),
      )
    : {};
  const activeThemeId = typeof state.activeThemeId === 'string' ? state.activeThemeId : BUILT_IN_THEME_ID;
  return {
    mode: resolveTheme(preference, prefersDark),
    theme: activeThemeOf({ themes, activeThemeId }) ?? BUILT_IN_THEME,
  };
}

/**
 * Paint this document in the saved appearance: `body[data-theme]` and the
 * theme's colours, both modes, at the specificity `themeCss` gives them, so they
 * outrank whatever tokens the document imported.
 */
export function applyPersistedAppearance(storage: Pick<Storage, 'getItem'>, prefersDark: boolean): void {
  const { mode, theme } = readPersistedAppearance(storage, prefersDark);
  if (mode === 'light') document.body.dataset.theme = 'light';
  else delete document.body.dataset.theme;
  applyThemeColors(theme);
}

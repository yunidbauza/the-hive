import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

export type Theme = 'dark' | 'light';

/**
 * View state — what the user is looking at, as opposed to what the system
 * knows (which lives in `hive-store.ts`, story 012). The split is not cosmetic:
 * it keeps a keystroke in the picker from re-rendering thirteen terminals.
 *
 * Story 011 establishes this store with theme only. Story 012 adds the rest of
 * the view state (tabs, selection, picker, rail state).
 */
interface UiState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

/**
 * Write the theme to `<body data-theme>`, which is what the `body[data-theme]`
 * override in tokens.css keys off.
 *
 * Dark is the default and carries no attribute, so the `:root` block applies
 * unmodified — one less thing to keep in sync.
 */
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;

  if (theme === 'light') {
    document.body.setAttribute('data-theme', 'light');
  } else {
    document.body.removeAttribute('data-theme');
  }
}

export const useUiStore = create<UiState>()((set, get) => ({
  theme: 'dark',

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },

  toggleTheme: () => {
    get().setTheme(get().theme === 'dark' ? 'light' : 'dark');
  },
}));

/**
 * Selector hooks — the incorpx rule.
 *
 * Components never read the store object directly and never call `getState()`.
 * Every consumer goes through a named hook so a change to one slice of state
 * cannot re-render everything subscribed to the store.
 */
const themeSelector = (state: UiState) => state.theme;
const themeActionsSelector = (state: UiState) => ({
  setTheme: state.setTheme,
  toggleTheme: state.toggleTheme,
});

/** The active theme. */
export const useTheme = () => useUiStore(themeSelector);

/** Theme actions, referentially stable across unrelated state changes. */
export const useThemeActions = () => useUiStore(useShallow(themeActionsSelector));

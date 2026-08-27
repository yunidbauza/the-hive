import {
  BUILT_IN_THEME_ID,
  HIVE_THEME_VERSION,
  type HiveTheme,
} from '@lib/theme/contract';

/**
 * The Hive theme, as data.
 *
 * Every value here also appears in `tokens.css` (ui, syntax) or was the source
 * of `ansi.ts`'s palettes (terminal). `built-in.test.ts` reads the stylesheet
 * and fails if the two drift, which is why this file may hold hex literals and
 * component code may not.
 *
 * The dark `terminal` group is NOT derived from the ui group and must not be:
 * dark terminal text needs more lift than the chrome around it, and
 * `ansi.test.ts` asserts those colours never appear in `tokens.css`. The light
 * group is the opposite — a deliberate mirror.
 */
export const BUILT_IN_THEME: HiveTheme = {
  hiveThemeVersion: HIVE_THEME_VERSION,
  name: 'Hive',
  author: 'Built in',
  version: '1.0.0',
  modes: {
    dark: {
      ui: {
        bg: '#10152a', panel: '#141a33', panel2: '#121731',
        hover: '#1b2344', active: '#222c55',
        border: '#273159', borderSoft: '#1e2747',
        ink: '#e9effc', muted: '#98a3cc', subtle: '#6b779f',
        brand: '#8fa7f2', green: '#74b79c', amber: '#ffac47', red: '#ff8d85',
        chip: '#1c2648', chipHover: '#232e57',
        termBg: '#0b1023', termInput: '#0e1430',
        termRowHover: '#161f45', termRowActive: '#1a2450',
        termHead: '#4d5a86', termTrack: '#3a4674',
        brandFill: '#5e76d0', brandFillHover: '#4f6ac5',
        brandFillStrong: '#334fa9', onBrand: '#ffffff', dangerSolid: '#d3372f',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#b39ff0', string: '#74b79c', number: '#ffac47',
        comment: '#6b779f', name: '#8fa7f2', type: '#7fd0e0',
        operator: '#98a3cc', constant: '#ff8d85', invalid: '#ff8d85',
        activeLine: '#171e3c', selection: '#2b3768',
      },
      terminal: {
        bg: '#0b1023', ink: '#dbe4ff', dim: '#7c88b8', black: '#0b1023',
        green: '#7ee2b8', blue: '#8fb5ff', amber: '#ffc06e', red: '#ff8d85',
        cyan: '#7edce2', magenta: '#7edce2', selection: '#222c55',
        // The two surfaces (HIVE-82) — `--cc-term-input` and `--cc-hover`,
        // the raised fills the app already uses over this ground.
        surface: '#0e1430', surfaceAlt: '#1b2344',
      },
    },
    light: {
      ui: {
        bg: '#fdfdfb', panel: '#ffffff', panel2: '#f7fafb',
        hover: '#f4f9ff', active: '#e9f3fc',
        border: '#d4dee3', borderSoft: '#edf2f4',
        ink: '#2c2f34', muted: '#73767c', subtle: '#8e949c',
        brand: '#334fa9', green: '#2e6b52', amber: '#c77414', red: '#d3372f',
        chip: '#edf2f4', chipHover: '#e2eaee',
        termBg: '#f7fafb', termInput: '#ffffff',
        termRowHover: '#eef4f9', termRowActive: '#e4edf5',
        termHead: '#6b6e74', termTrack: '#d4dee3',
        // Theme-invariant: tokens.css does not override these in light.
        brandFill: '#5e76d0', brandFillHover: '#4f6ac5',
        brandFillStrong: '#334fa9', onBrand: '#ffffff', dangerSolid: '#d3372f',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#6f42c1', string: '#2e6b52', number: '#a1541a',
        comment: '#8e949c', name: '#334fa9', type: '#0b6b7d',
        operator: '#73767c', constant: '#b3271f', invalid: '#d3372f',
        activeLine: '#f4f9ff', selection: '#cfe3f7',
      },
      terminal: {
        bg: '#f7fafb', ink: '#2c2f34', dim: '#6b6e74', black: '#2c2f34',
        green: '#2e6b52', blue: '#334fa9', amber: '#a1541a', red: '#b3271f',
        cyan: '#0b6b7d', magenta: '#6f42c1', selection: '#cfe3f7',
        // `--cc-panel` and `--cc-chip`. The mirror of dark's pair: the ground
        // raised one step, then two.
        surface: '#ffffff', surfaceAlt: '#edf2f4',
      },
    },
  },
};

export { BUILT_IN_THEME_ID };

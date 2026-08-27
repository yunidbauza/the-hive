import { BUILT_IN_THEME } from '@lib/theme/built-in';
import {
  BUILT_IN_THEME_ID,
  HIVE_THEME_VERSION,
  type HiveTheme,
} from '@lib/theme/contract';

/**
 * The themes the app ships with, beyond the Hive itself.
 *
 * ## Why these are not in `tokens.css`
 *
 * `tokens.css` **is** the Hive theme — `built-in.ts` mirrors it and
 * `built-in.test.ts` fails on any drift between the two, in both directions.
 * That pact is exactly one theme wide and must stay that way: a second palette
 * in the stylesheet would have no `--cc-*` block to be compared against, and
 * the drift test would have to learn which declarations belong to which theme.
 *
 * So these six paint the way an *imported* theme paints — through
 * `applyThemeColors`, which writes a `<style>` element at runtime. The only
 * thing that makes them "built in" is that they ship in the bundle and cannot
 * be removed from the library. {@link activeThemeOf} keeps returning `null`
 * for the Hive alone, because for that one theme the stylesheet is already the
 * answer and writing a style element would be work with no effect.
 *
 * ## Generated, not typed
 *
 * Every value here came out of the palette generator the selection artifact was
 * rendered from, so a shipped theme is byte-identical to the specimen it was
 * chosen from. Hand-transcribing 588 hex values would have been 588 chances to
 * be one digit out. This file may hold hex literals for the same reason
 * `built-in.ts` may: it is the definition of a colour, not a use of one.
 */

/** Beeswax and warm oak. */
export const HONEYCOMB_THEME: HiveTheme = {
  hiveThemeVersion: HIVE_THEME_VERSION,
  name: 'Honeycomb',
  author: 'Built in',
  version: '1.0.0',
  modes: {
    dark: {
      ui: {
        bg: '#25190c', panel: '#2c2013', panel2: '#281c0f',
        hover: '#392c1f', active: '#483c2f',
        border: '#45392c', borderSoft: '#322619',
        ink: '#f5ebe1', muted: '#a69d94', subtle: '#80776f',
        brand: '#e19560', green: '#8abc84', amber: '#e7b84c', red: '#eb8376',
        chip: '#36291d', chipHover: '#493d30',
        termBg: '#1b0e02', termInput: '#211406',
        termRowHover: '#33271a', termRowActive: '#3f3326',
        termHead: '#60564c', termTrack: '#52473b',
        brandFill: '#b36019', brandFillHover: '#a45300',
        brandFillStrong: '#854200', onBrand: '#ffffff', dangerSolid: '#c12e27',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#b99af0', string: '#8abc84', number: '#e7b84c',
        comment: '#80776f', name: '#e19560', type: '#6dd2cb',
        operator: '#a69d94', constant: '#eb8376', invalid: '#f47c6e',
        activeLine: '#302315', selection: '#4f4336',
      },
      terminal: {
        bg: '#1b0e02', ink: '#eddcd1', dim: '#9f806c', black: '#1b0e02',
        green: '#a1df99', blue: '#eea26c', amber: '#f3c560', red: '#f4877a',
        cyan: '#7ce0da', magenta: '#eb95cf', selection: '#483c2f',
        surface: '#211406', surfaceAlt: '#392c1f',
      },
    },
    light: {
      ui: {
        bg: '#fdf7ec', panel: '#fffbf5', panel2: '#f9f3e8',
        hover: '#f6f0e5', active: '#ede7dd',
        border: '#d7d1c8', borderSoft: '#efe9df',
        ink: '#383530', muted: '#787570', subtle: '#95928c',
        brand: '#854200', green: '#30652b', amber: '#936e00', red: '#a32d26',
        chip: '#efe9df', chipHover: '#e5e0d6',
        termBg: '#faf3e6', termInput: '#fffbf5',
        termRowHover: '#f4eee4', termRowActive: '#eae4da',
        termHead: '#737069', termTrack: '#d6d1c9',
        brandFill: '#b36019', brandFillHover: '#a45300',
        brandFillStrong: '#854200', onBrand: '#ffffff', dangerSolid: '#c12e27',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#663b9e', string: '#295e24', number: '#856300',
        comment: '#95928c', name: '#854200', type: '#006c68',
        operator: '#787570', constant: '#9b251f', invalid: '#a9231e',
        activeLine: '#f6f0e5', selection: '#f4d1ba',
      },
      terminal: {
        bg: '#faf3e6', ink: '#383530', dim: '#70695e', black: '#383530',
        green: '#295e24', blue: '#854200', amber: '#856300', red: '#9b251f',
        cyan: '#006c68', magenta: '#8b2971', selection: '#f4d1ba',
        surface: '#fffbf5', surfaceAlt: '#efe9df',
      },
    },
  },
};

/** Achromatic chrome, one lime wire running through it. */
export const GRAPHITE_THEME: HiveTheme = {
  hiveThemeVersion: HIVE_THEME_VERSION,
  name: 'Graphite',
  author: 'Built in',
  version: '1.0.0',
  modes: {
    dark: {
      ui: {
        bg: '#181a1c', panel: '#1e2022', panel2: '#1a1c1e',
        hover: '#2b2d2f', active: '#3a3c3e',
        border: '#37393b', borderSoft: '#252729',
        ink: '#ebedef', muted: '#9d9ea0', subtle: '#78797a',
        brand: '#88dc6a', green: '#7dbe8b', amber: '#efb444', red: '#ee8078',
        chip: '#282a2c', chipHover: '#3b3d3f',
        termBg: '#0e1012', termInput: '#131517',
        termRowHover: '#252729', termRowActive: '#313335',
        termHead: '#545557', termTrack: '#454648',
        brandFill: '#77b960', brandFillHover: '#6aaa52',
        brandFillStrong: '#509436', onBrand: '#141414', dangerSolid: '#c5252c',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#ac9df9', string: '#7dbe8b', number: '#efb444',
        comment: '#78797a', name: '#88dc6a', type: '#65d2d2',
        operator: '#9d9ea0', constant: '#ee8078', invalid: '#f87871',
        activeLine: '#212426', selection: '#414345',
      },
      terminal: {
        bg: '#0e1012', ink: '#dee0de', dim: '#858984', black: '#0e1012',
        green: '#90e3a2', blue: '#8fc87b', amber: '#fbc25a', red: '#f7847d',
        cyan: '#75e1e0', magenta: '#e995d7', selection: '#3a3c3e',
        surface: '#131517', surfaceAlt: '#2b2d2f',
      },
    },
    light: {
      ui: {
        bg: '#f8fafd', panel: '#fdfeff', panel2: '#f4f6f9',
        hover: '#f1f3f5', active: '#e8eaec',
        border: '#d2d4d6', borderSoft: '#eaecef',
        ink: '#343536', muted: '#757677', subtle: '#919293',
        brand: '#3b7b1f', green: '#1b6733', amber: '#986b00', red: '#a6282a',
        chip: '#eaecef', chipHover: '#e1e3e5',
        termBg: '#f4f6f9', termInput: '#fdfeff',
        termRowHover: '#eff2f4', termRowActive: '#e6e8ea',
        termHead: '#6f7072', termTrack: '#d3d4d6',
        brandFill: '#77b960', brandFillHover: '#6aaa52',
        brandFillStrong: '#509436', onBrand: '#141414', dangerSolid: '#c5252c',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#593ea9', string: '#10602d', number: '#896100',
        comment: '#919293', name: '#3b7b1f', type: '#006c6c',
        operator: '#757677', constant: '#9d1e23', invalid: '#ac1a23',
        activeLine: '#f1f3f5', selection: '#c9e2c0',
      },
      terminal: {
        bg: '#f4f6f9', ink: '#343536', dim: '#686b6d', black: '#343536',
        green: '#10602d', blue: '#276700', amber: '#896100', red: '#9d1e23',
        cyan: '#006c6c', magenta: '#89277a', selection: '#c9e2c0',
        surface: '#fdfeff', surfaceAlt: '#eaecef',
      },
    },
  },
};

/** Deep harbour blue-green, with light coming off the water. */
export const TIDEWATER_THEME: HiveTheme = {
  hiveThemeVersion: HIVE_THEME_VERSION,
  name: 'Tidewater',
  author: 'Built in',
  version: '1.0.0',
  modes: {
    dark: {
      ui: {
        bg: '#051d23', panel: '#0d2429', panel2: '#072026',
        hover: '#1a3136', active: '#2a4045',
        border: '#273d42', borderSoft: '#142a30',
        ink: '#e0f0f4', muted: '#93a1a5', subtle: '#6e7c7f',
        brand: '#31becc', green: '#6bc0a1', amber: '#f5b053', red: '#eb817f',
        chip: '#172e33', chipHover: '#2b4147',
        termBg: '#001318', termInput: '#00191f',
        termRowHover: '#142b30', termRowActive: '#20373d',
        termHead: '#47595d', termTrack: '#374a4f',
        brandFill: '#00828d', brandFillHover: '#00747e',
        brandFillStrong: '#005d65', onBrand: '#ffffff', dangerSolid: '#c12c39',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#a4a0f8', string: '#6bc0a1', number: '#f5b053',
        comment: '#6e7c7f', name: '#31becc', type: '#6cd1d1',
        operator: '#93a1a5', constant: '#eb817f', invalid: '#f47a79',
        activeLine: '#0d272d', selection: '#31474d',
      },
      terminal: {
        bg: '#001318', ink: '#cde5e8', dim: '#629196', black: '#001318',
        green: '#79e4be', blue: '#44cbd9', amber: '#ffbe6a', red: '#f48684',
        cyan: '#7be0df', magenta: '#e398dc', selection: '#2a4045',
        surface: '#00191f', surfaceAlt: '#1a3136',
      },
    },
    light: {
      ui: {
        bg: '#eefcff', panel: '#f9feff', panel2: '#eaf8fb',
        hover: '#e7f5f7', active: '#dfecee',
        border: '#c9d6d8', borderSoft: '#e0eef1',
        ink: '#303738', muted: '#707779', subtle: '#8c9495',
        brand: '#00636b', green: '#00674d', amber: '#9f6700', red: '#a32c33',
        chip: '#e0eef1', chipHover: '#d8e5e7',
        termBg: '#e8f9fc', termInput: '#f9feff',
        termRowHover: '#e6f3f6', termRowActive: '#dceaec',
        termHead: '#697274', termTrack: '#cad6d8',
        brandFill: '#00828d', brandFillHover: '#00747e',
        brandFillStrong: '#005d65', onBrand: '#ffffff', dangerSolid: '#c12c39',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#5143a7', string: '#005f46', number: '#905c00',
        comment: '#8c9495', name: '#00636b', type: '#006c6c',
        operator: '#707779', constant: '#9a232c', invalid: '#a8212e',
        activeLine: '#e7f5f7', selection: '#b3e3e9',
      },
      terminal: {
        bg: '#e8f9fc', ink: '#303738', dim: '#5e6e70', black: '#303738',
        green: '#005f46', blue: '#00636b', amber: '#905c00', red: '#9a232c',
        cyan: '#006c6c', magenta: '#832d7f', selection: '#b3e3e9',
        surface: '#f9feff', surfaceAlt: '#e0eef1',
      },
    },
  },
};

/** Fired clay with a turquoise seam. */
export const TERRACOTTA_THEME: HiveTheme = {
  hiveThemeVersion: HIVE_THEME_VERSION,
  name: 'Terracotta',
  author: 'Built in',
  version: '1.0.0',
  modes: {
    dark: {
      ui: {
        bg: '#281613', panel: '#2f1d1a', panel2: '#2b1916',
        hover: '#3c2a26', active: '#4c3936',
        border: '#483632', borderSoft: '#362420',
        ink: '#f8e9e6', muted: '#a89b98', subtle: '#827673',
        brand: '#3fbfbb', green: '#85bc8c', amber: '#ffa86b', red: '#e8847d',
        chip: '#392723', chipHover: '#4d3b37',
        termBg: '#1f0b08', termInput: '#24110d',
        termRowHover: '#362421', termRowActive: '#43302c',
        termHead: '#635451', termTrack: '#554441',
        brandFill: '#008481', brandFillHover: '#007673',
        brandFillStrong: '#005e5c', onBrand: '#ffffff', dangerSolid: '#be3334',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#c397e5', string: '#85bc8c', number: '#ffa86b',
        comment: '#827673', name: '#3fbfbb', type: '#71d0d5',
        operator: '#a89b98', constant: '#e8847d', invalid: '#f17e76',
        activeLine: '#33201c', selection: '#53403d',
      },
      terminal: {
        bg: '#1f0b08', ink: '#cee5e4', dim: '#65918f', black: '#1f0b08',
        green: '#9ae0a4', blue: '#4fccc8', amber: '#ffbb8d', red: '#f18981',
        cyan: '#80dee3', magenta: '#ec96c7', selection: '#4c3936',
        surface: '#24110d', surfaceAlt: '#3c2a26',
      },
    },
    light: {
      ui: {
        bg: '#fff5f1', panel: '#fffaf8', panel2: '#ffefeb',
        hover: '#fbece8', active: '#f2e4e0',
        border: '#dbceca', borderSoft: '#f4e6e1',
        ink: '#3a3432', muted: '#7b7472', subtle: '#98908e',
        brand: '#006462', green: '#296535', amber: '#a95f25', red: '#a03130',
        chip: '#f4e6e1', chipHover: '#eaddd8',
        termBg: '#ffefea', termInput: '#fffaf8',
        termRowHover: '#faebe6', termRowActive: '#efe1dc',
        termHead: '#776e6b', termTrack: '#dacecb',
        brandFill: '#008481', brandFillHover: '#007673',
        brandFillStrong: '#005e5c', onBrand: '#ffffff', dangerSolid: '#be3334',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#6f3992', string: '#215e2e', number: '#985621',
        comment: '#98908e', name: '#006462', type: '#006b70',
        operator: '#7b7472', constant: '#982929', invalid: '#a5282a',
        activeLine: '#fbece8', selection: '#b6e4e1',
      },
      terminal: {
        bg: '#ffefea', ink: '#3a3432', dim: '#766661', black: '#3a3432',
        green: '#215e2e', blue: '#006462', amber: '#985621', red: '#982929',
        cyan: '#006b70', magenta: '#8c2b69', selection: '#b6e4e1',
        surface: '#fffaf8', surfaceAlt: '#f4e6e1',
      },
    },
  },
};

/** Nordic slate. Every colour pulled a third of the way to grey. */
export const PORCELAIN_THEME: HiveTheme = {
  hiveThemeVersion: HIVE_THEME_VERSION,
  name: 'Porcelain',
  author: 'Built in',
  version: '1.0.0',
  modes: {
    dark: {
      ui: {
        bg: '#182229', panel: '#1f2830', panel2: '#1b242c',
        hover: '#2c353d', active: '#3c454d',
        border: '#39424a', borderSoft: '#262f37',
        ink: '#e7eef4', muted: '#999fa5', subtle: '#747a7f',
        brand: '#83addc', green: '#8eb996', amber: '#e2b876', red: '#d98d8a',
        chip: '#29323a', chipHover: '#3d464e',
        termBg: '#0d1720', termInput: '#131d25',
        termRowHover: '#273038', termRowActive: '#323c44',
        termHead: '#575f65', termTrack: '#475057',
        brandFill: '#4a79ac', brandFillHover: '#3d6c9e',
        brandFillStrong: '#255689', onBrand: '#ffffff', dangerSolid: '#ad4849',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#ada2e1', string: '#8eb996', number: '#e2b876',
        comment: '#747a7f', name: '#83addc', type: '#88cccf',
        operator: '#999fa5', constant: '#d98d8a', invalid: '#e08986',
        activeLine: '#222c34', selection: '#434c54',
      },
      terminal: {
        bg: '#0d1720', ink: '#d8e1ea', dim: '#7a899b', black: '#0d1720',
        green: '#a6dcb0', blue: '#8fbaea', amber: '#eec585', red: '#e2928f',
        cyan: '#96dade', magenta: '#dca0ca', selection: '#3c454d',
        surface: '#131d25', surfaceAlt: '#2c353d',
      },
    },
    light: {
      ui: {
        bg: '#f5fbff', panel: '#fcfeff', panel2: '#f0f7fc',
        hover: '#edf3f8', active: '#e5ebef',
        border: '#cfd5d9', borderSoft: '#e6edf2',
        ink: '#333638', muted: '#737679', subtle: '#8f9395',
        brand: '#25588f', green: '#356240', amber: '#916d31', red: '#924040',
        chip: '#e6edf2', chipHover: '#dde3e8',
        termBg: '#eff7fd', termInput: '#fcfeff',
        termRowHover: '#ecf2f7', termRowActive: '#e2e8ed',
        termHead: '#6d7174', termTrack: '#cfd5d9',
        brandFill: '#4a79ac', brandFillHover: '#3d6c9e',
        brandFillStrong: '#255689', onBrand: '#ffffff', dangerSolid: '#ad4849',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#59498f', string: '#2e5b39', number: '#83632c',
        comment: '#8f9395', name: '#25588f', type: '#23696d',
        operator: '#737679', constant: '#8a393a', invalid: '#963c3d',
        activeLine: '#edf3f8', selection: '#c9dbf1',
      },
      terminal: {
        bg: '#eff7fd', ink: '#333638', dim: '#646b71', black: '#333638',
        green: '#2e5b39', blue: '#25588f', amber: '#83632c', red: '#8a393a',
        cyan: '#23696d', magenta: '#7d3b6c', selection: '#c9dbf1',
        surface: '#fcfeff', surfaceAlt: '#e6edf2',
      },
    },
  },
};

/** Warm ash and hot filament. */
export const CINDER_THEME: HiveTheme = {
  hiveThemeVersion: HIVE_THEME_VERSION,
  name: 'Cinder',
  author: 'Built in',
  version: '1.0.0',
  modes: {
    dark: {
      ui: {
        bg: '#22201b', panel: '#292722', panel2: '#25231e',
        hover: '#35342f', active: '#45443e',
        border: '#42413b', borderSoft: '#2f2e29',
        ink: '#eeede9', muted: '#9f9e9b', subtle: '#7a7975',
        brand: '#e283ce', green: '#96bb63', amber: '#ebb700', red: '#fc7278',
        chip: '#32312c', chipHover: '#464540',
        termBg: '#181610', termInput: '#1d1c16',
        termRowHover: '#302f29', termRowActive: '#3c3b35',
        termHead: '#5f5e59', termTrack: '#504e4a',
        brandFill: '#b349a0', brandFillHover: '#a43b92',
        brandFillStrong: '#8e1b7d', onBrand: '#ffffff', dangerSolid: '#cc0034',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#bc94ff', string: '#96bb63', number: '#ebb700',
        comment: '#7a7975', name: '#e283ce', type: '#3bd6da',
        operator: '#9f9e9b', constant: '#fc7278', invalid: '#ff7076',
        activeLine: '#2c2b25', selection: '#4c4b46',
      },
      terminal: {
        bg: '#181610', ink: '#e3dee2', dim: '#8e848b', black: '#181610',
        green: '#b0de6f', blue: '#ef8fdb', amber: '#fac418', red: '#ff7d80',
        cyan: '#50e5e9', magenta: '#f48bdf', selection: '#45443e',
        surface: '#1d1c16', surfaceAlt: '#35342f',
      },
    },
    light: {
      ui: {
        bg: '#fbf9f3', panel: '#fffdf7', panel2: '#f7f5ef',
        hover: '#f3f2ec', active: '#ebe9e4',
        border: '#d5d3ce', borderSoft: '#edebe6',
        ink: '#363533', muted: '#777673', subtle: '#93928f',
        brand: '#90147f', green: '#436200', amber: '#906f00', red: '#b1002c',
        chip: '#edebe6', chipHover: '#e3e2dd',
        termBg: '#f7f5ee', termInput: '#fffdf7',
        termRowHover: '#f2f0eb', termRowActive: '#e8e6e1',
        termHead: '#71706c', termTrack: '#d5d3cf',
        brandFill: '#b349a0', brandFillHover: '#a43b92',
        brandFillStrong: '#8e1b7d', onBrand: '#ffffff', dangerSolid: '#cc0034',
        onDanger: '#ffffff',
      },
      syntax: {
        keyword: '#6b29b3', string: '#3d5b00', number: '#826400',
        comment: '#93928f', name: '#90147f', type: '#006b6e',
        operator: '#777673', constant: '#a40028', invalid: '#b1002c',
        activeLine: '#f3f2ec', selection: '#f5caea',
      },
      terminal: {
        bg: '#f7f5ee', ink: '#363533', dim: '#6c6a64', black: '#363533',
        green: '#3d5b00', blue: '#90147f', amber: '#826400', red: '#a40028',
        cyan: '#006b6e', magenta: '#930181', selection: '#f5caea',
        surface: '#fffdf7', surfaceAlt: '#edebe6',
      },
    },
  },
};

/**
 * Every theme that ships in the bundle, keyed by the id the gallery and
 * `activeThemeId` use.
 *
 * The Hive is first because the gallery renders in insertion order and the
 * default belongs at the front. An id in here is reserved: `theme-gallery`
 * seeds its collision set from these keys, so importing a file called
 * "Graphite" lands as `graphite-2` rather than shadowing the built-in.
 */
export const BUILT_IN_THEMES: Readonly<Record<string, HiveTheme>> = {
  [BUILT_IN_THEME_ID]: BUILT_IN_THEME,
  honeycomb: HONEYCOMB_THEME,
  graphite: GRAPHITE_THEME,
  tidewater: TIDEWATER_THEME,
  terracotta: TERRACOTTA_THEME,
  porcelain: PORCELAIN_THEME,
  cinder: CINDER_THEME,
};

/**
 * Is this id one the library may not remove or overwrite?
 *
 * `Object.hasOwn`, never `in`: `'toString' in BUILT_IN_THEMES` is `true` on any
 * object literal, and the matching lookup returns
 * `Object.prototype.toString` — a function, so a `?? fallback` guarding it
 * never fires and the caller ends up reading `.modes` off it.
 */
export function isBuiltInThemeId(id: string): boolean {
  return Object.hasOwn(BUILT_IN_THEMES, id);
}

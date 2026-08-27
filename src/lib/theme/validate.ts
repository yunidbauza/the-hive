import { BUILT_IN_THEME } from '@lib/theme/built-in';
import {
  HIVE_THEME_VERSION,
  MAX_THEME_BYTES,
  SYNTAX_KEYS,
  TERMINAL_KEYS,
  TERMINAL_SURFACE_KEYS,
  THEME_MODES,
  UI_KEYS,
  type HiveTheme,
  type SyntaxColors,
  type TerminalColors,
  type ThemeModeColors,
  type ThemeModeName,
  type UiColors,
} from '@lib/theme/contract';

/**
 * The theme importer (HIVE-80).
 *
 * A theme file is untrusted input from disk. `importTheme` runs a fixed
 * sequence of checks — size, JSON syntax, format version, shape, colour
 * parsing, key inheritance, the terminal/ui background pact, contrast — and
 * every failure names the exact path in the file, never a schema.
 */

export interface ImportOk {
  ok: true;
  theme: HiveTheme;
  inherited: number;
  notes: string[];
}

export interface ImportFailed {
  ok: false;
  title: string;
  detail: string;
}

export type ImportResult = ImportOk | ImportFailed;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The two functional forms the Hive reads. Nothing else is a colour here. */
const FUNC = /^(rgb|oklch)\(([^()]*)\)$/i;
const SUPPORTED_FUNCTIONS = new Set(['rgb', 'oklch']);

/** Anything shaped like `name(…)`, whether or not the Hive reads it. */
const ANY_FUNCTION = /^([a-z][a-z0-9-]*)\(/i;

/** What an error message offers as the way out. */
const ACCEPTED_FORMS = '#rgb, #rrggbb, #rrggbbaa, rgb() or oklch()';

/** One channel or alpha value: a number, optionally a percentage. */
const COMPONENT = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?$/;

/**
 * The **contents** of `rgb()` / `oklch()`, not just its shape.
 *
 * Matching `rgb\(.*\)` alone let `rgb()`, `rgb(1,2)` and `oklch(nonsense)`
 * import cleanly and then land as a declaration the browser drops on the floor
 * — and, in the `terminal` group, as a colour xterm falls back on. The spec
 * promises an unparseable colour is fatal, so the three channels are counted
 * and each one read.
 *
 * ## The two separator styles are not interchangeable
 *
 * CSS accepts a **legacy** comma form and a **modern** space form, and they are
 * different grammars rather than two spellings of one. Splitting on `[\s,]+`
 * erased the difference, so `oklch(0.5, 0.1, 200)` — which has no comma form at
 * all — and `rgb(1 2, 3)` both passed; counting "three channels, or four when
 * there is no slash" additionally admitted `rgb(1 2 3 4)` and
 * `oklch(0.5 0.1 200 0.4)`, neither of which any browser parses. So:
 *
 * - **legacy**: `rgb()` only, commas throughout, no `/`, three channels or four
 *   with the fourth carrying alpha;
 * - **modern**: either function, spaces throughout, exactly three channels, and
 *   alpha only after a `/`.
 *
 * Still deliberately not a full CSS colour parser: `none`, `var()` and
 * calculated values are out of scope, as are range checks, which belong to the
 * renderer. These are the cases this check *claims* to reject.
 */
function isColourFunction(value: string): boolean {
  const match = FUNC.exec(value);
  if (!match) return false;

  const fn = match[1].toLowerCase();
  const body = match[2].trim();
  if (body === '') return false;

  if (body.includes(',')) {
    // Legacy. `oklch()` never had one, and no legacy form takes a slash.
    if (fn !== 'rgb' || body.includes('/')) return false;
    const parts = body.split(',').map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) return false;
    return parts.every((part) => COMPONENT.test(part));
  }

  // Modern: three space-separated channels, alpha only behind a slash.
  const [channels, alpha, ...extra] = body.split('/');
  if (extra.length > 0) return false;
  if (alpha !== undefined && !COMPONENT.test(alpha.trim())) return false;

  const parts = channels.trim().split(/\s+/).filter((part) => part !== '');
  if (parts.length !== 3) return false;
  return parts.every((part) => COMPONENT.test(part));
}

function isColour(value: unknown): value is string {
  return typeof value === 'string' && (HEX.test(value) || isColourFunction(value));
}

/**
 * Why a colour was refused, in terms the person who wrote the file can act on.
 *
 * The accepted set — hex, `rgb()`, `oklch()` — is a deliberate spec decision
 * and this does **not** widen it. But a theme ported from VS Code routinely
 * carries `rgba()`, and telling its author that `rgba(0,0,0,0.3)` "is not a
 * colour the Hive can read" reads as *the Hive cannot parse that*, which sends
 * them hunting for a typo that is not there. A recognised-but-unsupported
 * family is named as such, and the forms that would work are listed.
 */
function colourComplaint(value: unknown): string {
  if (typeof value === 'string') {
    const family = ANY_FUNCTION.exec(value.trim())?.[1].toLowerCase();
    if (family !== undefined && !SUPPORTED_FUNCTIONS.has(family)) {
      return `uses ${family}(), which the Hive does not read. Use ${ACCEPTED_FORMS}.`;
    }
  }
  return 'is not a colour the Hive can read.';
}

const MODE_NAMES = THEME_MODES;

/**
 * `keys` are required; `optional` are read when present and never demanded.
 *
 * The distinction arrived with HIVE-82's surface colours. They cannot be
 * required — every theme exported before that ticket has exactly the eleven
 * terminal keys, and demanding a twelfth would reject all of them — and they
 * must not be *unknown* either, or importing a file this app exported would
 * warn about two colours and silently drop them. `surfacesOf` in `ansi.ts`
 * derives them from `bg` when they are absent, so omitting them costs a theme
 * nothing but the chance to choose.
 */
const GROUPS = [
  { name: 'ui', keys: UI_KEYS, optional: [] as readonly string[] },
  { name: 'syntax', keys: SYNTAX_KEYS, optional: [] as readonly string[] },
  {
    name: 'terminal',
    keys: TERMINAL_KEYS,
    optional: TERMINAL_SURFACE_KEYS as readonly string[],
  },
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The two keys naming the same colour: the ground xterm paints and the ground
 * the DOM paints around it. Rule 8 owns both — see the comment there.
 */
function isTerminalGround(group: string, key: string): boolean {
  return (group === 'terminal' && key === 'bg') || (group === 'ui' && key === 'termBg');
}

function fail(fileName: string, detail: string): ImportFailed {
  return { ok: false, title: `Couldn't import ${fileName}`, detail };
}

/** sRGB channel (0-255) -> linear-light value, per WCAG. */
function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexToRgb(hex: string): [number, number, number] | null {
  if (!HEX.test(hex)) return null;
  const body = hex.slice(1);
  let r: number;
  let g: number;
  let b: number;
  if (body.length === 3) {
    r = parseInt(body[0] + body[0], 16);
    g = parseInt(body[1] + body[1], 16);
    b = parseInt(body[2] + body[2], 16);
  } else {
    r = parseInt(body.slice(0, 2), 16);
    g = parseInt(body.slice(2, 4), 16);
    b = parseInt(body.slice(4, 6), 16);
  }
  return [r, g, b];
}

function relativeLuminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/**
 * WCAG contrast ratio between two colours. Only hex forms are measurable —
 * `rgb()`/`oklch()` functional colours return `null` and are skipped rather
 * than guessed at.
 */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The cap is in **bytes**, and `String.length` counts UTF-16 code units.
 *
 * The two are the same number only for ASCII. Every character from U+0080 up
 * costs two to four UTF-8 bytes per one or two code units, so a file of CJK
 * theme names measured by `.length` could be four times the cap and still pass
 * — and on the browser target nothing else is checking, since it is main's
 * `stat()` that gates the desktop import. Encoding is exact.
 *
 * UTF-8 never spends *fewer* bytes than there are code units, so a string
 * already over the cap in units is over it in bytes too: that short-circuit is
 * what keeps the encoder from being handed an arbitrarily large string just to
 * be told what the length already proved.
 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function exceedsByteCap(raw: string): boolean {
  return raw.length > MAX_THEME_BYTES || utf8ByteLength(raw) > MAX_THEME_BYTES;
}

/**
 * How many unknown keys get a note of their own before the rest are summed up.
 *
 * A hostile file can carry thousands, and every one of them used to become its
 * own sentence in a string the banner renders as a single joined paragraph.
 * Ten names is enough to see the pattern; the count of the remainder is the
 * only other fact worth having.
 */
const MAX_UNKNOWN_KEY_NOTES = 10;

export function importTheme(raw: string, fileName: string): ImportResult {
  // Rule 1: size, before parsing.
  if (exceedsByteCap(raw)) {
    return fail(fileName, 'The file is larger than the 256 KB limit.');
  }

  // Rule 2: JSON syntax.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(fileName, `The file is not valid JSON: ${message}`);
  }

  if (!isPlainObject(parsed)) {
    return fail(fileName, 'The file must contain a JSON object.');
  }

  // Rule 3: version gate — fails alone, before any other complaint.
  if (parsed.hiveThemeVersion !== 1) {
    return fail(
      fileName,
      `hiveThemeVersion is ${JSON.stringify(parsed.hiveThemeVersion)}, but the Hive only reads version 1 theme files. Export a compatible theme, or wait for a newer Hive.`,
    );
  }

  // Rule 4: both modes present and objects.
  const rawModes = isPlainObject(parsed.modes) ? parsed.modes : {};
  for (const mode of MODE_NAMES) {
    if (!isPlainObject(rawModes[mode])) {
      return fail(
        fileName,
        `modes.${mode} is missing. A Hive theme needs both a light and a dark mode — add a \`${mode}\` block, or start from the downloaded template.`,
      );
    }
  }

  const notes: string[] = [];
  let inherited = 0;
  let unknownKeys = 0;
  let namedUnknownKeys = 0;
  const modes = {} as Record<ThemeModeName, ThemeModeColors>;

  for (const mode of MODE_NAMES) {
    const rawMode = rawModes[mode] as Record<string, unknown>;
    const builtInMode = BUILT_IN_THEME.modes[mode];

    // What the *file* said about the two ends of the terminal ground, read
    // before anything is merged. Rule 8 branches on which of them the file
    // supplied, not on what the built theme ends up holding — by the time it
    // runs, it is the thing that put a value in either one.
    const rawTerminalGroup = isPlainObject(rawMode.terminal) ? rawMode.terminal : {};
    const rawUiGroup = isPlainObject(rawMode.ui) ? rawMode.ui : {};
    const fileHadTerminalBg = 'bg' in rawTerminalGroup;
    const fileHadUiTermBg = 'termBg' in rawUiGroup;

    const builtGroups: Partial<Record<'ui' | 'syntax' | 'terminal', unknown>> = {};

    for (const group of GROUPS) {
      const rawGroupValue: unknown = rawMode[group.name];
      const rawGroup: Record<string, unknown> = isPlainObject(rawGroupValue)
        ? rawGroupValue
        : {};
      const knownKeys = new Set<string>([...group.keys, ...group.optional]);
      const merged: Record<string, string> = {};

      // Rule 5: parse every known key present in the file — optional ones
      // included, which is the only place they differ from required keys.
      for (const key of [...group.keys, ...group.optional]) {
        if (key in rawGroup) {
          const value = rawGroup[key];
          if (!isColour(value)) {
            return fail(
              fileName,
              `modes.${mode}.${group.name}.${key} ${colourComplaint(value)}`,
            );
          }
          merged[key] = value;
        }
      }

      // Rule 6: unknown keys — noted (up to a cap), never copied.
      for (const key of Object.keys(rawGroup)) {
        if (!knownKeys.has(key)) {
          unknownKeys += 1;
          if (namedUnknownKeys < MAX_UNKNOWN_KEY_NOTES) {
            namedUnknownKeys += 1;
            notes.push(
              `modes.${mode}.${group.name}.${key} is not a recognised colour and was ignored.`,
            );
          }
        }
      }

      // Rule 7: inherit missing known keys from the built-in. The two ends of
      // the terminal ground — `terminal.bg` and `ui.termBg` — are excluded
      // here, because rule 8 owns them *jointly*: either may be derived from
      // the other, so filling one in from the built-in first would both count
      // it twice and leave a file that supplied only the other end holding a
      // mismatched pair.
      const builtInGroup = builtInMode[group.name] as Record<string, string>;
      for (const key of group.keys) {
        if (isTerminalGround(group.name, key)) continue;
        if (!(key in merged)) {
          merged[key] = builtInGroup[key];
          inherited += 1;
        }
      }

      builtGroups[group.name] = merged;
    }

    const ui = builtGroups.ui as UiColors;
    const syntax = builtGroups.syntax as SyntaxColors;
    const terminal = builtGroups.terminal as TerminalColors;

    /**
     * Rule 8: the `terminal.bg` / `ui.termBg` pact, in all four permutations.
     *
     * xterm paints its own background and the DOM paints the padding around
     * it, so the two have to be the same colour or a rectangle appears at the
     * terminal's edge. The derivation therefore runs in **both** directions:
     * whichever end the file supplies alone, the other is taken from it.
     *
     * The permutation this used to miss was "file supplies `terminal.bg`,
     * omits `ui.termBg`": rule 7 inherited `ui.termBg` from the built-in while
     * `terminal.bg` kept the file's value, and the pair landed mismatched
     * behind nothing louder than a "1 colour inherited" note — precisely the
     * seam this rule exists to prevent.
     */
    if (fileHadTerminalBg && fileHadUiTermBg) {
      if (terminal.bg !== ui.termBg) {
        return fail(
          fileName,
          `modes.${mode}.terminal.bg is ${terminal.bg} but modes.${mode}.ui.termBg is ${ui.termBg}. xterm paints its own background and the surrounding chrome paints the other — if they disagree, a visible seam appears at the terminal's edge. Make them match, or drop either one and the Hive will derive it from the one you keep.`,
        );
      }
    } else if (fileHadTerminalBg) {
      ui.termBg = terminal.bg;
      inherited += 1;
    } else if (fileHadUiTermBg) {
      terminal.bg = ui.termBg;
      inherited += 1;
    } else {
      const ground = builtInMode.ui.termBg;
      ui.termBg = ground;
      terminal.bg = ground;
      inherited += 2;
    }

    modes[mode] = { ui, syntax, terminal };
  }

  if (unknownKeys > namedUnknownKeys) {
    const remaining = unknownKeys - namedUnknownKeys;
    notes.push(
      `${remaining} further unrecognised ${remaining === 1 ? 'key was' : 'keys were'} ignored.`,
    );
  }

  // Rule 7b: name the inheritance rule 7 (and rule 8) counted, as the first
  // note — before the unknown-key notes already collected above and before
  // rule 9's contrast notes below — so a partial theme never lands in the
  // green "clean import" state it did not earn, and so the joined detail
  // reads in the mock's own order: inheritance, then unknown keys, then
  // contrast.
  if (inherited > 0) {
    const noun = inherited === 1 ? 'colour' : 'colours';
    notes.unshift(`${inherited} ${noun} inherited from the built-in theme`);
  }

  // Rule 9: contrast — always a note, never fatal.
  for (const mode of MODE_NAMES) {
    const { ui } = modes[mode];
    checkContrast(notes, mode, 'ink', ui.ink, 'panel', ui.panel, 4.5);
    checkContrast(notes, mode, 'ink', ui.ink, 'bg', ui.bg, 4.5);
    checkContrast(notes, mode, 'muted', ui.muted, 'panel', ui.panel, 3);
    /**
     * `brand` is body text now, so it is held to the body-text threshold.
     *
     * It was always a *text* token — `--cc-brand-fill` is the one that paints
     * shapes — but until the hierarchy pass it appeared only as accents and
     * short labels, and nothing checked it. It now names every project in the
     * rail and every provider in Integrations, on `panel` in both cases, which
     * is a paragraph's worth of reading rather than a highlight.
     *
     * All seven built-ins clear it comfortably — 5.15:1 at worst (Graphite
     * light), 9.72:1 at best — so this cannot fire on the app's own themes, and
     * unlike the `onBrand`/`brandFill` pair below there is nothing to move
     * first. An imported theme is the case it exists for: nothing stops one
     * shipping a brand that vanishes into its own panel, and before this the
     * format had no way to say so.
     */
    checkContrast(notes, mode, 'brand', ui.brand, 'panel', ui.panel, 4.5);
    /**
     * And on `panel-2`, because brand text has two grounds, not one.
     *
     * The rail is `bg-panel`; the settings dialog is `bg-panel-2`, and the
     * provider eyebrow is painted there. Checking only `panel` would certify a
     * theme whose brand is legible in the rail and not in Settings — which is
     * exactly the shape of the miss this whole rule exists to close, one
     * surface further along. `ink` is already checked against two grounds for
     * the same reason.
     *
     * Every built-in clears it; the worst is 4.80:1 (Graphite light).
     */
    checkContrast(notes, mode, 'brand', ui.brand, 'panel2', ui.panel2, 4.5);
    /**
     * Text on a *fill*, which nothing checked until a theme got it wrong.
     *
     * Every other rule here checks text against a **surface**. A fill and the
     * text on it are a pair too, and the gap is what let Graphite ship: its
     * brand is a light lime, so its `onBrand` is correctly a near-black — and
     * the badge, which reused `onBrand` over `dangerSolid`, rendered black on
     * crimson at 3.22:1.
     *
     * **`onBrand` on `brandFill` is deliberately not checked yet.** It should
     * be, and the check is one line; it is left out because the *built-in*
     * theme fails it at 4.2:1, so turning it on would make the app's own
     * default theme emit a warning on every import. Fixing that means moving
     * `--cc-brand-fill`, which repaints every primary button in the app — a
     * design decision rather than a bug fix, and not this change's to make.
     * Adding the check with a loosened threshold would be worse than leaving
     * it out, because it would record 4.2:1 as acceptable.
     */
    checkContrast(
      notes,
      mode,
      'onDanger',
      ui.onDanger,
      'dangerSolid',
      ui.dangerSolid,
      4.5,
    );
  }

  const theme: HiveTheme = {
    hiveThemeVersion: 1,
    name: typeof parsed.name === 'string' ? parsed.name : 'Untitled theme',
    author: typeof parsed.author === 'string' ? parsed.author : 'Unknown',
    version: typeof parsed.version === 'string' ? parsed.version : '1.0.0',
    modes,
  };

  return { ok: true, theme, inherited, notes };
}

/**
 * Is this a complete, readable {@link HiveTheme}?
 *
 * `importTheme` is the gate a theme passes on its way *in*, and for the length
 * of one session that is enough. It is not enough on the way back **out** of
 * `localStorage`, which is a store the user, another tab, a devtools session or
 * a half-finished write can all reach — and where a theme that is valid JSON of
 * the wrong shape gets past `JSON.parse` untouched. A rehydrated
 * `{ hiveThemeVersion: 1, name: 'Nord' }` used to reach `applyThemeColors`
 * (which threw inside `onRehydrateStorage`, where zustand swallows it) and then
 * the terminal palette selector, which crashed the centre stage on **every**
 * render — with the bad entry still in storage, so every restart crashed the
 * same way. There was no way out from inside the app.
 *
 * So this is the same question `importTheme` asks, minus the inheritance and
 * the advice: every mode, every group, every key, each one a colour this app
 * can actually paint. Anything else is not a theme and is dropped.
 */
export function isHiveTheme(value: unknown): value is HiveTheme {
  if (!isPlainObject(value)) return false;
  if (value.hiveThemeVersion !== HIVE_THEME_VERSION) return false;
  if (typeof value.name !== 'string') return false;
  if (typeof value.author !== 'string') return false;
  if (typeof value.version !== 'string') return false;
  if (!isPlainObject(value.modes)) return false;

  for (const mode of MODE_NAMES) {
    const modeValue = value.modes[mode];
    if (!isPlainObject(modeValue)) return false;
    for (const group of GROUPS) {
      const groupValue = modeValue[group.name];
      if (!isPlainObject(groupValue)) return false;
      for (const key of group.keys) {
        if (!isColour(groupValue[key])) return false;
      }
    }
  }

  return true;
}

function checkContrast(
  notes: string[],
  mode: ThemeModeName,
  fgName: string,
  fg: string,
  bgName: string,
  bg: string,
  threshold: number,
): void {
  const ratio = contrastRatio(fg, bg);
  if (ratio === null || ratio >= threshold) return;
  notes.push(
    `modes.${mode}: ${fgName} on ${bgName} is only ${ratio.toFixed(1)}:1 — below the ${threshold}:1 the Hive aims for.`,
  );
}

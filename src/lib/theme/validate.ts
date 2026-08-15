import { BUILT_IN_THEME } from '@lib/theme/built-in';
import {
  MAX_THEME_BYTES,
  SYNTAX_KEYS,
  TERMINAL_KEYS,
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
const FUNC = /^(?:rgb|oklch)\([^()]*\)$/i;

function isColour(value: unknown): value is string {
  return typeof value === 'string' && (HEX.test(value) || FUNC.test(value));
}

const MODE_NAMES = ['dark', 'light'] as const satisfies readonly ThemeModeName[];

const GROUPS = [
  { name: 'ui', keys: UI_KEYS },
  { name: 'syntax', keys: SYNTAX_KEYS },
  { name: 'terminal', keys: TERMINAL_KEYS },
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function importTheme(raw: string, fileName: string): ImportResult {
  // Rule 1: size, before parsing.
  if (raw.length > MAX_THEME_BYTES) {
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
  const modes = {} as Record<ThemeModeName, ThemeModeColors>;

  for (const mode of MODE_NAMES) {
    const rawMode = rawModes[mode] as Record<string, unknown>;
    const builtInMode = BUILT_IN_THEME.modes[mode];

    // File-supplied terminal.bg / ui.termBg, tracked before merge — rule 8
    // needs to know what the *file* contained, which the merged result
    // can no longer answer once inheritance has run.
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
      const knownKeys = new Set<string>(group.keys);
      const merged: Record<string, string> = {};

      // Rule 5: parse every known key present in the file.
      for (const key of group.keys) {
        if (key in rawGroup) {
          const value = rawGroup[key];
          if (!isColour(value)) {
            return fail(
              fileName,
              `modes.${mode}.${group.name}.${key} is not a colour the Hive can read.`,
            );
          }
          merged[key] = value;
        }
      }

      // Rule 6: unknown keys — noted, never copied.
      for (const key of Object.keys(rawGroup)) {
        if (!knownKeys.has(key)) {
          notes.push(
            `modes.${mode}.${group.name}.${key} is not a recognised colour and was ignored.`,
          );
        }
      }

      // Rule 7: inherit missing known keys from the built-in.
      const builtInGroup = builtInMode[group.name] as Record<string, string>;
      for (const key of group.keys) {
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

    // Rule 8: terminal.bg / ui.termBg pact.
    if (!fileHadTerminalBg) {
      terminal.bg = ui.termBg;
      inherited += 1;
    } else if (fileHadUiTermBg && terminal.bg !== ui.termBg) {
      return fail(
        fileName,
        `modes.${mode}.terminal.bg is ${terminal.bg} but modes.${mode}.ui.termBg is ${ui.termBg}. xterm paints its own background and the surrounding chrome paints the other — if they disagree, a visible seam appears at the terminal's edge. Make them match, or drop one and let the Hive derive it.`,
      );
    }

    modes[mode] = { ui, syntax, terminal };
  }

  // Rule 9: contrast — always a note, never fatal.
  for (const mode of MODE_NAMES) {
    const { ui } = modes[mode];
    checkContrast(notes, mode, 'ink', ui.ink, 'panel', ui.panel, 4.5);
    checkContrast(notes, mode, 'ink', ui.ink, 'bg', ui.bg, 4.5);
    checkContrast(notes, mode, 'muted', ui.muted, 'panel', ui.panel, 3);
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

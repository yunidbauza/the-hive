/**
 * File paths in terminal output.
 *
 * The pure half of terminal file links: what in a line *looks like* a path,
 * and where its `:line:col` suffix ends. Whether any of it is a file on disk
 * is main's question (`electron/main/fs/resolve.ts`), and this module is
 * deliberately generous because of that split — a false positive costs one
 * `null` in a round trip that was already being made, while a false negative
 * is a path the user can see and cannot click.
 *
 * No `@xterm` import, and none of `features/`, `data/` or `stores/`:
 * `components/terminal/**` may import neither, and putting the whole decision
 * here is what makes it testable against a table of real compiler output
 * instead of against a rendered terminal.
 */

import type { ResolvedLink } from '@shared/fs-contract';

/** A path-shaped run in one line. `start` is 0-based, `end` exclusive. */
export interface FileLinkCandidate {
  text: string;
  start: number;
  end: number;
}

/**
 * One path segment: may begin with a dot, never ends with one.
 *
 * Both halves are load-bearing. A leading dot is how `~/.claude/settings.json`
 * and every other hidden directory is spelled; refusing a trailing one is what
 * keeps `see src/a.ts.` from yielding a path with the sentence's full stop
 * stuck to it, which main would then refuse and the user would see as a dead
 * spot on a path that is plainly there.
 */
const SEGMENT = String.raw`\.?[\w@+-]+(?:\.[\w@+-]+)*`;

/** `~/`, `./`, `../` or a leading `/`. Anything else starts mid-segment. */
const PREFIX = String.raw`(?:~\/|\.{1,2}\/|\/)?`;

/** `:12`, `:12:7`, or tsc's `(12,7)`. */
const POSITION = String.raw`(?:\(\d+,\d+\)|:\d+(?::\d+)?)?`;

/**
 * Either a path with a separator in it (`src/lib`, and also `and/or`, which
 * main will refuse) or a bare filename carrying an extension
 * (`package.json`). A word with neither matches nothing, which is what keeps
 * `Test Files 1 failed` dark.
 */
const CANDIDATE = new RegExp(
  [
    `${PREFIX}(?:${SEGMENT}\\/)+${SEGMENT}${POSITION}`,
    `${PREFIX}[\\w@+-]+(?:\\.[\\w@+-]+)+${POSITION}`,
  ].join('|'),
  'gu',
);

/**
 * A URL, so its path can be left alone.
 *
 * Whole spans rather than a look-behind on each candidate, because the
 * candidate does not begin where the URL's path begins: `PREFIX` happily eats
 * the second slash of `//`, so the run found inside `https://claude.ai/x` is
 * `/claude.ai/x` and the text before it ends in a single `:/` that reads like
 * no scheme at all. Comparing spans asks the question that is actually being
 * asked — does this run lie inside a URL — instead of a question about the one
 * character in front of it.
 *
 * The answer matters because a URL's path is already clickable: the web-links
 * addon opens it in the browser. Offering it as a file as well would give one
 * span on screen two different meanings and two different outcomes.
 */
const URL_SPAN = /[a-z][a-z0-9+.-]*:\/\/\S*/giu;

export function findCandidates(line: string): FileLinkCandidate[] {
  const urls = [...line.matchAll(URL_SPAN)].map((match) => {
    const start = match.index ?? 0;
    return { start, end: start + match[0].length };
  });

  const found: FileLinkCandidate[] = [];

  for (const match of line.matchAll(CANDIDATE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;

    if (urls.some((url) => start < url.end && end > url.start)) continue;
    /*
      A backslash in front means a Windows separator or a shell escape. Neither
      is a path this app can open — and without this, the `a.ts` ending
      `C:\Users\x\a.ts` would be offered on its own, as a relative path in the
      session's own directory, which is a different file entirely.
    */
    if (line.slice(0, start).endsWith('\\')) continue;

    found.push({ text: match[0], start, end });
  }

  return found;
}

/**
 * `a.ts:12:7`, and tsc's `a.ts(12,7)`, into a path and a 1-based position.
 *
 * A zero is dropped rather than kept or clamped: `:0` is what a tool prints
 * when it has no position to report, and turning that into line 1 would put
 * the caret somewhere the output never claimed.
 */
export function splitPosition(text: string): {
  path: string;
  line?: number;
  col?: number;
} {
  const paren = /^(.*)\((\d+),(\d+)\)$/u.exec(text);
  const colon = paren ? null : /^(.*?):(\d+)(?::(\d+))?$/u.exec(text);
  const hit = paren ?? colon;
  if (!hit) return { path: text };

  const path = hit[1] ?? text;
  const line = Number(hit[2]);
  if (line < 1) return { path };

  const col = hit[3] === undefined ? undefined : Number(hit[3]);
  return { path, line, ...(col !== undefined && col >= 1 ? { col } : {}) };
}

/**
 * An OSC 8 `file://` hyperlink as a candidate for the same resolver, or `null`.
 *
 * Only a local file is a candidate — an empty host or `localhost`. A
 * UNC-style host names another machine, and no root here can contain it, so it
 * is dropped rather than guessed at. The fragment goes too: nothing this app
 * prints puts a position there, and `#L12` is a GitHub convention rather than
 * a filesystem one.
 */
export function fileUrlToCandidate(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }

  if (url.protocol !== 'file:') return null;
  if (url.hostname !== '' && url.hostname !== 'localhost') return null;
  // `new URL('file:')` parses, with `/` for a pathname. The filesystem root
  // names no file, so it is refused here rather than sent on a round trip.
  if (url.pathname === '' || url.pathname === '/') return null;

  try {
    return decodeURIComponent(url.pathname);
  } catch {
    // A malformed percent-escape. Not a path, and not worth a guess.
    return null;
  }
}

/** xterm's `IBufferRange`: 1-based columns and rows, `end` inclusive. */
export interface LinkRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/** What `open` receives. `line` and `col` are 1-based when present. */
export interface FileLinkTarget extends ResolvedLink {
  line?: number;
  col?: number;
}

/** The shape of xterm's `ILink`, minus the decorations this never sets. */
export interface FileLink {
  range: LinkRange;
  text: string;
  activate(event: MouseEvent, text: string): void;
  hover?(event: MouseEvent, text: string): void;
  leave?(event: MouseEvent, text: string): void;
}

/**
 * A row as xterm holds it: the text, and where each character is **drawn**.
 *
 * The two are not the same, which is the whole reason this type exists.
 * `translateToString` returns a double-width character — CJK, most emoji, some
 * box-drawing glyphs — as *one* JS character, while xterm draws it in *two*
 * columns. So after the first one on a line, every string index undercounts
 * the real column, and a range built from string offsets drifts left of the
 * path it is meant to underline: a link the user can see and cannot click,
 * with nothing on screen to explain why. Claude Code's own output is full of
 * such characters, so this is the ordinary case rather than an exotic one.
 *
 * The widths come from xterm's own cells rather than from a table in this
 * module. A second definition of "how wide is this character" is a second
 * thing that can disagree with what was actually painted — and the painter is
 * the one that gets to be right.
 */
export interface TerminalLine {
  text: string;
  /**
   * `columns[i]` is the 0-based column that `text[i]` is drawn at, with one
   * extra entry at `text.length` for the column just past the last character.
   * For an all-narrow line this is simply `[0, 1, 2, …]`.
   */
  columns: number[];
}

/** The shape of xterm's `ILinkProvider`. */
export interface FileLinkProvider {
  provideLinks(y: number, callback: (links: FileLink[] | undefined) => void): void;
}

export interface FileLinkProviderOptions {
  /** Row `y` (1-based, as xterm passes it), or `undefined` past the end. */
  readLine: (y: number) => TerminalLine | undefined;
  /** Bare paths in, index-aligned verdicts out. A rejection reads as all-`null`. */
  resolve: (paths: string[]) => Promise<Array<ResolvedLink | null>>;
  open: (target: FileLinkTarget) => void;
  /** Whether this click carries the platform's open modifier. */
  isModified: (event: MouseEvent) => boolean;
  /**
   * The event rides along because the pointer is the only thing that knows
   * where the link is on screen: the WebGL renderer paints the row into a
   * canvas and exposes no public cell metrics, so a tooltip cannot be placed
   * from the range alone.
   */
  hover?: (text: string, event: MouseEvent) => void;
  leave?: () => void;
}

/**
 * Lines whose verdicts are kept.
 *
 * Far below the 5k scrollback on purpose: this exists so that reading back
 * over output already hovered does not re-ask, not so that the whole buffer is
 * held in memory.
 */
export const MEMO_LINES = 256;

/**
 * The xterm link provider for file paths.
 *
 * Typed structurally rather than against `ILinkProvider`, which keeps this
 * module free of an `@xterm` import; the surface hands it to
 * `registerLinkProvider`, where the real type is checked.
 *
 * **The modifier is the whole difference from a URL.** A URL in terminal
 * output is opened by a plain click, which is what this app already decided
 * and what iTerm2 does. A path cannot be: the text under a path is text the
 * user selects and copies constantly, and a plain click that opened a file
 * would take the click-drag that starts on one. So `activate` does nothing
 * without the modifier and xterm's own selection runs, exactly as VS Code
 * behaves.
 */
/**
 * The 1-based column that the character at `index` *ends* on, inclusive —
 * which is the far edge of its cell, two columns along when that cell is wide.
 *
 * Found by scanning for the next character drawn further right rather than by
 * reading `columns[index + 1]`, because a single cell can hold more than one
 * JS character: a combining accent, or an emoji built from several code units.
 * Those share a column, and `columns[index + 1]` would then report the cell's
 * own start and place the range's end before its start.
 */
function endColumn(columns: number[], index: number): number {
  const at = columns[index] ?? index;
  for (let i = index + 1; i < columns.length; i += 1) {
    const next = columns[i] ?? at;
    if (next > at) return next;
  }
  return Math.max(columns.at(-1) ?? at + 1, at + 1);
}

export function createFileLinkProvider(
  options: FileLinkProviderOptions,
): FileLinkProvider {
  /**
   * Verdicts by **line text**, not by row.
   *
   * Rows move: the same output is at a different `y` after one scroll, and a
   * row-keyed memo would miss on every one of them. The text is what was
   * actually asked about.
   */
  const memo = new Map<string, Promise<Array<ResolvedLink | null>>>();

  const verdictsFor = (
    line: string,
    paths: string[],
  ): Promise<Array<ResolvedLink | null>> => {
    const kept = memo.get(line);
    if (kept) return kept;

    // The rejection is absorbed here rather than at the call site so the memo
    // never holds a promise that rejects on its second reader.
    const pending = options.resolve(paths).catch(() => paths.map(() => null));
    memo.set(line, pending);

    if (memo.size > MEMO_LINES) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    return pending;
  };

  return {
    provideLinks(y, callback) {
      const line = options.readLine(y);
      const candidates = line === undefined ? [] : findCandidates(line.text);
      if (line === undefined || candidates.length === 0) {
        callback(undefined);
        return;
      }

      const positions = candidates.map((candidate) => splitPosition(candidate.text));

      void verdictsFor(
        line.text,
        positions.map((position) => position.path),
      ).then((verdicts) => {
        const links = candidates.flatMap((candidate, index): FileLink[] => {
          const hit = verdicts[index];
          const position = positions[index];
          if (!hit || !position) return [];

          const target: FileLinkTarget = {
            ...hit,
            ...(position.line === undefined ? {} : { line: position.line }),
            ...(position.col === undefined ? {} : { col: position.col }),
          };

          return [
            {
              /*
                Columns, not string offsets. xterm counts from 1 and includes
                `end`; `candidate` is 0-based over the *string* and excludes it.
                On an all-narrow line `columns[i] === i` and this reduces to the
                old `start + 1` / `end` — it is a generalisation, not a change
                of convention.
              */
              range: {
                start: { x: (line.columns[candidate.start] ?? candidate.start) + 1, y },
                end: { x: endColumn(line.columns, candidate.end - 1), y },
              },
              text: candidate.text,
              activate: (event) => {
                if (options.isModified(event)) options.open(target);
              },
              hover: (event) => options.hover?.(candidate.text, event),
              leave: () => options.leave?.(),
            },
          ];
        });

        callback(links.length === 0 ? undefined : links);
      });
    },
  };
}

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BINARY_SNIFF_BYTES,
  HIDDEN_ENTRIES,
  MAX_FILE_BYTES,
  MAX_LINE_CHARS,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_FILES,
  MAX_SEARCH_LINES_PER_FILE,
  MAX_SEARCH_MATCHES,
  MIN_QUERY_CHARS,
  SEARCH_BUDGET_MS,
  type FsResult,
  type SearchHit,
  type SearchLine,
  type SearchRequest,
  type SearchResults,
} from '@shared/fs-contract';

import { asFailure, resolveExisting } from './paths';

/**
 * The first thing in this layer that recurses.
 *
 * ## Why it is here and not in the renderer
 *
 * `fs-contract.ts` makes the argument in full: the tree is lazy, so a
 * client-side filter can only see the folders someone already opened, and would
 * answer "no matches" for a file one collapsed directory away. The walk has to
 * happen on the side that owns containment.
 *
 * ## Every bound is a floor, not a target
 *
 * Nothing here recursed before, so there was no depth, no result cap and no
 * timeout to inherit — all of them are invented in `fs-contract.ts` and all of
 * them are enforced here. The walk stops at the *first* bound it reaches and
 * says so; {@link SearchResults.capped} is what the panel renders as "500+".
 *
 * A search that hits a cap has already found more than a 316px rail can show,
 * so the caps are not a compromise on completeness — they are the point at
 * which more results stop being information.
 *
 * ## Case, and why the query is never a regex
 *
 * Matched case-insensitively as a literal. A regex would be a second syntax to
 * teach in a box with no room to explain it, and — unlike the editor's ⌘F,
 * where the document is bounded and already in memory — a pathological pattern
 * here runs against every file in the project. `toLowerCase()` on both sides is
 * the whole of it.
 */

/** Wall-clock deadline for one search, so a huge tree degrades rather than hangs. */
interface Budget {
  deadline: number;
  spent: () => boolean;
}

const budget = (now: () => number): Budget => {
  const deadline = now() + SEARCH_BUDGET_MS;
  return { deadline, spent: () => now() >= deadline };
};

/**
 * The line a hit sits on, trimmed and clipped.
 *
 * Leading whitespace goes because a rail 316px wide cannot spend twenty columns
 * on indentation, and the clip is what stops a minified bundle — one line,
 * megabytes long — from being returned whole. `column` is recomputed against
 * the string actually returned, so it still points at the match after both.
 */
function describeLine(raw: string, at: number, query: string): SearchLine | null {
  const leading = raw.length - raw.trimStart().length;
  const trimmed = raw.slice(leading);
  const column = at - leading;

  // The match itself must survive the clip, or the row shows a line with no
  // visible reason for being there.
  const start = column > MAX_LINE_CHARS - query.length ? column : 0;
  const text = trimmed.slice(start, start + MAX_LINE_CHARS);
  const shifted = column - start;
  if (shifted < 0) return null;

  return { line: 0, text, column: shifted };
}

/** Whether a file's first bytes contain a NUL — `read.ts`'s heuristic, reused. */
async function looksBinary(absolute: string, size: number): Promise<boolean> {
  const handle = await open(absolute, 'r');
  try {
    const length = Math.min(size, BINARY_SNIFF_BYTES);
    if (length === 0) return false;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/**
 * Read one file and collect its matching lines.
 *
 * Reuses the editor's own refusals rather than inventing softer ones: a file
 * too large to open is a file too large to grep, and a binary that would render
 * as replacement characters would match as them too. Skipped silently, because
 * a refusal is not an error and a search is not the place to explain one.
 */
async function scanFile(
  absolute: string,
  needle: string,
): Promise<{ lines: SearchLine[]; total: number } | null> {
  let size: number;
  try {
    size = (await stat(absolute)).size;
  } catch {
    return null;
  }
  if (size === 0 || size > MAX_FILE_BYTES) return null;

  try {
    if (await looksBinary(absolute, size)) return null;
  } catch {
    return null;
  }

  let text: string;
  try {
    const handle = await open(absolute, 'r');
    try {
      text = (await handle.readFile()).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  const lines: SearchLine[] = [];
  let total = 0;
  const rows = text.split('\n');

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? '';
    const at = row.toLowerCase().indexOf(needle);
    if (at === -1) continue;

    total += 1;
    if (lines.length >= MAX_SEARCH_LINES_PER_FILE) continue;

    const described = describeLine(row, at, needle);
    if (described !== null) lines.push({ ...described, line: index + 1 });
  }

  return total === 0 ? null : { lines, total };
}

/**
 * Search a project for a query, by filename or by content.
 *
 * Answers `FsResult` rather than throwing, like every other verb here: the
 * panel has to render either way, and a tree that throws because one directory
 * is unreadable tells the user the app is broken when the truth is narrower.
 *
 * `now` is injectable so the budget is testable without a real clock.
 */
export async function searchProject(
  request: SearchRequest,
  now: () => number = Date.now,
): Promise<FsResult<SearchResults>> {
  const query = request.query.trim();
  const empty: SearchResults = { hits: [], files: 0, matches: 0, capped: false };
  // Not an error: an empty box is a question nobody asked, and one letter is a
  // walk of the whole project to return most of it.
  if (query.length < MIN_QUERY_CHARS) return { ok: true, value: empty };

  const needle = query.toLowerCase();
  const clock = budget(now);

  let root: string;
  try {
    ({ absolute: root } = await resolveExisting(
      request.projectId,
      '',
      request.sessionId,
    ));
  } catch (cause) {
    return { ok: false, error: asFailure(cause) };
  }

  const hits: SearchHit[] = [];
  let files = 0;
  let matches = 0;
  let capped = false;

  const walk = async (absolute: string, relative: string, depth: number): Promise<void> => {
    if (capped) return;
    if (depth > MAX_SEARCH_DEPTH || clock.spent()) {
      capped = true;
      return;
    }

    let names: string[];
    try {
      names = await readdir(absolute);
    } catch {
      // One unreadable directory is not a failed search. The rest of the tree
      // is still an answer, and a permission error here is ordinary.
      return;
    }

    // Filtered before `stat`, exactly as `readDirectory` does and for the same
    // reason: the point of hiding `node_modules` is never to pay for it.
    for (const name of names.filter((entry) => !HIDDEN_ENTRIES.includes(entry))) {
      if (capped) return;
      if (clock.spent()) {
        capped = true;
        return;
      }

      const childAbsolute = join(absolute, name);
      const childRelative = relative === '' ? name : `${relative}/${name}`;

      let isDirectory: boolean;
      try {
        isDirectory = (await stat(childAbsolute)).isDirectory();
      } catch {
        continue;
      }

      if (isDirectory) {
        await walk(childAbsolute, childRelative, depth + 1);
        continue;
      }

      if (request.mode === 'name') {
        if (!name.toLowerCase().includes(needle)) continue;
        files += 1;
        matches += 1;
        if (hits.length < MAX_SEARCH_FILES) {
          hits.push({ relPath: childRelative, name, lines: [], total: 1 });
        } else {
          capped = true;
          return;
        }
        continue;
      }

      const found = await scanFile(childAbsolute, needle);
      if (found === null) continue;

      files += 1;
      matches += found.total;
      hits.push({
        relPath: childRelative,
        name,
        lines: found.lines,
        total: found.total,
      });

      if (hits.length >= MAX_SEARCH_FILES || matches >= MAX_SEARCH_MATCHES) {
        capped = true;
        return;
      }
    }
  };

  try {
    await walk(root, '', 0);
  } catch (cause) {
    return { ok: false, error: asFailure(cause) };
  }

  return { ok: true, value: { hits, files, matches, capped } };
}

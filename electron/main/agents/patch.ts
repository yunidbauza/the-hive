/**
 * Writing one frontmatter value back into the file (HIVE-114).
 *
 * The Settings form and the Source tab edit **one buffer** — the file — so a
 * form edit has to land the way a person editing text would land it: change
 * the value, touch nothing else.
 *
 * Re-serialising the block from a parsed model would be far less code and
 * would destroy every `#` comment and any key order the author chose. The
 * ticket's own example file is full of both, and a settings pane that quietly
 * reformats a file the user is invited to hand-edit has broken the promise
 * that it is *their* file.
 *
 * So: find the line the dotted path already occupies and replace only its
 * value token, or insert a line when the key is absent.
 */
import { readFrontmatter } from './definition';

const FENCE = '---';
const VALUE = /^(\s*[a-z0-9_-]+:[ \t]*)(.*)$/;

/** The smallest gap that still reads as a comment rather than a value. */
const MIN_GAP = 2;

/**
 * Replace the value on one line, preserving its `key:` run and re-aligning any
 * trailing comment so the `#` stays in its original column. A longer value
 * that shoved its comment rightward would ripple an aligned block out of true
 * on every single edit.
 */
function replaceValue(line: string, value: string): string {
  const match = VALUE.exec(line);

  if (match === null) return line;

  const head = match[1] as string;
  const rest = match[2] as string;
  const at = rest.search(/\s{2,}#/);

  if (at === -1) return `${head}${value}`;

  const gap = /^\s+/.exec(rest.slice(at))?.[0].length ?? MIN_GAP;
  const comment = rest.slice(at + gap);
  const width = Math.max(MIN_GAP, gap - (value.length - at));

  return `${head}${value}${' '.repeat(width)}${comment}`;
}

export function patchFrontmatter(
  source: string,
  path: string,
  value: string,
): string {
  const read = readFrontmatter(source);

  if (read === null) return source;

  const lines = source.split('\n');
  const existing = read.fields.get(path);

  if (existing !== undefined) {
    lines[existing.line] = replaceValue(lines[existing.line] as string, value);

    return lines.join('\n');
  }

  const dot = path.indexOf('.');
  const parent = dot === -1 ? null : path.slice(0, dot);
  const leaf = dot === -1 ? path : path.slice(dot + 1);
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === FENCE);

  if (parent === null) {
    lines.splice(close, 0, `${leaf}: ${value}`);

    return lines.join('\n');
  }

  // The block may already be open, in which case the new key joins it —
  // otherwise `wake:` would appear twice and the reader would see one block.
  const opens = lines.findIndex(
    (line, i) => i > 0 && i < close && line.trim() === `${parent}:`,
  );

  if (opens === -1) {
    lines.splice(close, 0, `${parent}:`, `  ${leaf}: ${value}`);

    return lines.join('\n');
  }

  let after = opens + 1;

  while (after < close && /^\s+\S/.test(lines[after] as string)) after += 1;

  lines.splice(after, 0, `  ${leaf}: ${value}`);

  return lines.join('\n');
}

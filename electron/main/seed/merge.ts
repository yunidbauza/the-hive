import { createHash } from 'node:crypto';

/**
 * Merging a shipped `AGENT.md` or `SKILL.md` into the user's copy, one part
 * at a time.
 *
 * The seed's first rule (HIVE-162) was per file: any edit made the whole file
 * the user's, so one `parallel: 5` froze an agent's prompt for good and it
 * never learned `lane: thread`. The file is split instead into **parts**:
 * each top-level frontmatter key, each child of a flat block (`limits:` with
 * one-line children becomes `limits.turns`, `limits.parallel`), any deeper
 * block whole (`hooks:`), and the body. Each part is merged three ways, from
 * the hash of what the seed last shipped (the base), the file on disk, and
 * what ships now.
 *
 * Node-only apart from `node:crypto`, and with no path aliases, so
 * `scripts/shipped-history.ts` runs this same parser under plain Node.
 */

const FENCE = '---';
const TOP_KEY = /^([A-Za-z_][\w-]*):(.*)$/;
const CHILD_KEY = /^ {2}[\w-]+:(?: .*)?$/;

export interface Parsed {
  /** Part path to its text, in file order. */
  parts: Map<string, string>;
  /** The block keys split into `key.child` parts. */
  blocks: Set<string>;
  /** Frontmatter lines before the first key: a comment the user wrote. */
  preamble: string[];
  body: string;
}

/** A part's hash: sha256 of its text with trailing whitespace ignored, 16 hex. */
export function hashPart(text: string): string {
  const normal = text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();

  return createHash('sha256').update(normal).digest('hex').slice(0, 16);
}

/** The file split into parts and a body, or `null` without a closed fence. */
export function parseParts(text: string): Parsed | null {
  const lines = text.split('\n');

  if (lines[0]?.trim() !== FENCE) return null;

  const close = lines.findIndex((line, i) => i > 0 && line.trim() === FENCE);

  if (close === -1) return null;

  const preamble: string[] = [];
  const units: { key: string; head: string; lines: string[] }[] = [];

  for (const line of lines.slice(1, close)) {
    const match = TOP_KEY.exec(line);

    if (match !== null) {
      units.push({ key: match[1] as string, head: (match[2] as string).trim(), lines: [line] });
    } else if (units.length === 0) {
      preamble.push(line);
    } else {
      (units.at(-1) as { lines: string[] }).lines.push(line);
    }
  }

  const parts = new Map<string, string>();
  const blocks = new Set<string>();

  for (const unit of units) {
    // A blank line after a key is spacing, not part of its value.
    while (unit.lines.length > 1 && (unit.lines.at(-1) as string).trim() === '') {
      unit.lines.pop();
    }

    const children = unit.lines.slice(1);
    const flat =
      unit.head === '' &&
      children.length > 0 &&
      children.every((line) => CHILD_KEY.test(line));

    if (!flat) {
      parts.set(unit.key, unit.lines.join('\n'));
      continue;
    }

    blocks.add(unit.key);
    for (const child of children) {
      const name = (child.trim().split(':')[0] as string).trim();

      parts.set(`${unit.key}.${name}`, child);
    }
  }

  return { parts, blocks, preamble, body: lines.slice(close + 1).join('\n') };
}

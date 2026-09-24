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
  const lines = text.replace(/\r\n/g, '\n').split('\n');

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
  const seen = new Map<string, number>();

  for (const unit of units) seen.set(unit.key, (seen.get(unit.key) ?? 0) + 1);

  for (const unit of units) {
    // A blank line after a key is spacing, not part of its value.
    while (unit.lines.length > 1 && (unit.lines.at(-1) as string).trim() === '') {
      unit.lines.pop();
    }

    /*
      A key written twice (an old patcher opened a second `wake:`) is one
      part: every occurrence, whole, in the order it appears. Splitting either
      copy would let the merge drop the other.
    */
    if ((seen.get(unit.key) ?? 0) > 1) {
      const whole = parts.get(unit.key);

      parts.set(unit.key, whole === undefined ? unit.lines.join('\n') : `${whole}\n${unit.lines.join('\n')}`);
      continue;
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

/** What the seed recorded about a file it shipped: a hash per part, one for the body. */
export interface PartBase {
  keys: Record<string, string>;
  body: string;
}

/** A part the user holds at a value other than the shipped one. */
export interface CustomisedPart {
  path: string;
  yours: string;
  /** `null` when the app does not ship this key. */
  shipped: string | null;
}

export interface MergeResult {
  /** What the file should hold. */
  text: string;
  /** What the manifest should record for it. */
  base: PartBase;
  customised: CustomisedPart[];
  /** Customised parts whose shipped value moved since the base, or that have none. */
  moved: string[];
  /** Shipped parts the user deleted. They stay deleted. */
  deleted: string[];
  bodyEdited: boolean;
  /** The body is the user's and a newer shipped one is waiting. */
  held: boolean;
}

/** The base a file has when the seed writes exactly `text`. */
export function baseOf(text: string): PartBase {
  const parsed = parseParts(text);
  const keys: Record<string, string> = {};

  for (const [path, part] of parsed?.parts ?? []) keys[path] = hashPart(part);

  return { keys, body: hashPart(parsed?.body ?? text) };
}

/** `record[key]` for an own key only, so a key named `constructor` reads as absent. */
export const ownKey = (record: Record<string, string> | undefined, key: string): string | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

/** A part's value without its key, for a person to read. */
const valueOf = (part: string): string => part.trim().replace(/^[\w-]+:/, '').trim();

/**
 * Fold a split block back into one part, where the other side wrote the same
 * key as a single value (`limits: { turns: 5 }`). Otherwise the merge would
 * emit both shapes of one key.
 */
function collapse(parsed: Parsed, key: string): void {
  if (!parsed.blocks.has(key)) return;

  const prefix = `${key}.`;
  const parts = new Map<string, string>();
  const children: string[] = [];

  for (const [path, part] of parsed.parts) {
    if (!path.startsWith(prefix)) {
      parts.set(path, part);
      continue;
    }
    if (children.length === 0) parts.set(key, '');
    children.push(part);
  }
  parts.set(key, [`${key}:`, ...children].join('\n'));
  parsed.parts = parts;
  parsed.blocks.delete(key);
}

const parentOf = (path: string, blocks: Set<string>): string | null => {
  const dot = path.indexOf('.');

  if (dot === -1) return null;

  const parent = path.slice(0, dot);

  return blocks.has(parent) ? parent : null;
};

/**
 * Merge the shipped file into the user's, part by part.
 *
 * | Part | Base | Result |
 * | --- | --- | --- |
 * | same on both sides | | kept, base moves to shipped |
 * | user's equals base | | takes the shipped value (or is dropped) |
 * | shipped equals base | | the user's, customised |
 * | both moved, or no base | | the user's, customised and **moved**; base kept |
 * | absent on disk, in base | | stays deleted |
 * | absent on disk, not in base | | a new shipped key: arrives |
 *
 * The body follows the same table, with *held* for "both moved". A flagged
 * part keeps its old base in the result, so the next seed flags it again
 * until the user resolves it; `keepMine` resolves it by moving the base.
 *
 * `current` and `shipped` must both parse; the caller checks.
 */
export function mergeParts(
  current: string,
  shipped: string,
  base: PartBase | null,
): MergeResult {
  const mine = parseParts(current) as Parsed;
  const ship = parseParts(shipped) as Parsed;

  for (const key of ship.blocks) if (mine.parts.has(key)) collapse(ship, key);
  for (const key of mine.blocks) if (ship.parts.has(key)) collapse(mine, key);

  const keys: Record<string, string> = {};
  const customised: CustomisedPart[] = [];
  const moved: string[] = [];
  const deleted: string[] = [];
  const out: { path: string; text: string }[] = [];

  for (const [path, s] of ship.parts) {
    const c = mine.parts.get(path);
    const b = ownKey(base?.keys, path);
    const hs = hashPart(s);

    if (c === undefined) {
      if (b !== undefined) {
        deleted.push(path);
        keys[path] = b;
      } else {
        out.push({ path, text: s });
        keys[path] = hs;
      }
      continue;
    }

    const hc = hashPart(c);

    if (hc === hs || b === hc) {
      out.push({ path, text: hc === hs ? c : s });
      keys[path] = hs;
      continue;
    }

    out.push({ path, text: c });
    customised.push({ path, yours: valueOf(c), shipped: valueOf(s) });
    if (b === hs) {
      keys[path] = hs;
    } else {
      moved.push(path);
      if (b !== undefined) keys[path] = b;
    }
  }

  for (const [path, c] of mine.parts) {
    if (ship.parts.has(path)) continue;

    const b = ownKey(base?.keys, path);

    // Shipped once, untouched since, and the app no longer ships it.
    if (b === hashPart(c)) continue;

    customised.push({ path, yours: valueOf(c), shipped: null });
    if (b !== undefined) {
      moved.push(path);
      keys[path] = b;
    }

    const parent = parentOf(path, mine.blocks);
    const after =
      parent === null
        ? -1
        : out.findLastIndex((entry) => entry.path.startsWith(`${parent}.`));

    if (after === -1) out.push({ path, text: c });
    else out.splice(after + 1, 0, { path, text: c });
  }

  const hb = base?.body;
  const hcBody = hashPart(mine.body);
  const hsBody = hashPart(ship.body);
  const untouched = hcBody === hsBody || hb === hcBody;
  const bodyEdited = !untouched;
  const held = bodyEdited && hb !== hsBody;

  const blocks = new Set([...ship.blocks, ...mine.blocks]);
  const lines: string[] = [];
  let open: string | null = null;

  for (const entry of out) {
    const parent = parentOf(entry.path, blocks);

    if (parent !== null && parent !== open) lines.push(`${parent}:`);
    open = parent;
    lines.push(entry.text);
  }

  const preamble = mine.preamble.length > 0 ? mine.preamble : ship.preamble;
  const body = untouched && hcBody !== hsBody ? ship.body : mine.body;

  return {
    text: `${[FENCE, ...preamble, ...lines, FENCE].join('\n')}\n${body}`,
    base: { keys, body: held ? (hb ?? '') : hsBody },
    customised,
    moved,
    deleted,
    bodyEdited,
    held,
  };
}

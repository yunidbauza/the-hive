/**
 * The AGENT.md contract (HIVE-114).
 *
 * Types, constants and one declarative field table — no Node, no DOM, no
 * runtime dependency, like every other file here.
 *
 * ## Why the field table exists
 *
 * Three of this story's requirements look separate and are not: an unknown key
 * must be *rejected*, a problem must name the *field* it belongs to, and the
 * Settings form must render exactly the fields that exist. Written three
 * times, those become three things to keep in step. Written once, as
 * {@link AGENT_FIELDS}, they collapse: "unknown key" is *no entry matched*, a
 * problem's `field` is a table path so it can never name a control the form
 * does not render, and the surgical patcher addresses lines by that same path.
 *
 * The renderer imports this at runtime, which is established house style
 * rather than a leak — `hive-store.ts` imports `@shared/ledger-derive` and
 * `env-editor.tsx` imports `unsafeEnvReason` the same way.
 */
import { OVERMIND } from './ledger-contract';
import {
  SESSION_EFFORTS,
  SESSION_MODELS,
  type SessionEffort,
  type SessionModel,
} from './session-contract';
import { RESERVED_SKILL_NAME, SKILL_NAME_PATTERN } from './skills-contract';

/** Folder under `~/.hive` holding one directory per agent. */
export const AGENTS_DIR = 'agents';

/** The definition file inside each agent's folder. */
export const AGENT_FILE = 'AGENT.md';

/**
 * Identical to a skill's rule, and deliberately the *same constant*: an agent
 * may not take a skill's name, so the two share a namespace, and two patterns
 * that could drift apart would be a bug rather than a convenience.
 */
export const AGENT_NAME_PATTERN = SKILL_NAME_PATTERN;

/**
 * Names an agent may not take.
 *
 * Derived, not spelled. `OVERMIND` is the ledger's coordinator identity and
 * `done` is the app-owned skill; writing either string here would leave a
 * second copy to keep in step with the file that actually owns it.
 */
export const RESERVED_AGENT_NAMES = [OVERMIND, RESERVED_SKILL_NAME] as const;

/**
 * Integrations an agent's `mcp:` list may name.
 *
 * One entry, because one integration is planned. Whether Slack is *connected*
 * is a wake-time question, not a validation one — a definition naming a
 * signed-out Slack is well-formed, it just will not run. HIVE-123 replaces
 * this with the real registry.
 */
export const KNOWN_AGENT_MCP = ['slack'] as const;

export const WAKE_EVERY_FLOOR_MS = 60_000;
export const WAKE_EVERY_DEFAULT_MS = 300_000;

export const AGENT_LIMIT_DEFAULTS = {
  turns: 40,
  budgetUsd: 0.5,
  rotateAfter: 50,
} as const;

export const AUTONOMIES = ['ask', 'act'] as const;
export type Autonomy = (typeof AUTONOMIES)[number];

/**
 * `working` deliberately collides with `SessionStatus`: an agent mid-run and a
 * session mid-turn mean the same thing to a reader, and `DotStatus` unions the
 * two, so the overlap costs nothing and saves a synonym.
 */
export const AGENT_STATUSES = [
  'sleeping',
  'working',
  'asking',
  'paused',
  'failed',
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export type WakeOn = 'ledger' | 'slack.mention' | `slack.channel:${string}`;

export interface WakeSpec {
  /** Absent means *not scheduled* — the agent wakes on an event or by hand. */
  everyMs?: number;
  on: WakeOn[];
  /** Local `HH:MM`. No scheduled wakes inside the window; events still wake. */
  quiet?: { from: string; to: string };
}

export interface AgentDefinition {
  name: string;
  description: string;
  icon: string;
  model?: SessionModel;
  effort?: SessionEffort;
  wake: WakeSpec;
  skills: string[];
  mcp: string[];
  tools: string[];
  autonomy: Autonomy;
  limits: { turns: number; budgetUsd: number; rotateAfter: number };
  body: string;
}

export interface AgentSummary {
  name: string;
  description: string;
  icon: string;
  status: AgentStatus;
  wake: WakeSpec;
  lastRunAt?: number;
  nextRunAt?: number;
  /** Why this definition could not be parsed. Listed, never hidden. */
  invalid?: string;
}

export interface AgentProblem {
  /** An {@link AGENT_FIELDS} path, or `''` for a whole-file problem. */
  field: string;
  reason: string;
}

export interface AgentWriteRequest {
  name: string;
  /** The whole file text — the form and the body edit one buffer. */
  source: string;
}

/** `agents:read` and `agents:remove` — one agent, and never a path. */
export interface AgentNameRequest {
  name: string;
}

/** `agents:rename` — two names, and still no path between them. */
export interface AgentRenameRequest {
  from: string;
  to: string;
  /**
   * The buffer being saved, when the caller has one.
   *
   * Carried so the move validates the text about to be written rather than the
   * stale file on disk — without it, fixing a broken definition *and* renaming
   * it in one edit was refused with problems the user had already resolved.
   */
  source?: string;
}

export type AgentWriteResult =
  | { ok: true }
  | { ok: false; problems: AgentProblem[] };

export interface AgentsSnapshot {
  agents: AgentSummary[];
  agentsRoot: string;
}

export type FieldKind =
  | 'text'
  | 'enum'
  | 'duration'
  | 'list'
  | 'time-range'
  | 'number';

export interface FieldSpec {
  /** Dotted path: `wake.every`. One level of nesting, by design. */
  path: string;
  kind: FieldKind;
  required: boolean;
  /** Allowed values, for `enum`. */
  values?: readonly string[];
}

/**
 * Every legal key. A line whose key is not here is a problem naming it — which
 * is why rejecting unknown keys needs no second key-set to maintain.
 */
export const AGENT_FIELDS: readonly FieldSpec[] = [
  { path: 'name', kind: 'text', required: true },
  { path: 'description', kind: 'text', required: true },
  { path: 'icon', kind: 'text', required: true },
  { path: 'model', kind: 'enum', required: false, values: SESSION_MODELS },
  { path: 'effort', kind: 'enum', required: false, values: SESSION_EFFORTS },
  { path: 'wake.every', kind: 'duration', required: false },
  { path: 'wake.on', kind: 'list', required: false },
  { path: 'wake.quiet', kind: 'time-range', required: false },
  { path: 'skills', kind: 'list', required: false },
  { path: 'mcp', kind: 'list', required: false },
  { path: 'tools', kind: 'list', required: false },
  { path: 'autonomy', kind: 'enum', required: false, values: AUTONOMIES },
  { path: 'limits.turns', kind: 'number', required: false },
  { path: 'limits.budget_usd', kind: 'number', required: false },
  { path: 'limits.rotate_after', kind: 'number', required: false },
];

/**
 * The keys the grammar allows to open a nested block, derived from the table
 * so a new nested field cannot forget to register its parent.
 */
export const AGENT_PARENT_KEYS: readonly string[] = [
  ...new Set(
    AGENT_FIELDS.filter((field) => field.path.includes('.')).map(
      (field) => field.path.split('.')[0] as string,
    ),
  ),
];

// ---------------------------------------------------------------------------
// The reader.
//
// Pure, dependency-free, and living here rather than in `electron/main/agents/`
// because the **renderer** needs it too: the Settings form reads the buffer it
// is editing, and `src/**` may not import `electron/main/**`. One reader is
// what stops the pane and main disagreeing about what a file says — which,
// given the comment rule below, would be very easy to do and very hard to see.
// ---------------------------------------------------------------------------

export interface RawField {
  value: string;
  /** 0-based index into the source's lines — the patcher addresses by this. */
  line: number;
}

const FENCE = '---';
const KEY = /^(\s*)([a-z0-9_-]+):\s*(.*)$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Strip a trailing comment.
 *
 * **Two or more spaces before `#` begin a comment; one space does not.**
 *
 * Not a flourish. The three readings of `#` in the ticket's own example file
 * demand exactly this rule, and the obvious "space-hash starts a comment"
 * would silently truncate the first of them:
 *
 * - `description: Watches #incorp-dev …` — one space, part of the value
 * - `icon: ChatCircleDots        # a Phosphor name` — aligned, a comment
 * - `on: [… slack.channel:#incorp-dev]` — no space, part of the value
 */
function stripComment(line: string): string {
  const at = line.search(/\s{2,}#/);

  return at === -1 ? line : line.slice(0, at);
}

export function readFrontmatter(
  source: string,
): { fields: Map<string, RawField>; body: string } | null {
  const lines = source.split('\n');

  if (lines[0]?.trim() !== FENCE) return null;

  const close = lines.findIndex((line, i) => i > 0 && line.trim() === FENCE);

  if (close === -1) return null;

  const fields = new Map<string, RawField>();
  let parent: string | null = null;

  for (let i = 1; i < close; i += 1) {
    const raw = lines[i] as string;

    if (raw.trim() === '' || /^\s*#/.test(raw)) continue;

    const match = KEY.exec(stripComment(raw));

    if (match === null) continue;

    const indent = match[1] as string;
    const key = match[2] as string;
    const value = (match[3] as string).trim();

    if (indent.length === 0) {
      // A bare `wake:` opens a block; anything else is a leaf, and closes one.
      parent = value === '' && AGENT_PARENT_KEYS.includes(key) ? key : null;

      if (parent === null) fields.set(key, { value, line: i });
      continue;
    }

    fields.set(parent === null ? key : `${parent}.${key}`, { value, line: i });
  }

  return { fields, body: lines.slice(close + 1).join('\n') };
}

/** `5m` / `2h` / `daily` → milliseconds. `null` when it is none of those. */
export function parseDuration(text: string): number | null {
  if (text === 'daily') return 86_400_000;

  const match = /^(\d+)([mh])$/.exec(text);

  if (match === null) return null;

  const size = Number(match[1]);

  return match[2] === 'h' ? size * 3_600_000 : size * 60_000;
}

export function parseList(text: string): string[] | null {
  if (!text.startsWith('[') || !text.endsWith(']')) return null;

  const inner = text.slice(1, -1).trim();

  return inner === '' ? [] : inner.split(',').map((part) => part.trim());
}

export function parseRange(
  text: string,
): { from: string; to: string } | null {
  const parts = text.split('-');

  if (parts.length !== 2) return null;

  const from = parts[0] as string;
  const to = parts[1] as string;

  return TIME.test(from) && TIME.test(to) ? { from, to } : null;
}

// ---------------------------------------------------------------------------
// The writer.
//
// Here for the same reason the reader is: the Settings form patches the buffer
// it is editing, and `src/**` cannot import `electron/main/**`. Pure string
// work, no Node.
// ---------------------------------------------------------------------------

/**
 * A key line, split into its `key:`, the run of space after it, and the rest.
 *
 * The gap is captured **separately** from the tail rather than folded into the
 * head. Folding it in reads `model:        # pick one later` as a head of
 * `model:` + eight spaces and a tail that begins at `#` — with no run of two
 * spaces left inside the tail for the comment search to find, so the comment
 * looked like a value and was overwritten. An empty value with an aligned
 * comment is exactly the shape the pane's own template produces.
 */
const VALUE = /^(\s*[a-z0-9_-]+:)(\s*)(.*)$/;

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
  const gap = match[2] as string;
  const tail = match[3] as string;

  // An empty value whose line still carries a comment: the whole gap sat
  // between the colon and the `#`, so the tail *is* the comment.
  if (tail.startsWith('#') && gap.length >= MIN_GAP) {
    const width = Math.max(MIN_GAP, gap.length - 1 - value.length);

    return `${head} ${value}${' '.repeat(width)}${tail}`;
  }

  const at = tail.search(/\s{2,}#/);

  if (at === -1) return `${head}${gap}${value}`;

  const pad = /^\s+/.exec(tail.slice(at))?.[0].length ?? MIN_GAP;
  const comment = tail.slice(at + pad);
  const width = Math.max(MIN_GAP, pad - (value.length - at));

  return `${head}${gap}${value}${' '.repeat(width)}${comment}`;
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
  /*
    Through `stripComment`, matching how `readFrontmatter` recognised this same
    line. Comparing the raw text instead meant a parent carrying a comment —
    `wake:   # when to run` — was read as an open block but not found here, so
    the patcher spliced a *second* `wake:` before the closing fence. The reader
    still parsed the result (later keys win), so the corruption was silent.
  */
  const opens = lines.findIndex(
    (line, i) => i > 0 && i < close && stripComment(line).trim() === `${parent}:`,
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

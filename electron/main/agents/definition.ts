/**
 * Reading an AGENT.md (HIVE-114).
 *
 * Pure and Node-free, so it runs under plain Vitest exactly as
 * `skills/read.ts` does. The skill and integration lists arrive as *arguments*
 * rather than being read here: `readUserSkills` is async and root-dependent,
 * and a parser that reaches the disk stops being testable as a function.
 *
 * This is a new reader rather than an extension of `skills/read.ts`'s
 * `frontmatter()`. That function sits on the session-spawn path and its
 * flatness is a feature there — nesting and lists are not its business.
 */
import {
  AGENT_FIELDS,
  AGENT_LIMIT_DEFAULTS,
  AGENT_NAME_PATTERN,
  AGENT_PARENT_KEYS,
  RESERVED_AGENT_NAMES,
  WAKE_EVERY_FLOOR_MS,
  type AgentDefinition,
  type AgentProblem,
  type Autonomy,
  type FieldSpec,
  type WakeOn,
} from '@shared/agent-contract';
import type {
  SessionEffort,
  SessionModel,
} from '@shared/session-contract';

export interface RawField {
  value: string;
  /** 0-based index into the source's lines — the patcher addresses by this. */
  line: number;
}

export interface ParseContext {
  folder: string;
  skillNames: readonly string[];
  integrations: readonly string[];
}

export type ParseResult =
  | { def: AgentDefinition }
  | { problems: AgentProblem[] };

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

/** Shape-check one field against its spec. Cross-field rules come after. */
function checkKind(spec: FieldSpec, raw: string): string | null {
  switch (spec.kind) {
    case 'text':
      return raw === '' ? 'Required.' : null;
    case 'enum':
      return spec.values?.includes(raw) === true
        ? null
        : `Must be one of: ${(spec.values ?? []).join(', ')}.`;
    case 'duration':
      return parseDuration(raw) === null
        ? 'Must be a number of minutes (5m), hours (2h), or daily.'
        : null;
    case 'list':
      return parseList(raw) === null ? 'Must be a list, like [a, b].' : null;
    case 'time-range':
      return parseRange(raw) === null
        ? 'Must be HH:MM-HH:MM, like 23:00-07:00.'
        : null;
    case 'number':
      return Number.isFinite(Number(raw)) && Number(raw) > 0
        ? null
        : 'Must be a positive number.';
    default:
      return null;
  }
}

export function parseAgent(source: string, ctx: ParseContext): ParseResult {
  const read = readFrontmatter(source);

  if (read === null) {
    return {
      problems: [
        { field: '', reason: 'AGENT.md must open and close with a --- line.' },
      ],
    };
  }

  const { fields, body } = read;
  const problems: AgentProblem[] = [];
  const known = new Set(AGENT_FIELDS.map((spec) => spec.path));

  // Unknown keys are a problem, not ignored — the point of a closed grammar.
  // Reported in file order so the list reads top to bottom like the file does.
  const seen = [...fields].sort((a, b) => a[1].line - b[1].line);

  for (const [path] of seen) {
    if (known.has(path)) continue;

    problems.push({
      field: path,
      reason: 'Unknown key. Remove it or fix the spelling.',
    });
  }

  for (const spec of AGENT_FIELDS) {
    const field = fields.get(spec.path);

    if (field === undefined) {
      if (spec.required) problems.push({ field: spec.path, reason: 'Required.' });
      continue;
    }

    const reason = checkKind(spec, field.value);

    if (reason !== null) problems.push({ field: spec.path, reason });
  }

  /**
   * A field's text, but only once its *shape* checked out. Reading a value the
   * shape pass already rejected would stack a confusing second complaint on
   * top of the real one.
   */
  const shaped = (path: string): string | undefined =>
    problems.every((problem) => problem.field !== path)
      ? fields.get(path)?.value
      : undefined;

  const name = shaped('name');

  if (name !== undefined) {
    if (!AGENT_NAME_PATTERN.test(name)) {
      problems.push({
        field: 'name',
        reason: 'Lower-case letters, digits and dashes only.',
      });
    } else if ((RESERVED_AGENT_NAMES as readonly string[]).includes(name)) {
      problems.push({ field: 'name', reason: `${name} is reserved.` });
    } else if (name !== ctx.folder) {
      problems.push({
        field: 'name',
        reason: `Must match the folder name, ${ctx.folder}.`,
      });
    } else if (ctx.skillNames.includes(name)) {
      problems.push({ field: 'name', reason: 'A skill already uses this name.' });
    }
  }

  const every = shaped('wake.every');
  const everyMs = every === undefined ? undefined : parseDuration(every);

  if (everyMs !== null && everyMs !== undefined && everyMs < WAKE_EVERY_FLOOR_MS) {
    problems.push({ field: 'wake.every', reason: 'Cannot be faster than 1m.' });
  }

  const skills = parseList(shaped('skills') ?? '[]') ?? [];

  for (const skill of skills) {
    if (ctx.skillNames.includes(skill)) continue;

    problems.push({
      field: 'skills',
      reason: `${skill} is not in ~/.hive/skills.`,
    });
  }

  const mcp = parseList(shaped('mcp') ?? '[]') ?? [];

  for (const server of mcp) {
    if (ctx.integrations.includes(server)) continue;

    problems.push({
      field: 'mcp',
      reason: `${server} is not a known integration.`,
    });
  }

  const tools = parseList(shaped('tools') ?? '[]') ?? [];

  if (tools.some((tool) => tool === '')) {
    problems.push({ field: 'tools', reason: 'A tool name cannot be empty.' });
  }

  if (problems.length > 0) return { problems };

  const quiet = shaped('wake.quiet');
  const model = shaped('model');
  const effort = shaped('effort');
  const limit = (path: string, fallback: number): number => {
    const value = shaped(path);

    return value === undefined ? fallback : Number(value);
  };

  return {
    def: {
      name: name as string,
      description: shaped('description') as string,
      icon: shaped('icon') as string,
      ...(model === undefined ? {} : { model: model as SessionModel }),
      ...(effort === undefined ? {} : { effort: effort as SessionEffort }),
      wake: {
        ...(everyMs === undefined || everyMs === null ? {} : { everyMs }),
        on: (parseList(shaped('wake.on') ?? '[]') ?? []) as WakeOn[],
        ...(quiet === undefined ? {} : { quiet: parseRange(quiet) as { from: string; to: string } }),
      },
      skills,
      mcp,
      tools,
      autonomy: (shaped('autonomy') ?? 'ask') as Autonomy,
      limits: {
        turns: limit('limits.turns', AGENT_LIMIT_DEFAULTS.turns),
        budgetUsd: limit('limits.budget_usd', AGENT_LIMIT_DEFAULTS.budgetUsd),
        rotateAfter: limit('limits.rotate_after', AGENT_LIMIT_DEFAULTS.rotateAfter),
      },
      body,
    },
  };
}

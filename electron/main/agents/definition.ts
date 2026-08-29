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
  RESERVED_AGENT_NAMES,
  WAKE_EVERY_FLOOR_MS,
  parseDays,
  parseDuration,
  parseList,
  parseRange,
  parseTimes,
  readFrontmatter,
  WAKE_DAYS,
  type AgentDefinition,
  type AgentProblem,
  type Autonomy,
  type FieldSpec,
  type WakeDay,
  type WakeOn,
} from '@shared/agent-contract';
import type {
  SessionEffort,
  SessionModel,
} from '@shared/session-contract';

export interface ParseContext {
  folder: string;
  skillNames: readonly string[];
  integrations: readonly string[];
}

export type ParseResult =
  | { def: AgentDefinition }
  | { problems: AgentProblem[] };

/*
  The reader itself lives in the contract, because the Settings form needs it
  and `src/**` cannot import `electron/main/**`. Re-exported here so main-side
  callers keep a single import.
*/
export {
  parseDays,
  parseDuration,
  parseList,
  parseRange,
  parseTimes,
  readFrontmatter,
  type RawField,
} from '@shared/agent-contract';

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
    case 'time-list':
      return parseTimes(raw) === null
        ? 'Must be a list of local times, like [09:00, 17:00].'
        : null;
    case 'day-list':
      return parseDays(raw) === null
        ? `Must be a list of days, from: ${WAKE_DAYS.join(', ')}.`
        : null;
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

  /*
    The two wake modes, and why naming both is refused rather than resolved.

    `every:` measures from the last wake; `at:` fires on the clock. There is no
    honest reading of "every 3 hours, and also at 09:00" — one of them has to
    lose, and a scheduler that picked a winner would be inventing intent the
    file failed to express. Refusing says so at the only moment the author is
    still around to fix it.
  */
  const at = shaped('wake.at');
  const days = shaped('wake.days');

  if (at !== undefined && every !== undefined) {
    problems.push({
      field: 'wake.every',
      reason: 'Use every: or at:, not both — they are two ways to schedule.',
    });
  }

  /*
    A day with no time is not a schedule. `at:` without `days:` is, though —
    it means every day, which is the commonest calendar there is and would be
    tedious to spell as all seven.
  */
  if (days !== undefined && at === undefined) {
    problems.push({
      field: 'wake.at',
      reason: 'Give at least one time, like [09:00] — days alone name no wake.',
    });
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
        ...(at === undefined ? {} : { at: parseTimes(at) as string[] }),
        ...(days === undefined ? {} : { days: parseDays(days) as WakeDay[] }),
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

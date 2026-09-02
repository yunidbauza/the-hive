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
 * The shape of a **session** id, which an agent may not take (HIVE-115).
 *
 * `hive-store.ts`'s `nextSessionId` mints `sess-01`, `sess-02`, … — base 36,
 * two digits, and `rememberSpawnId` reads them back with `/^sess-([0-9a-z]+)$/`.
 * Every one of those is a legal agent name under
 * {@link AGENT_NAME_PATTERN}, so without this an agent could be *called* a live
 * session's id.
 *
 * That is not a cosmetic clash. Sessions and agents are disjoint id spaces
 * everywhere the app reasons about them — the hook receiver routes on which
 * register a name is in, `entities` in the store is one map keyed by both, and
 * the ledger authenticates a party by name. An agent wearing `sess-01` puts a
 * collision into all three at once: its headless hooks take the session branch
 * in `receiver.ts` (the session wins, deliberately, because it is the one with
 * a pty to keep truthful), so they would move a real terminal's status dot and
 * write its history — and its `/done` would arm `/exit` on that terminal.
 *
 * Reserved as a **prefix** rather than as the exact minted shape. `sess-foo` is
 * no more nameable than `sess-01` is: the prefix is what the fleet reads as
 * "this is a terminal", and a rule a person can predict is worth more than the
 * three extra names a tighter one would allow.
 *
 * A pattern rather than an entry in {@link RESERVED_AGENT_NAMES}, because the
 * set is unbounded — there is no list of session ids to enumerate, only a shape.
 * {@link isReservedAgentName} is what puts the two questions back together so
 * every caller asks one.
 */
export const SESSION_ID_PREFIX_PATTERN = /^sess-/;

/**
 * Is this name spoken for — by the ledger, by a skill, or by the fleet?
 *
 * One function rather than the same two checks written at each of the four
 * places that validate a name (the IPC guard, the definition parser, the
 * registry's listing filter, and the Settings form). Those four must agree, and
 * a reservation added to only three of them is a name the user can create in
 * one place and see refused in another.
 */
export const isReservedAgentName = (name: string): boolean =>
  (RESERVED_AGENT_NAMES as readonly string[]).includes(name) ||
  SESSION_ID_PREFIX_PATTERN.test(name);

/**
 * Integrations an agent's `mcp:` list may name.
 *
 * One entry, because one integration exists. Whether Slack is *connected*
 * is a wake-time question, not a validation one — a definition naming a
 * signed-out Slack is well-formed, it just will not run. This list is the
 * set of integrations with a server spec in `electron/main/mcp/agent-config.ts`
 * (its `SPECS` map) — the two must be changed together, or a name accepted
 * here yields no server there, or a spec there is unreachable from a
 * definition.
 */
export const KNOWN_AGENT_MCP = ['slack'] as const;

/**
 * Days a calendar wake may name, Monday first.
 *
 * Monday first rather than JavaScript's Sunday-first `getDay()`, because the
 * list is read by a person before it is read by a scheduler and "mon-fri" is
 * the shape almost every real schedule takes. The one conversion that needs
 * doing lives wherever a `Date` is involved, not here.
 */
export const WAKE_DAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type WakeDay = (typeof WAKE_DAYS)[number];

export const WAKE_EVERY_FLOOR_MS = 60_000;
export const WAKE_EVERY_DEFAULT_MS = 300_000;

/**
 * Whether a scheduled tick has to justify itself (HIVE-121).
 *
 * `onchange` is the default because the interval a person actually writes is
 * five minutes, and five minutes of nothing is 288 turns a day spent proving
 * an empty inbox is still empty. `always` is for an agent whose work arrives
 * somewhere this process cannot see — a Slack search, a PR sweep — where "has
 * anything changed?" has no local answer and the wake *is* the check.
 *
 * Interval mode only. A fixed time is a promise to run then, so `parseAgent`
 * refuses `check:` alongside `at:` rather than letting a 09:00 standup agent
 * silently skip the one morning its ledger happened to be quiet.
 */
export const WAKE_CHECKS = ['onchange', 'always'] as const;
export type WakeCheck = (typeof WAKE_CHECKS)[number];

/**
 * Limits that have a default. **`budgetUsd` is deliberately not among them.**
 *
 * A cap is unlimited unless the author sets one, which is absence — the same
 * value `model`, `every` and `at` express by having no line. The alternative
 * was a default in dollars, and the number it would have to be is not knowable
 * here: a wake is priced at list rates whether or not anything is billed
 * (`costBasis: "list"` in the binary's own result payload), and the same run
 * costs four times as much on the default model as on `sonnet`. A default that
 * cuts off most real wakes is worse than no default at all, and the person who
 * knows what a wake of *theirs* is worth is the one writing the file.
 */
export const AGENT_LIMIT_DEFAULTS = {
  turns: 40,
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

/**
 * The two wake events that are a fixed word, rather than a word plus a target.
 *
 * These strings are **The Hive's**, not Slack's, and the second one is worth
 * saying out loud because it reads like an event name and is not one. Slack's
 * real `app_mention` fires for mentions of a Slack *app*, never for mentions of
 * a person, so `slack.mention` can only ever mean *search my mentions on the
 * wakes this agent already takes*. It is a poll instruction; it adds no wakes.
 *
 * `ledger` is the one that adds wakes, and it is the reason background agents
 * are addressable at all: an `ask` or `answer` whose `to` names the agent wakes
 * it, whoever wrote it — the overmind through the console's `ask` verb, a
 * terminal session through `ledger_ask`, or another agent through the same
 * tools. A broadcast (no `to`) wakes nobody, because parties read those on
 * their own schedule.
 */
export const WAKE_ON_EVENTS = ['ledger', 'slack.mention'] as const;

/** `slack.channel:#incorp-dev` — the prefix, and what may follow it. */
export const WAKE_ON_CHANNEL_PREFIX = 'slack.channel:';

/*
  Slack's own channel rule, loosened to tolerate the leading `#` a person will
  type because that is how the channel is written everywhere else. It is not
  stripped: the value is the author's, and `#incorp-dev` is what the ticket's
  own example file spells.
*/
const CHANNEL = /^#?[a-z0-9_-][a-z0-9._-]*$/;

/**
 * Is this a wake event The Hive knows how to act on?
 *
 * Exists because `wake.on` was the one list `parseAgent` never checked — it
 * cast the parsed strings straight to {@link WakeOn}, so a typo saved cleanly
 * and then silently never fired. Every other list in the grammar is validated
 * against something; this is that something.
 */
export function isWakeOn(value: string): value is WakeOn {
  if ((WAKE_ON_EVENTS as readonly string[]).includes(value)) return true;
  if (!value.startsWith(WAKE_ON_CHANNEL_PREFIX)) return false;

  return CHANNEL.test(value.slice(WAKE_ON_CHANNEL_PREFIX.length));
}

/**
 * When an agent wakes on its own.
 *
 * Two **modes**, not two settings that combine. `everyMs` repeats on an
 * interval measured from the last wake; `at` fires at fixed local times on
 * `days`. A definition naming both is refused rather than silently resolved,
 * because there is no honest answer to "every 3 hours, and also at 09:00" —
 * either the interval or the clock has to lose, and a scheduler that picked one
 * would be guessing at intent that the file failed to express.
 *
 * `at` is what makes the calendar mode a calendar: a definition with `days` and
 * no `at` names a day and no time, which is not a schedule.
 */
export interface WakeSpec {
  /** Absent means *not on an interval* — see `at` for the other mode. */
  everyMs?: number;
  /** Local `HH:MM`, one or more. Present iff the agent is on a calendar. */
  at?: string[];
  /** Which days `at` fires on. Absent alongside `at` means every day. */
  days?: WakeDay[];
  /**
   * Materialised at parse in interval mode, and absent in the other two.
   *
   * Filled in by the parser rather than defaulted at the point of use, the way
   * `limits` is: a scheduler reading a value cannot disagree with a form
   * reading the same value, and a default applied in two places is a default
   * that eventually drifts.
   */
  check?: WakeCheck;
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
  /**
   * `budgetUsd` absent means unlimited — no `--max-budget-usd` on the wake.
   *
   * `dailyUsd` absent means no daily ceiling, and it is a **scheduler** limit
   * rather than a flag: the binary caps one run and knows nothing about days.
   */
  limits: {
    turns: number;
    budgetUsd?: number;
    dailyUsd?: number;
    rotateAfter: number;
  };
  body: string;
}

export interface AgentSummary {
  name: string;
  description: string;
  icon: string;
  status: AgentStatus;
  wake: WakeSpec;
  /**
   * `mcp:` and `tools:` from the definition, verbatim (HIVE-123).
   *
   * Neither reached the renderer before this: the settings pane has to know
   * which agents name a given MCP server — the Slack group's "Used by" line —
   * and whether a `tools:` grant actually reaches it, via
   * {@link grantsSlackTools}. Both are already parsed in main by the time a
   * summary is built, so they ride here rather than costing the renderer a
   * second IPC round trip for two arrays it would otherwise have to re-parse
   * from a raw `AGENT.md` it does not have. A definition that never parsed —
   * or a folder the guard refuses to address — has neither, so both default
   * to `[]` rather than being left absent.
   */
  mcp: string[];
  tools: string[];
  lastRunAt?: number;
  nextRunAt?: number;
  /** Present once the agent has run at least once (HIVE-115). */
  sessionUuid?: string;
  runsSinceRotate?: number;
  /**
   * The last {@link AGENT_RUN_HISTORY} runs, oldest first (HIVE-116).
   *
   * HIVE-115 shipped only the most recent run's `cost`, on the reasoning that a
   * *row* draws one number. An agent view draws more than a row: its `Today`
   * tile is a count and a sum over the day's runs, and neither is derivable
   * from one cost.
   *
   * The array rather than a pre-computed `todayRuns` / `todayCost` pair,
   * because "today" is a question only the renderer can answer — the user's
   * calendar day, in the user's zone — and this codebase derives such things
   * in selectors rather than storing two representations of one fact.
   */
  runs: RunSummary[];
  /**
   * What today cost, accumulated in main (HIVE-121).
   *
   * This is the departure from the paragraph above, and it is deliberate.
   * `runs` is the last {@link AGENT_RUN_HISTORY} and a five-minute agent takes
   * 288 wakes a day, so a `Today` tile derived from that array under-reports
   * the moment an agent is busy. The same number is what the scheduler's daily
   * ceiling is compared against — and a ceiling and a tile that disagree are
   * worse than either alone.
   *
   * So "today" is still derived on read, from {@link dayKey}, which both
   * processes share: what is stored is the day it belongs to, not the claim
   * that it is today.
   */
  today?: { day: string; runs: number; usd: number; capped?: boolean };
  /** Scheduled ticks skipped since the last run — the `· skipped 3` on `Next`. */
  skipsSinceRun?: number;
  /**
   * `limits.rotateAfter` from the definition — the `/50` in `run 17/50`.
   *
   * Carried on the summary rather than looked up separately because the
   * numerator (`runsSinceRotate`) already travels here, and a fraction whose
   * halves arrive by different routes is a fraction that can be drawn
   * inconsistent. A *definition* fact, so the registry fills it and
   * {@link mergeRunState} never touches it.
   */
  rotateAfter: number;
  /**
   * `limits.dailyUsd` from the definition — the scheduler's day ceiling.
   *
   * A *definition* fact like {@link AgentSummary.rotateAfter} beside it: the
   * registry fills it and `mergeRunState` never touches it. It rides here
   * because the scheduler's tick reads its schedules out of the same cached
   * listing that answers `agents:list`, rather than re-parsing every
   * `AGENT.md` once a minute.
   *
   * Absent means no ceiling — and absent is also the honest answer for a
   * definition that would not parse.
   */
  dailyUsd?: number;
  /** The most recent run's cost, pre-formatted for display. */
  cost?: string;
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

/**
 * The receiver route the agents directory is served on (HIVE-127).
 *
 * POST like every other route on that server, and its own path rather than a
 * mode on `LEDGER_READ_PATH`: that route is typed `LedgerReadQuery →
 * LedgerSnapshot` end to end and its handler is entirely ledger-visibility
 * filtering, which means nothing for a directory. The receiver's route set is
 * closed and each entry carries a body cap sized to the document it expects —
 * two contracts behind one path would un-type both.
 */
export const AGENTS_PATH = '/agents';

/**
 * One agent, as a **peer** sees it (HIVE-127).
 *
 * Deliberately not {@link AgentSummary}. That type also carries `sessionUuid`,
 * `cost`, `today`, `dailyUsd` and the whole run history — none of which is any
 * of a peer's business, and the first of which is a live conversation id. The
 * projection is built in main, so the process boundary this crosses is the
 * last place any of it could leak.
 *
 * Same trust domain, to be clear about what this does disclose: every agent
 * here is a definition the user wrote on their own machine, so a name, a
 * description and a tool grant tell a peer nothing the user does not already
 * own. That is the argument for these five fields, and equally the argument
 * against a sixth that was not thought about.
 */
export interface AgentsDirectoryEntry {
  /** The address a `ledger_ask` needs. */
  name: string;
  /** The agent's own frontmatter, unmodified. Empty when `invalid`. */
  description: string;
  status: AgentStatus;
  /**
   * The definition's `wake.on` — *can I actually reach this agent?*
   *
   * A **gate**, not a preference: an agent without `ledger` here will not wake
   * on an ask no matter who sends one. Empty on an `invalid` agent, which is
   * the truth rather than a placeholder — a definition that does not parse is
   * not even a known party, so nothing can wake it and nothing may write to
   * the ledger as it.
   */
  accepts: WakeOn[];
  /** What the fence will actually let it do. Empty when `invalid`. */
  tools: string[];
  /**
   * Why this peer cannot be reached.
   *
   * Listed with its problem rather than omitted: a silently hidden agent is
   * indistinguishable from an absent one, and the fix is usually a one-line
   * edit to a file the reader can only go and find if someone says it is
   * broken.
   */
  invalid?: string;
}

/** What {@link AGENTS_PATH} answers. */
export interface AgentsDirectory {
  agents: AgentsDirectoryEntry[];
}

export type FieldKind =
  | 'text'
  | 'enum'
  | 'duration'
  | 'list'
  | 'day-list'
  | 'time-list'
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
  { path: 'wake.at', kind: 'time-list', required: false },
  { path: 'wake.days', kind: 'day-list', required: false },
  { path: 'wake.on', kind: 'list', required: false },
  { path: 'wake.quiet', kind: 'time-range', required: false },
  { path: 'wake.check', kind: 'enum', required: false, values: WAKE_CHECKS },
  { path: 'skills', kind: 'list', required: false },
  { path: 'mcp', kind: 'list', required: false },
  { path: 'tools', kind: 'list', required: false },
  { path: 'autonomy', kind: 'enum', required: false, values: AUTONOMIES },
  { path: 'limits.turns', kind: 'number', required: false },
  { path: 'limits.budget_usd', kind: 'number', required: false },
  { path: 'limits.daily_usd', kind: 'number', required: false },
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

/** `[09:00, 17:00]` → the times, sorted. `null` when any of it is not a time. */
export function parseTimes(text: string): string[] | null {
  const list = parseList(text);

  if (list === null || list.length === 0) return null;
  if (!list.every((part) => TIME.test(part))) return null;

  /*
    Deduplicated and sorted, for the two reasons `parseDays` gives plus one of
    its own. Sorted because `HH:MM` sorts lexically as it sorts chronologically,
    so "the next one today" is a scan rather than a search; deduplicated so two
    files meaning one schedule cannot disagree about what they mean.

    The third reason is that a duplicate is worse than untidy here: the form
    draws one chip per time, so `[07:30, 07:30]` rendered two chips on one React
    key, and toggling either filtered out *both* — emptying the list, tripping
    the "cannot remove the last time" guard, and leaving the pair undeletable
    from the form.
  */
  return [...new Set(list)].sort();
}

/** `[mon, fri]` → the days, in week order. `null` when any is not a day. */
export function parseDays(text: string): WakeDay[] | null {
  const list = parseList(text);

  if (list === null || list.length === 0) return null;
  if (!list.every((part) => (WAKE_DAYS as readonly string[]).includes(part))) {
    return null;
  }

  /*
    Deduplicated and put back into week order, so `[fri, mon, mon]` and
    `[mon, fri]` produce the same spec. Two definitions that mean the same
    schedule should not be able to disagree about what they mean.
  */
  return WAKE_DAYS.filter((day) => list.includes(day));
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

/**
 * How long a run that has been **asked to stop** gets, before SIGKILL
 * (HIVE-115).
 *
 * The gap between SIGTERM and SIGKILL, and nothing else. The user pressed stop,
 * or the app is quitting; either way somebody is waiting, and three seconds is
 * already longer than a headless child needs to unwind.
 *
 * SIGTERM, not the pty path's SIGHUP: `KILL_GRACE_MS` exists because an
 * interactive shell ignores SIGTERM. A headless child is not one.
 */
export const AGENT_KILL_GRACE_MS = 3_000;

/**
 * How long a run gets **after its turn has ended** before it is called stalled
 * and killed (HIVE-115).
 *
 * Deliberately longer than {@link AGENT_KILL_GRACE_MS}, and the two are
 * separate constants because they answer different questions. That one is "how
 * long does a process that was told to die get?" — nobody wants it back. This
 * one is "how long does a *healthy* run get to finish saying what it did?", and
 * the answer has real work in it: after `Stop` fires, `claude` still has to emit
 * the `result` event — the only carrier of the cost, the turn count and the
 * session uuid — and tear down its MCP stdio child, which is a second process
 * with its own exit to wait on.
 *
 * Firing early is not a harmless timeout: the watchdog kills the run, so the
 * `result` never lands, and the run is recorded `failed (stalled)` with no cost,
 * no turns and no uuid persisted — which is exactly the loss that made `'close'`
 * rather than `'exit'` the finalizer. Three seconds was measurably tight for
 * that; fifteen is not, and a genuinely wedged run is still bounded.
 */
export const AGENT_STALL_GRACE_MS = 15_000;

/**
 * The colours a run-log line may carry.
 *
 * A strict subset of the renderer's `TermColor` (`src/types/terminal.ts`).
 * Main may not import that file — it is renderer code — so the relationship is
 * held by this union being narrower, which makes `RunLine[]` assignable to
 * `TermLine[]` with no mapping step. A test asserts the assignability.
 */
export type RunLineColor = 'ink' | 'dim' | 'amber' | 'cyan';

export interface RunLine {
  text: string;
  color: RunLineColor;
  /**
   * This line is the last of its turn — the `● turn ended` fold.
   *
   * A **contract**, deliberately, and not something the renderer sniffs. The
   * run log draws its buffer newest-turn-first, which means partitioning a flat
   * stream of lines into turns; the only other handle on that boundary is the
   * line's `cyan`, and this module already warns that keying on it is "wrong
   * the moment the fold gains a second cyan line". Colour is presentation. A
   * boundary is structure, and structure that a renderer has to infer from
   * presentation is a bug waiting for the next palette change.
   *
   * Optional because every other line omits it, and because a buffer written by
   * an older build carries none — a run log that predates this field renders as
   * one long turn rather than crashing, which is the right degradation.
   */
  endsTurn?: true;
}

/**
 * How a run ended.
 *
 * `turns` is not in the story's original list: it exists because `--max-turns`
 * ends a run with `subtype: 'error_max_turns'` and **no `result` text at all**,
 * which is neither a failure nor a completion and should not be reported as
 * either.
 */
export type RunOutcome = 'done' | 'asking' | 'budget' | 'turns' | 'failed';

export interface RunSummary {
  run: string;
  trigger: string;
  startedAt: number;
  endedAt: number;
  outcome: RunOutcome;
  costUsd?: number;
  turns?: number;
  /** Why it ended that way, when the outcome alone does not say. */
  reason?: string;
  /**
   * The Claude conversation this run was part of.
   *
   * Recorded on **every** run, not only the ones that rotate: the audit trail
   * HIVE-122 needs — which uuid did the session that rotated away actually use
   * — falls out of it, and so does the more general question of which
   * conversation run 14 belonged to. Twenty of these is under a kilobyte.
   */
  sessionUuid?: string;
  /**
   * What this run's own `init` event said about the Slack server (HIVE-123).
   *
   * Absent when the run's `mcp:` list did not name `slack` at all, or the
   * `init` event never arrived (a spawn failure). Read by the scheduler on the
   * *next* tick to decide whether a scheduled wake is worth spending — an
   * agent that has never run has no entry here and is never skipped on that
   * account.
   *
   * This field **is** the skip's reason, not a fact beside it: a scheduled
   * skip is only ever caused by `needs-auth` here (`scheduler.ts`'s
   * `slackSignedOut`) or by `check: 'onchange'` finding nothing new, and the
   * two are told apart by re-reading this rather than by a second, parallel
   * "why did that skip happen" field. The renderer's chip tooltip
   * (`src/lib/agents.ts`'s `slackSignedOut`) reads the exact same value.
   */
  slack?: 'connected' | 'needs-auth';
}

/** What `~/.hive/ledger/agents.json` holds per agent. */
export interface AgentRunState {
  sessionUuid?: string;
  status: AgentStatus;
  lastRunAt?: number;
  /** Stored and pushed here; computed by HIVE-121's scheduler. */
  nextRunAt?: number;
  runsSinceRotate: number;
  /** Most recent last, capped at {@link AGENT_RUN_HISTORY}. */
  runs: RunSummary[];
  /**
   * What this agent has done today, accumulated rather than derived (HIVE-121).
   *
   * {@link AgentRunState.runs} cannot answer it. That array is capped at
   * {@link AGENT_RUN_HISTORY} and a five-minute agent takes 288 wakes a day,
   * so a sum over it silently stops growing at twenty — under-reporting
   * exactly the agents a daily ceiling exists for. A ceiling cannot be derived
   * from a truncated array.
   *
   * That is a departure from the rule stated on {@link AgentSummary.runs},
   * which argues "today" belongs in a selector. The rule holds for *display*
   * and cannot hold for *enforcement*. Main's day and the renderer's day are
   * the same machine's local day, so there is no second timezone for the two
   * to disagree about — and {@link dayKey} is the one boundary both read.
   *
   * Replaced wholesale when the day changes, which is what resets `capped` and
   * why nothing anywhere needs a midnight timer.
   */
  today?: { day: string; runs: number; usd: number; capped?: boolean };
  /**
   * Scheduled ticks skipped since the last run that actually started.
   *
   * The number that makes a *quiet* agent distinguishable from a *broken* one.
   * A skip is not a run — it produces no {@link RunSummary} and so cannot move
   * `Today`'s count — which is precisely why it needs a counter of its own.
   */
  skipsSinceRun?: number;
  /**
   * Entries that arrived while this agent could not take them (HIVE-120).
   *
   * Persisted rather than held in the scheduler's memory because the failure it
   * prevents is a silent one: a quit with the queue in memory drops entries
   * whose asks are still open, and nothing would ever bring the agent back to
   * them. Oldest first, capped at {@link AGENT_PENDING_WAKE_MAX}.
   */
  pendingWake?: PendingWakeEntry[];
  /**
   * A rotation decided at a run's close and not yet started (HIVE-122).
   *
   * The uuid is minted when the handoff wake closes, and it deliberately does
   * **not** overwrite {@link AgentRunState.sessionUuid}: until the next wake
   * actually runs, the agent's conversation is still the old one, and a uuid
   * no session file backs would fail `--resume` on the wake after next if the
   * rotation were abandoned. The next wake consumes this, passes the uuid to
   * `--session-id`, and prefixes `handoff` onto its prompt.
   */
  pendingSession?: { uuid: string; handoff: string };
  /**
   * Consecutive handoff wakes that ended without a handoff (HIVE-122).
   *
   * Reset by a rotation that succeeds. At exactly three, main posts the
   * `agent.failed` card that asks a human to look; the counter keeps climbing
   * after that, which is what stops the card repeating.
   */
  rotateFailures?: number;
  /** A `rotate <agent>` asked for a handoff wake on the next run (HIVE-122). */
  forceRotate?: boolean;
}

/** How many run summaries an agent keeps. */
export const AGENT_RUN_HISTORY = 20;

/**
 * One entry an agent has not been woken for yet (HIVE-120, widened HIVE-126).
 *
 * The three fields the wake prompt needs to name it — `<kind> <id> from <from>`
 * — and, for the one kind that needs it, the words themselves.
 *
 * A ledger entry's body stays out, and that reasoning is unchanged: `extra` is
 * a *hint*, the preamble already tells an agent to `ledger_read` its inbox
 * first, so the entry itself is read on the wake it caused. Carrying bodies
 * here would put a copy of the log inside `agents.json`, ageing separately from
 * the log.
 *
 * `text` is the case that argument does not reach. A manual run — a person
 * typing `run pr-reviewer review PR 1234` while the agent is busy — has no log
 * line behind it and nothing to re-read. This is not a second copy of those
 * words; it is the only one, and dropping it would lose the whole point of the
 * run rather than a hint about it.
 */
export interface PendingWakeEntry {
  kind: string;
  id: string;
  from: string;
  /** A manual run's own words. Absent on every ledger-routed entry. */
  text?: string;
}

/**
 * How many queued entries an agent keeps.
 *
 * The **earliest** are kept and later ones refused, which is the safe
 * direction: the entries most at risk of being forgotten are the ones that have
 * waited longest. Nothing is truly lost either way — the queue's job is to
 * cause one wake, and the agent reads its own inbox on that wake.
 */
export const AGENT_PENDING_WAKE_MAX = 20;

/**
 * `agents:run` — wake this agent now (HIVE-115, widened HIVE-126).
 *
 * A name, and optionally the words a person typed after it. The omission that
 * mattered is the one still here: the only trigger this channel could honestly
 * report is that a person pressed a button, so main writes `manual` itself
 * rather than accepting a word the page chose. Every other trigger — a timer, a
 * ledger entry, a Slack mention — originates in main and never crosses this
 * boundary at all.
 *
 * `extra` is display-and-prompt only. It reaches `wakePrompt` as the tail of
 * `You woke because: manual — <extra>.` and the run's ledger `meta`, and
 * nothing else reads it. The page says **why** someone pressed run; it still
 * cannot say what *kind* of thing woke the agent, which is the sentence the
 * original closure was defending.
 *
 * It lives here beside {@link AgentNameRequest} rather than in
 * `ipc-contract.ts` because every other `agents:*` payload does; the channel
 * *names* are the contract's, the shapes are this file's.
 */
export interface AgentRunRequest {
  name: string;
  extra?: string;
}

/**
 * What a wake answered.
 *
 * A refusal is a **value**, not a throw, for the reason `LedgerResult` is one:
 * the renderer draws the reason beside the agent, and a rejected promise would
 * reach it as an IPC error string with the refusal buried inside it.
 *
 * Wider than `RunStart` in `main/agents/runs.ts` by exactly one case, and
 * deliberately: `unknown` is what the channel answers when the runtime is not
 * up at all, which the tracker cannot say because there is no tracker to say
 * it. Every value the tracker *can* return is one of these, and the
 * `agents:run` handler's declared return type is what keeps that true.
 *
 * `paused` is a refusal rather than a silent no-op (HIVE-117) for the reason
 * the whole union is values rather than throws: the console prints the reason
 * beside the agent, and "nothing happened" is the one answer that teaches the
 * user to press the button again.
 *
 * `queued` is a **third arm** and not a flag on the refusal (HIVE-126). The
 * exhaustive `switch` in `agentRunRefusal` is what stops a reader printing a
 * plausible wrong sentence — the bug that function was extracted to fix — and a
 * flag nothing forces you to read would let "try again when it sleeps" describe
 * a run that is already waiting its turn.
 *
 * `working` and `paused` stay on the refusal arm as well, because `rotate`
 * answers with this type too and a rotation is *not* queued: main leaves
 * `forceRotate` armed through a refusal, so it survives by a different route
 * and must not claim a queue it has no place in.
 */
export type AgentRunResult =
  | { started: true; run: string }
  | { started: false; queued: true; behind: 'working' | 'paused' }
  | {
      started: false;
      refused: 'working' | 'unknown' | 'invalid' | 'paused';
      reason?: string;
    };

/**
 * What a rotation answered (HIVE-122, narrowed HIVE-126).
 *
 * {@link AgentRunResult} without the `queued` arm, and the subtraction is the
 * documentation: `agents:rotate` calls the tracker directly rather than routing
 * through the scheduler, because a refused rotation is not lost — main leaves
 * `forceRotate` armed, so the next wake of any kind is the handoff wake. There
 * is nothing for a queue to add, and a type that admitted one would make every
 * reader handle a case that cannot arrive.
 */
export type AgentRotateResult = Exclude<AgentRunResult, { queued: true }>;

/**
 * A run started, ended, or otherwise changed what an agent's row should say.
 *
 * Carries the fields of {@link AgentRunState} a row or a view renders, and no
 * others.
 *
 * `runs` did not travel here either, until HIVE-116. The reasoning was that a
 * row renders no history — true of a row, and false of the agent view, whose
 * `Today` tile changes on every close. The alternative was to emit
 * `agents:changed` on each run end and let the renderer re-list, which would
 * re-read and re-parse every `AGENT.md` on disk to learn one number main
 * already had in hand. Twenty summaries on a push that fires a few times an
 * hour is the cheaper honesty.
 */
export interface AgentStatusPush {
  name: string;
  status: AgentStatus;
  lastRunAt?: number;
  nextRunAt?: number;
  /** As {@link AgentSummary.runs} — the last {@link AGENT_RUN_HISTORY}. */
  runs: RunSummary[];
  runsSinceRotate: number;
  /**
   * As {@link AgentSummary.sessionUuid}.
   *
   * It used to stay behind, on the reasoning that it changes only on a first
   * run and on a rotation and that `agents:list` was soon enough for both.
   * HIVE-122 is the story that made that false: `agents:changed` fires on
   * AGENT.md writes and on nothing else, so after a rotation the Session fact
   * would hold a dead uuid until an unrelated edit — which can be hours. This
   * is the same journey `runs` made in HIVE-116, for the same reason.
   */
  sessionUuid?: string;
  /** As {@link AgentSummary.today} — the accumulator, not a sum over `runs`. */
  today?: { day: string; runs: number; usd: number; capped?: boolean };
  /** As {@link AgentSummary.skipsSinceRun}. */
  skipsSinceRun?: number;
  /** The last run's cost, already formatted — see {@link formatRunCost}. */
  cost?: string;
}

/** A batch of run-log lines, in the order the process wrote them. */
export interface AgentLinesPush {
  name: string;
  lines: RunLine[];
}

/**
 * The local calendar day, as `YYYY-MM-DD` (HIVE-121).
 *
 * Here rather than in either process, because both read it: main decides
 * whether an agent's daily ceiling has reset, and the renderer decides whether
 * the `Today` tile is showing today. Two spellings of one boundary would put
 * the tile and the ceiling a day apart at exactly the hour that matters.
 *
 * Local parts rather than `toISOString().slice(0, 10)`, which answers the
 * *previous* day for any evening east of UTC. Not `toDateString()` either:
 * that is locale-shaped, and this string is persisted to `agents.json`.
 */
export function dayKey(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A run's cost as a row shows it, or `undefined` when there is none.
 *
 * Formatted **once**, in main, rather than in the renderer: `agents:list` and
 * `agents:status` both carry this number and are read by the same row, so two
 * formatters would be two chances for the list and the live push to disagree
 * about one run. Four decimals under a cent, because an agent wake routinely
 * costs less than that and `$0.00` for a real run reads as a bug.
 */
export function formatRunCost(usd: number | undefined): string | undefined {
  if (usd === undefined || !Number.isFinite(usd)) return undefined;

  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

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

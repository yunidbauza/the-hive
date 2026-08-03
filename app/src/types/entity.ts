import type { TermLine } from '@/types/terminal';

/** Session lifecycle. Agents are always `online` and are tracked separately. */
export type SessionStatus = 'working' | 'waiting' | 'idle' | 'done';

export type Model = 'haiku' | 'sonnet' | 'opus' | 'fable';
export type Effort = 'low' | 'medium' | 'high' | 'max';

export type PrState = 'open' | 'merged' | 'draft';

/** One agentic terminal session, bound to a project and a branch. */
export interface Session {
  kind: 'session';
  id: string; // 'hero-refresh'
  project: string; // 'apfm-web'
  branch: string; // 'feat/hero-refresh'
  status: SessionStatus;
  task: string; // one-line description
  pr: { n: number; state: PrState } | null;
  cost: string; // '$2.41'
  model?: Model;
  effort?: Effort;
  lines: TermLine[]; // terminal transcript
}

/** A long-lived background worker, not tied to a branch. */
export interface Agent {
  kind: 'agent';
  id: string; // 'slack-agent'
  icon: string; // phosphor icon name, e.g. 'ph-slack-logo'
  sub: string; // '#eng-alerts · #deploys · #ask-eng'
  task: string;
  status: 'online';
  lines: TermLine[];
}

/** Anything that owns a terminal tab. */
export type Entity = Session | Agent;

export interface Project {
  id: string;
  icon: string;
}

/**
 * A row in the merged project list (story 101).
 *
 * Config is the source of truth for the project list, but fixture projects
 * that still own live fixture sessions stay in it — the work panel, the
 * orchestrator table, and `resolve-transport` all reach sessions through
 * `entity.project`, so dropping one would strand every session that named it.
 *
 * Deliberately a **separate type** rather than two more fields on
 * {@link Project}. A fixture genuinely has no display name and no origin —
 * `src/data/fixtures.ts` is a store-only consumer that this story leaves
 * byte-identical — so widening `Project` would mean writing values into the
 * fixtures that only the merge knows how to supply.
 */
export interface ProjectRow extends Project {
  /** Display name. A demo row uses its id, which is what it has always shown. */
  name: string;
  source: 'config' | 'demo';
}

/** Narrowing helpers — cheaper to read than repeating the discriminant. */
export const isSession = (entity: Entity): entity is Session =>
  entity.kind === 'session';

export const isAgent = (entity: Entity): entity is Agent =>
  entity.kind === 'agent';

import type { TermLine } from '@/types/terminal';

import type { SessionEffort, SessionModel } from '@shared/session-contract';

/**
 * Session lifecycle. Agents are always `online` and are tracked separately.
 *
 * `done` and `terminated` are both endings and are **not** the same ending
 * (story 108). `done` is a fixture's *judgement* — this work finished — and says
 * nothing about a process. `terminated` is an observation: the pty is gone.
 * A real session can only ever reach the second, because a pty exiting is the
 * only ending main can see; a fixture only ever shows the first, because it has
 * no process to lose.
 *
 * Collapsing them, which is what shipped before this story, made a session that
 * had merely quit indistinguishable from one that had delivered — and made the
 * app offer to reopen a terminal with nothing behind it.
 */
export type SessionStatus =
  | 'working'
  | 'waiting'
  | 'idle'
  | 'done'
  | 'terminated';

/**
 * Aliases, not declarations (story 109).
 *
 * These used to be their own unions here, which was right while they were
 * decoration — a chip on a meta bar. They are now **wire values**: the picker's
 * choice becomes `--model opus --effort high` on the command line main writes
 * into a session's shell, and the IPC guard validates it against a closed list.
 * Two independent copies of that list is how a picker comes to offer a model
 * the guard rejects, which presents as a session that silently fails to start.
 *
 * So `electron/shared/session-contract.ts` owns them, because it is the one
 * module both processes read, and this file points at it. Type-only, as the
 * fence requires.
 */
export type Model = SessionModel;
export type Effort = SessionEffort;

export type PrState = 'open' | 'merged' | 'draft';

/** One agentic terminal session, bound to a project and a branch. */
export interface Session {
  kind: 'session';
  id: string; // 'hero-refresh'
  /**
   * What the *agent* calls itself (HIVE-61).
   *
   * Optional, and absent is the normal state for a fixture and for any session
   * whose agent has not reported one. Every surface renders `name ?? id`, which
   * is what lets this be additive: nothing that reads a session had to learn a
   * new required field.
   *
   * Deliberately **not** the `id`. The id is the entities-map key, it is in
   * `branch`, and it is what every feed line and orchestrator row already
   * spells — rekeying the map on a rename would turn a cosmetic event into a
   * graph rewrite. A name is a label; an id is an identity, and Claude renames
   * only the former.
   */
  name?: string;
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

/**
 * Whether a session has ended, however it ended (story 108).
 *
 * The distinction between `done` and `terminated` matters to the *user* — one
 * finished, the other quit — and to almost nothing else. Every list that
 * partitions the fleet into "still going" and "over" wants both, and the four
 * selectors that used to spell `status === 'done'` are exactly the places a
 * fifth state would have been silently forgotten. One predicate is what stops
 * `terminated` sessions quietly reappearing in the active list.
 */
export const isEnded = (status: SessionStatus): boolean =>
  status === 'done' || status === 'terminated';

/**
 * Whether this session's process is gone and cannot be typed into.
 *
 * Narrower than {@link isEnded}, and the two are not interchangeable: a `done`
 * fixture is a *recording* whose terminal has always been read-only and works
 * fine, while a `terminated` session has a real, dead pty behind it. Only the
 * second one closes its tab to new visits.
 */
export const isTerminated = (entity: Entity | undefined): boolean =>
  entity !== undefined && entity.kind === 'session' && entity.status === 'terminated';

/** Narrowing helpers — cheaper to read than repeating the discriminant. */
export const isSession = (entity: Entity): entity is Session =>
  entity.kind === 'session';

export const isAgent = (entity: Entity): entity is Agent =>
  entity.kind === 'agent';

/**
 * What to call an entity on screen (HIVE-61).
 *
 * One function rather than `entity.name ?? entity.id` at each site, because the
 * fallback is the whole contract: a session whose agent has never reported a
 * name — every fixture, every session in its first second, every session whose
 * agent is not Claude — must read exactly as it always did. Spelling that at
 * five call sites is five chances for one of them to render `undefined`.
 *
 * Agents have no `name` field and fall through to their id, which is what they
 * have always shown.
 */
export const entityLabel = (entity: Entity): string => {
  const name = isSession(entity) ? entity.name : undefined;
  /**
   * An **empty** name falls back too, which `??` alone does not do.
   *
   * The parser already drops empty titles and the store already ignores an
   * unchanged value, so this should be unreachable — but the failure it guards
   * is a session row rendering nothing at all, and "should be unreachable" is a
   * weaker guarantee than one line here.
   */
  return name === undefined || name === '' ? entity.id : name;
};

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
  /**
   * The terminal this session runs in — a pty, not a row.
   *
   * Absent means "my own id", which is every session that has never been
   * cleared. It is only set when `/clear` retires a row and opens a successor
   * on the *same* pty, so one terminal comes to host a sequence of sessions.
   *
   * **Load-bearing, not bookkeeping.** `center-stage.tsx` keys its xterm
   * instance on this. Keying on `id` would remount the terminal the moment a
   * successor is minted — wiping and replaying the user's scrollback at exactly
   * the instant they typed `/clear`, which is the most visible regression this
   * feature could have. The row's identity changes; the terminal's must not.
   *
   * `lib/terminal/` resolves transports through it for the same reason: the
   * channel belongs to the pty, and the successor has to inherit the live one
   * rather than spawn a second process in the same directory.
   */
  terminalId?: string;
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
 * A row in the rail's project list (story 101).
 *
 * The config file is the only source. This used to be a *merged* row type,
 * carrying `source: 'config' | 'demo'` to tell a user-mapped project apart from
 * a seeded one kept in the list because it still owned live seeded sessions.
 * Both the seed and the merge are gone; `source` went with them rather than
 * lingering as a discriminant with one inhabitant and no readers.
 *
 * Still a **separate type** rather than one more field on {@link Project}:
 * `Project` is the shape the rail needs to *draw* one, and `name` is a display
 * concern the config supplies. Keeping them apart is what stops a display name
 * leaking into the places that key on `entity.project`.
 */
export interface ProjectRow extends Project {
  /** Display name, as the config declares it. */
  name: string;
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
 * Narrower than {@link isEnded}, and the two are still not interchangeable —
 * though the reason changed. Both endings now close their tab to new visits, so
 * `openEntity` gates on `isEnded`; what only `terminated` means is that the
 * **process is gone**. A cleared session's pty is alive and belongs to its
 * successor, which is why `center-stage.tsx` uses this one for the "this
 * terminal has died" notice: showing it over a session whose terminal is still
 * running would be false.
 */
export const isTerminated = (entity: Entity | undefined): boolean =>
  entity !== undefined && entity.kind === 'session' && entity.status === 'terminated';

/** Narrowing helpers — cheaper to read than repeating the discriminant. */
export const isSession = (entity: Entity): entity is Session =>
  entity.kind === 'session';

export const isAgent = (entity: Entity): entity is Agent =>
  entity.kind === 'agent';

/**
 * Which terminal a session runs in.
 *
 * One accessor rather than `session.terminalId ?? session.id` spelled at four
 * call sites: the fallback *is* the contract for every session that has never
 * been cleared, and a single place to read it is what stops one of those sites
 * forgetting the `??` and quietly spawning a second pty.
 */
export const terminalOf = (session: Session): string =>
  session.terminalId ?? session.id;

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

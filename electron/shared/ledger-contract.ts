/**
 * The ledger: one append-only log every party reads from and writes to
 * (HIVE-111).
 *
 * Types and constants only — this file is compiled into the main process, the
 * MCP host (HIVE-112) and the renderer alike, which is what makes the IPC
 * contract a compile-time artifact rather than a convention.
 */

/** Directory under `dirname(configPath())` — i.e. `~/.hive/ledger`. */
export const LEDGER_DIR = 'ledger';

export const LEDGER_KINDS = [
  'post',
  'ask',
  'answer',
  'claim',
  'release',
  'done',
  'failed',
  'event',
  'handoff',
] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];

export type PartyKind = 'overmind' | 'session' | 'agent';

/** Reserved party id. The renderer is this party's only mouth. */
export const OVERMIND = 'overmind';

/**
 * One line of the log. Never edited once written.
 *
 * Two ids, on purpose. `id` is canonical: monotonic, sortable, and what
 * `thread` and `since` always name. `ref` is the short handle a *human* types
 * — a person cannot hold `20260828-141530-0001` in their head long enough to
 * answer with it. Only asks get one.
 */
export interface LedgerEntry {
  /** `${yyyymmdd}-${hhmmss}-${seq4}`, local time. Sorts in write order. */
  id: string;
  ts: number;
  /** Party id: {@link OVERMIND}, a session entity id, or (later) an agent name. */
  from: string;
  /** Absent means broadcast. */
  to?: string;
  kind: LedgerKind;
  /** Short human handle (`a12`). Present on `ask` entries only. */
  ref?: string;
  /** The canonical id of the ask this answers or continues. Never a ref. */
  thread?: string;
  /** Markdown, capped at {@link LEDGER_BODY_MAX}. */
  body: string;
  /**
   * Free-form rider: slack ts, pr number, ticket key, `options`, `edited`,
   * `tool`. `meta.task` is the carrier for `claim` / `release` — see
   * `claims()` in `ledger-derive.ts`.
   */
  meta?: Record<string, unknown>;
}

export interface OpenAsk extends LedgerEntry {
  kind: 'ask';
  open: true;
  ageMs: number;
}

export interface LedgerSnapshot {
  entries: LedgerEntry[];
  openAsks: OpenAsk[];
  /** task → party holding it. */
  claims: Record<string, string>;
}

export interface LedgerReadQuery {
  /** Matches entries addressed to this party **or** broadcast. */
  to?: string;
  from?: string;
  kind?: LedgerKind;
  thread?: string;
  /** Exclusive lower bound, an entry id. */
  since?: string;
  /** Keep at most this many, newest. */
  limit?: number;
}

export interface LedgerPostRequest {
  from: string;
  to?: string;
  kind: LedgerKind;
  thread?: string;
  body: string;
  meta?: Record<string, unknown>;
}

export interface LedgerAnswerRequest {
  /** A canonical id or a short ref — resolved by `ledger.answer`. */
  thread: string;
  body: string;
  meta?: Record<string, unknown>;
}

/**
 * The outcome of a write.
 *
 * A refusal is a value, not a throw, because it crosses two process boundaries
 * — IPC and the receiver — and both need the reason as text a model can read.
 */
export type LedgerResult =
  | { ok: true; id: string; ref?: string }
  | { ok: false; status: number; reason: string };

export const LEDGER_BODY_MAX = 16 * 1024;
export const LEDGER_ASK_TTL_MS = 24 * 60 * 60 * 1000;

/** How many entries the renderer keeps in memory. Newest kept. */
export const LEDGER_MEMORY_CAP = 500;

/** Refs are this prefix plus a decimal counter: `a1`, `a2`, … */
export const LEDGER_REF_PREFIX = 'a';

/** Receiver routes. Both POST — see `receiver.ts`. */
export const LEDGER_POST_PATH = '/ledger';
export const LEDGER_READ_PATH = '/ledger/read';

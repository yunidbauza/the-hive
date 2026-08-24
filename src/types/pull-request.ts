export type PrListState = 'open' | 'approved' | 'draft' | 'merged';
export type PrChecks = 'passing' | 'running' | 'failing';

/**
 * A pull request as shown in the PRs panel.
 *
 * `state` is wider than `Session['pr'].state`: the panel distinguishes
 * `approved` from `open`, while a session only tracks whether its PR exists and
 * whether it has landed.
 *
 * The fields come from GitHub through `PrRecord`, except `session` — see below.
 */
export interface Pr {
  n: number;
  repo: string;
  title: string;
  state: PrListState;
  findings: number;
  checks: PrChecks;
  /** The GitHub page. Every surface that opens a PR externally opens this. */
  url: string;
  /** `headRefName`. The only thing a session is matched on. */
  branch: string;
  /**
   * The session that owns it, or `null` when no live session is on that branch.
   *
   * **Resolved, never stored.** Main has no idea what a session is, so this is
   * computed by `usePrs()` from a branch match against the fleet. `null` is the
   * ordinary case for a PR raised outside the app, or one whose session has
   * ended — and it is why every surface has a fallback action rather than
   * assuming there is a tab to open.
   */
  session: string | null;
}

/**
 * A PR as reached through a Jira ticket (story 032).
 *
 * Distinct from `Pr` because it is *resolved*, not stored, and because the
 * ticket row shows less: no title, since the ticket above it already says what
 * the work is.
 *
 * It used to be resolved from `Session.pr` — a field nothing ever set, which is
 * why the section was permanently empty. It now comes from the live PR list,
 * matched to the ticket by branch and then by key; see `resolveTicketPrs`.
 */
export interface TicketPr {
  n: number;
  repo: string;
  state: PrListState;
  findings: number;
  url: string;
  /** Owning session id, for `openEntity` — `null` when nothing matched. */
  session: string | null;
}

/**
 * The pull request a fleet row points at (HIVE-100).
 *
 * The third of these resolved shapes, and the smallest: a 34px column has room
 * for `#123` and nothing else, so it carries the number, the colour rule's
 * input, and the page to open. Findings and checks are deliberately absent —
 * they have no glyph that fits, and the PRs panel exists to show them.
 *
 * **Resolved from the live list, never read off the session.** `Session.pr` was
 * the obvious place for this and is the reason the column was empty for as long
 * as it existed: nothing has ever written that field, on any code path, and the
 * fixtures made the emptiness look like an absence of pull requests rather than
 * an absence of a writer. `TicketPr` above records the same discovery — this is
 * the last surface to stop reading it.
 */
export interface SessionPr {
  n: number;
  state: PrListState;
  /** The GitHub page. What the `#123` link opens. */
  url: string;
}

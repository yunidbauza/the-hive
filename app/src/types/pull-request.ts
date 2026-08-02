export type PrListState = 'open' | 'approved' | 'draft' | 'merged';
export type PrChecks = 'passing' | 'running' | 'failing';

/**
 * A pull request as shown in the PRs panel.
 *
 * `state` is wider than `Session['pr'].state`: the panel distinguishes
 * `approved` from `open`, while a session only tracks whether its PR exists and
 * whether it has landed.
 */
export interface Pr {
  n: number;
  repo: string;
  title: string;
  state: PrListState;
  findings: number;
  checks: PrChecks;
  session: string; // owning session id
}

/**
 * A PR as reached through a ticket's sessions (story 032).
 *
 * Distinct from `Pr` because it is *resolved*, not stored: `state` and
 * `findings` come from the global `prs` list when that list knows the number,
 * and fall back to the owning session's own `pr` field when it does not. Fixture
 * PR #31 exercises the fallback — `ecs-scaling` carries it, the global list does
 * not.
 */
export interface TicketPr {
  n: number;
  repo: string;
  state: PrListState;
  findings: number;
  session: string; // owning session id, for openTab
}

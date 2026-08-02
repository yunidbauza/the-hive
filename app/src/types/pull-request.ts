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

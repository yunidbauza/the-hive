import type { JiraStatusCategory } from '@shared/jira-contract';

/**
 * One work item.
 *
 * `status` was a closed union of four literals until HIVE-69, and that was a
 * fixture artifact: real Jira statuses are per-workflow and arbitrary — a
 * project can have "Blocked", "In QA", "Awaiting deploy" — so mapping them onto
 * four literals meant either dropping information or lying about it.
 *
 * The pair that replaces it is the whole idea: **the name is displayed verbatim
 * and the colour comes from the category**, so the app shows what Jira shows and
 * no mapping table has to be maintained as workflows change.
 */
export interface Ticket {
  key: string; // 'GRAC-3018'
  /** The status as Jira names it. Displayed verbatim, never matched against. */
  status: string;
  /**
   * Jira's own three-bucket categorisation. Drives colour and grouping.
   *
   * Reused from the IPC contract rather than redeclared, so there is one
   * definition of the three buckets and a mapped issue converts without a cast.
   */
  statusCategory: JiraStatusCategory;
  title: string;
  sessions: string[]; // session ids
  /**
   * The Jira browse URL. Absent for fixtures, present for real issues.
   *
   * Built in main, because only main knows the site.
   */
  url?: string;
}

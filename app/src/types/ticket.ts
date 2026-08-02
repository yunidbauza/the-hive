/** A work item linking one or more sessions and their PRs. */
export interface Ticket {
  key: string; // 'GRAC-3018'
  status: 'To Do' | 'In Progress' | 'In Review' | 'Done';
  title: string;
  sessions: string[]; // session ids
}

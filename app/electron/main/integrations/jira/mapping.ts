import type {
  JiraIssue,
  JiraStatusCategory,
} from '../../../shared/jira-contract';

/**
 * Jira JSON to named fields (HIVE-68).
 *
 * Pure. No I/O, no imports beyond the contract types, no clock. That is what
 * lets this module — the one carrying the most branches in the integration — be
 * tested against recorded payloads rather than against a server, and it is why
 * the epic gave it its own file instead of folding it into the client.
 *
 * ## Why nothing here throws
 *
 * {@link toIssue} answers `null` for an entry it cannot read. One malformed
 * issue then costs itself and nothing else: a page of fifty where the thirtieth
 * has no `fields` renders forty-nine tickets rather than an error. The epic's
 * rule that the pane must render either way applies *inside* a page too, and a
 * throw here would turn one bad row into a blank WORK tab.
 *
 * ## Why the mapping is this narrow
 *
 * Every field below is one the ticket card renders. `/rest/api/3/search/jql`
 * also returns `self`, `expand`, an avatar map, the assignee's email address and
 * their time zone. None of it crosses IPC, because the epic's strongest carried-
 * over rule from `gh.ts` is that only mapped, named fields do — and the test
 * deep-scans a mapped result for those exact keys to keep it that way.
 */

/** A plain object, and not an array. `typeof null` is the usual trap. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or `null`. Whitespace-only counts as absent. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Jira's `statusCategory.key` to the app's three buckets.
 *
 * The fallback is not a defensive shrug. Jira's category id 1 is literally named
 * "No Category" with the key `undefined`, and Jira paints that lozenge grey —
 * the same family as To Do's blue-grey. Mapping it to `todo` agrees with what
 * the user already sees in their own Jira, which is the only thing that makes a
 * category mapping defensible rather than a second opinion.
 */
export function toStatusCategory(key: unknown): JiraStatusCategory {
  if (key === 'indeterminate') return 'in-progress';
  if (key === 'done') return 'done';
  return 'todo';
}

/**
 * One issue, or `null` if it cannot be read.
 *
 * `site` is passed in rather than read from anywhere, because this module has no
 * access to the config and should not: it is the browse URL's only ingredient
 * that is not in the payload, and taking it as an argument keeps the function
 * pure and its test a table.
 */
export function toIssue(raw: unknown, site: string): JiraIssue | null {
  if (!isRecord(raw)) return null;

  const key = text(raw.key);
  if (key === null) return null;

  const fields = raw.fields;
  if (!isRecord(fields)) return null;

  const status = isRecord(fields.status) ? fields.status : null;
  const statusName = status === null ? null : text(status.name);
  if (statusName === null) return null;

  const category = isRecord(status?.statusCategory)
    ? status.statusCategory.key
    : undefined;

  const issueType = isRecord(fields.issuetype)
    ? (text(fields.issuetype.name) ?? 'Issue')
    : 'Issue';

  return {
    key,
    // A summary can genuinely be empty on a draft. Empty is renderable; absent
    // is not, so this defaults rather than rejecting the whole issue.
    summary: text(fields.summary) ?? '',
    status: statusName,
    statusCategory: toStatusCategory(category),
    issueType,
    // Both are legitimately absent: a project can have no priority scheme, and
    // an unassigned issue is a backlog's normal state.
    priority: isRecord(fields.priority) ? text(fields.priority.name) : null,
    assignee: isRecord(fields.assignee)
      ? text(fields.assignee.displayName)
      : null,
    updated: text(fields.updated) ?? '',
    // The one field Jira did not send. `key` is already validated by the guard
    // on the way in and by the `text` check above on the way out.
    url: `https://${site}/browse/${key}`,
  };
}

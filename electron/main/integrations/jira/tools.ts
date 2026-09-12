import {
  JIRA_MAX_COMMENTS,
  type JiraIssue,
  type JiraResult,
  type JiraStatusCategory,
  type JiraToolHandlers,
  type JiraToolIssue,
  type JiraToolTransitionReply,
  type JiraTransition,
} from '@shared/jira-contract';

import type { Jira } from './index';

/** The slice of the integration the tools read and write through. */
export type JiraToolSource = Pick<
  Jira,
  'issue' | 'detail' | 'transitions' | 'applyTransition' | 'comments' | 'links' | 'addComment'
>;

/** Forward is up this ladder; a move down it is refused (HIVE-174). */
const RANK: Record<JiraStatusCategory, number> = { todo: 0, 'in-progress': 1, done: 2 };

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The three Jira tools over the integration (HIVE-174).
 *
 * `get` degrades rather than refuses: the issue itself must read, but a
 * description, the comments or the links that fail are reported in `partial`
 * beside what did arrive. A model with the summary and half the thread can
 * still work; one with a refusal cannot. The comments read is the oldest
 * `JIRA_MAX_COMMENTS`, and a full page is reported in `partial` too: "every
 * comment" and "the first fifty" are different answers.
 *
 * `transition` is by status name because that is what every skill says
 * ("Jira → In Review"); the id is Jira's business. Three no-ops, each said in
 * `skipped`: the issue already stands there; it is not at `from` when the
 * caller gave one; or the target's category is below the current one, which
 * is "never move a ticket backwards" enforced here rather than promised in
 * prose. Only `to.name` is matched: a transition *called* Done that lands on
 * Closed is not what was asked for.
 */
export function jiraToolsFor(jira: JiraToolSource): JiraToolHandlers {
  const apply = async (
    key: string,
    match: JiraTransition,
    retry: boolean,
  ): Promise<JiraResult<JiraIssue>> => {
    const applied = await jira.applyTransition({ key, transitionId: match.id });
    // A benign race: the workflow moved between the read and the write.
    // Read it once more and try once more; the second stale is the answer.
    if (!applied.ok && applied.error.kind === 'stale' && retry) {
      const again = await jira.transitions({ key });
      const still = again.ok ? again.value.find((t) => same(t.to.name, match.to.name)) : undefined;
      return still === undefined ? applied : apply(key, still, false);
    }
    return applied;
  };

  return {
    async get(request): Promise<JiraResult<JiraToolIssue>> {
      const issue = await jira.issue(request);
      if (!issue.ok) return issue;

      const [detail, comments, links] = await Promise.all([
        jira.detail(request),
        jira.comments(request),
        jira.links(request),
      ]);
      const partial: string[] = [];
      if (!detail.ok) partial.push(`description: ${detail.error.message}`);
      if (!comments.ok) partial.push(`comments: ${comments.error.message}`);
      else if (comments.value.length >= JIRA_MAX_COMMENTS) {
        partial.push(`comments: only the oldest ${JIRA_MAX_COMMENTS} were read; the thread may be longer`);
      }
      if (!links.ok) partial.push(`links: ${links.error.message}`);

      return {
        ok: true,
        value: {
          issue: issue.value,
          detail: detail.ok ? detail.value : null,
          comments: comments.ok ? comments.value : [],
          links: links.ok ? links.value : [],
          partial,
        },
      };
    },

    async transition(request): Promise<JiraResult<JiraToolTransitionReply>> {
      const current = await jira.issue({ key: request.key });
      if (!current.ok) return current;
      const issue = current.value;
      const skip = (skipped: string): JiraResult<JiraToolTransitionReply> => ({
        ok: true,
        value: { issue, transition: null, skipped },
      });

      if (same(issue.status, request.status)) return skip(`already ${issue.status}; nothing was changed`);
      if (request.from !== undefined && !same(issue.status, request.from)) {
        return skip(`stands at ${issue.status}, not ${request.from}; nothing was changed`);
      }

      const options = await jira.transitions({ key: request.key });
      if (!options.ok) return options;
      const match = options.value.find((transition) => same(transition.to.name, request.status));
      if (match === undefined) {
        const reachable = options.value.map((transition) => `"${transition.to.name}"`).join(', ');
        return {
          ok: false,
          error: {
            kind: 'bad-query',
            message: `${request.key} is ${issue.status} and has no transition to "${request.status}"; from here it can go to ${reachable === '' ? 'nowhere' : reachable}.`,
          },
        };
      }
      if (RANK[match.to.statusCategory] < RANK[issue.statusCategory]) {
        return skip(`moving from ${issue.status} to ${match.to.name} would be backwards; nothing was changed`);
      }

      const applied = await apply(request.key, match, true);
      if (!applied.ok) return applied;
      return { ok: true, value: { issue: applied.value, transition: match } };
    },

    comment: (request) => jira.addComment(request),
  };
}

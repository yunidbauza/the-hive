import type {
  JiraResult,
  JiraToolHandlers,
  JiraToolIssue,
  JiraToolTransitionReply,
} from '@shared/jira-contract';

import type { Jira } from './index';

/** The slice of the integration the tools read and write through. */
export type JiraToolSource = Pick<
  Jira,
  'issue' | 'detail' | 'transitions' | 'applyTransition' | 'comments' | 'links' | 'addComment'
>;

/**
 * The three Jira tools over the integration (HIVE-174).
 *
 * `get` degrades rather than refuses: the issue itself must read, but a
 * description, the comments or the links that fail are reported in `partial`
 * beside what did arrive. A model with the summary and half the thread can
 * still work; one with a refusal cannot.
 *
 * `transition` is by status name because that is what every skill says
 * ("Jira → In Review"); the id is Jira's business. An issue already at the
 * status is left alone and says so, since a skill that reads "if it is still
 * To Do" would otherwise take a no-op for a failure.
 */
export function jiraToolsFor(jira: JiraToolSource): JiraToolHandlers {
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
      const wanted = request.status.trim().toLowerCase();

      const current = await jira.issue({ key: request.key });
      if (!current.ok) return current;
      if (current.value.status.toLowerCase() === wanted) {
        return { ok: true, value: { issue: current.value, transition: null } };
      }

      const options = await jira.transitions({ key: request.key });
      if (!options.ok) return options;
      const match =
        options.value.find((transition) => transition.to.name.toLowerCase() === wanted) ??
        options.value.find((transition) => transition.name.toLowerCase() === wanted);
      if (match === undefined) {
        const reachable = options.value.map((transition) => `"${transition.to.name}"`).join(', ');
        return {
          ok: false,
          error: {
            kind: 'bad-query',
            message: `${request.key} is ${current.value.status} and has no transition to "${request.status}"; from here it can go to ${reachable === '' ? 'nowhere' : reachable}.`,
          },
        };
      }

      const applied = await jira.applyTransition({ key: request.key, transitionId: match.id });
      if (!applied.ok) return applied;
      return { ok: true, value: { issue: applied.value, transition: match } };
    },

    comment: (request) => jira.addComment(request),
  };
}

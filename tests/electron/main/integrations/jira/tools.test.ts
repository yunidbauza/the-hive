// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { JiraIssue, JiraResult, JiraTransition } from '../../../../../electron/shared/jira-contract';
import { jiraToolsFor, type JiraToolSource } from '../../../../../electron/main/integrations/jira/tools';

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  key: 'HIVE-7',
  summary: 'Ship the thing',
  status: 'To Do',
  statusCategory: 'todo',
  issueType: 'Story',
  priority: null,
  assignee: null,
  updated: '2026-09-11T10:00:00Z',
  url: 'https://x.atlassian.net/browse/HIVE-7',
  ...over,
});

const ok = <T,>(value: T): JiraResult<T> => ({ ok: true, value });
const refused = <T,>(message: string): JiraResult<T> => ({ ok: false, error: { kind: 'timeout', message } });

const transitions: JiraTransition[] = [
  { id: '21', name: 'Start work', to: { name: 'In Progress', statusCategory: 'in-progress' } },
  { id: '31', name: 'Start review', to: { name: 'In Review', statusCategory: 'in-progress' } },
];

const source = (over: Partial<JiraToolSource> = {}): JiraToolSource => ({
  issue: vi.fn(async () => ok(issue())),
  detail: vi.fn(async () => ok({ description: [], parent: null })),
  transitions: vi.fn(async () => ok(transitions)),
  applyTransition: vi.fn(async (request: { transitionId: string }) =>
    ok(issue({ status: transitions.find((t) => t.id === request.transitionId)?.to.name ?? '?' })),
  ),
  comments: vi.fn(async () => ok([])),
  links: vi.fn(async () => ok([])),
  addComment: vi.fn(async () => ok({ id: '1', author: 'me', created: 'now', body: [] })),
  ...over,
});

describe('jiraToolsFor (HIVE-174)', () => {
  it('get assembles the issue with its detail, comments and links, reading the three beside each other', async () => {
    const jira = source();
    const result = await jiraToolsFor(jira).get({ key: 'HIVE-7' });

    expect(result).toEqual(ok({ issue: issue(), detail: { description: [], parent: null }, comments: [], links: [], partial: [] }));
    for (const read of [jira.detail, jira.comments, jira.links]) {
      expect(read).toHaveBeenCalledWith({ key: 'HIVE-7' });
    }
  });

  it('get degrades: a failed side read is named in partial, a failed issue read is the answer', async () => {
    const degraded = await jiraToolsFor(
      source({ comments: async () => refused('comments timed out'), detail: async () => refused('detail timed out') }),
    ).get({ key: 'HIVE-7' });
    expect(degraded).toEqual(
      ok({ issue: issue(), detail: null, comments: [], links: [], partial: ['description: detail timed out', 'comments: comments timed out'] }),
    );

    const jira = source({ issue: async () => refused('offline') });
    expect(await jiraToolsFor(jira).get({ key: 'HIVE-7' })).toEqual(refused('offline'));
    expect(jira.comments).not.toHaveBeenCalled();
  });

  it('transition finds the step by target status, case-insensitively, and applies it', async () => {
    const jira = source();
    const result = await jiraToolsFor(jira).transition({ key: 'HIVE-7', status: 'in review' });

    expect(jira.applyTransition).toHaveBeenCalledWith({ key: 'HIVE-7', transitionId: '31' });
    expect(result).toEqual(ok({ issue: issue({ status: 'In Review' }), transition: transitions[1] }));
  });

  it('transition accepts the transition name too, leaves an issue already there alone, and names the reachable ones otherwise', async () => {
    const byName = source();
    await jiraToolsFor(byName).transition({ key: 'HIVE-7', status: 'Start work' });
    expect(byName.applyTransition).toHaveBeenCalledWith({ key: 'HIVE-7', transitionId: '21' });

    const already = source();
    expect(await jiraToolsFor(already).transition({ key: 'HIVE-7', status: 'to do' })).toEqual(ok({ issue: issue(), transition: null }));
    expect(already.transitions).not.toHaveBeenCalled();
    expect(already.applyTransition).not.toHaveBeenCalled();

    const nowhere = source();
    expect(await jiraToolsFor(nowhere).transition({ key: 'HIVE-7', status: 'Done' })).toEqual({
      ok: false,
      error: {
        kind: 'bad-query',
        message: 'HIVE-7 is To Do and has no transition to "Done"; from here it can go to "In Progress", "In Review".',
      },
    });
    expect(nowhere.applyTransition).not.toHaveBeenCalled();
  });

  it('comment passes through', async () => {
    const jira = source();
    const result = await jiraToolsFor(jira).comment({ key: 'HIVE-7', markdown: 'hi' });
    expect(jira.addComment).toHaveBeenCalledWith({ key: 'HIVE-7', markdown: 'hi' });
    expect(result).toEqual(ok({ id: '1', author: 'me', created: 'now', body: [] }));
  });
});

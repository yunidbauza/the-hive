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

  it('transition never goes backwards, honours from, and matches only the target status', async () => {
    const already = source();
    expect(await jiraToolsFor(already).transition({ key: 'HIVE-7', status: 'to do' })).toEqual(
      ok({ issue: issue(), transition: null, skipped: 'already To Do; nothing was changed' }),
    );
    expect(already.transitions).not.toHaveBeenCalled();

    const elsewhere = source({ issue: async () => ok(issue({ status: 'In Review', statusCategory: 'in-progress' })) });
    expect(await jiraToolsFor(elsewhere).transition({ key: 'HIVE-7', status: 'In Progress', from: 'To Do' })).toEqual(
      ok({
        issue: issue({ status: 'In Review', statusCategory: 'in-progress' }),
        transition: null,
        skipped: 'stands at In Review, not To Do; nothing was changed',
      }),
    );
    expect(elsewhere.applyTransition).not.toHaveBeenCalled();

    const done = source({
      issue: async () => ok(issue({ status: 'Done', statusCategory: 'done' })),
      transitions: async () => ok([{ id: '11', name: 'Reopen', to: { name: 'In Progress', statusCategory: 'in-progress' } }]),
    });
    expect(await jiraToolsFor(done).transition({ key: 'HIVE-7', status: 'In Progress' })).toEqual(
      ok({
        issue: issue({ status: 'Done', statusCategory: 'done' }),
        transition: null,
        skipped: 'moving from Done to In Progress would be backwards; nothing was changed',
      }),
    );
    expect(done.applyTransition).not.toHaveBeenCalled();

    // A transition *named* Done that lands on Closed is not a move to Done.
    const misnamed = source({
      transitions: async () => ok([{ id: '41', name: 'Done', to: { name: 'Closed', statusCategory: 'done' } }]),
    });
    expect(await jiraToolsFor(misnamed).transition({ key: 'HIVE-7', status: 'Done' })).toEqual({
      ok: false,
      error: {
        kind: 'bad-query',
        message: 'HIVE-7 is To Do and has no transition to "Done"; from here it can go to "Closed".',
      },
    });
    expect(misnamed.applyTransition).not.toHaveBeenCalled();
  });

  it('transition retries a stale workflow once, then reports it', async () => {
    const stale = { ok: false as const, error: { kind: 'stale' as const, message: 'moved' } };
    let applies = 0;
    const recovers = source({
      applyTransition: vi.fn(async () => {
        applies += 1;
        return applies === 1 ? stale : ok(issue({ status: 'In Review' }));
      }),
    });
    const result = await jiraToolsFor(recovers).transition({ key: 'HIVE-7', status: 'In Review' });
    expect(result.ok && result.value.issue.status).toBe('In Review');
    expect(recovers.transitions).toHaveBeenCalledTimes(2);

    const twice = source({ applyTransition: vi.fn(async () => stale) });
    expect(await jiraToolsFor(twice).transition({ key: 'HIVE-7', status: 'In Review' })).toEqual(stale);
    expect(twice.applyTransition).toHaveBeenCalledTimes(2);
  });

  it('get says when the comments read hit its cap', async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({ id: String(i), author: 'a', created: 'c', body: [] }));
    const result = await jiraToolsFor(source({ comments: async () => ok(full) })).get({ key: 'HIVE-7' });
    expect(result.ok && result.value.partial).toEqual([
      'comments: only the oldest 50 were read; the thread may be longer',
    ]);
  });

  it('comment passes through', async () => {
    const jira = source();
    const result = await jiraToolsFor(jira).comment({ key: 'HIVE-7', markdown: 'hi' });
    expect(jira.addComment).toHaveBeenCalledWith({ key: 'HIVE-7', markdown: 'hi' });
    expect(result).toEqual(ok({ id: '1', author: 'me', created: 'now', body: [] }));
  });
});

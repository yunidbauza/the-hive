// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  toIssue,
  toStatusCategory,
} from '../../../../../electron/main/integrations/jira/mapping';

/**
 * The mapping layer (HIVE-68).
 *
 * The highest-value tests in the integration, because this is the module with
 * the most branches and the one a real Jira will surprise: every project has a
 * different workflow, and half of them have no priority scheme.
 *
 * Payloads below are shaped like real `/rest/api/3/search/jql` responses,
 * including the fields the app does *not* ask for — `self`, `expand`,
 * `avatarUrls`, `emailAddress` — so the last test can prove none of them
 * survives the mapping.
 */

const SITE = 'behiques.atlassian.net';

/** A realistic issue, with Jira's extra fields present. */
const issue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  expand: 'operations,versionedRepresentations',
  id: '10880',
  self: `https://${SITE}/rest/api/3/issue/10880`,
  key: 'HIVE-68',
  fields: {
    summary: 'Jira REST client and IPC read verbs',
    status: {
      self: `https://${SITE}/rest/api/3/status/10108`,
      name: 'In Progress',
      id: '10108',
      statusCategory: {
        self: `https://${SITE}/rest/api/3/statuscategory/4`,
        id: 4,
        key: 'indeterminate',
        colorName: 'yellow',
        name: 'In Progress',
      },
    },
    issuetype: { name: 'Story', id: '10079', subtask: false },
    priority: { name: 'Medium', id: '3' },
    updated: '2026-08-07T00:41:13.497-0400',
    assignee: {
      accountId: '712020:9f3c',
      displayName: 'Yunid Bauza',
      emailAddress: 'private@example.com',
      avatarUrls: { '48x48': `https://${SITE}/avatar/48` },
    },
    ...(over.fields as Record<string, unknown> | undefined),
  },
  ...over,
});

/** Replace one key inside `fields`, keeping the rest realistic. */
const withField = (key: string, value: unknown): Record<string, unknown> => {
  const base = issue();
  const fields = { ...(base.fields as Record<string, unknown>) };
  if (value === undefined) delete fields[key];
  else fields[key] = value;
  return { ...base, fields };
};

describe('toStatusCategory', () => {
  it('maps Jira’s three keys', () => {
    expect(toStatusCategory('new')).toBe('todo');
    expect(toStatusCategory('indeterminate')).toBe('in-progress');
    expect(toStatusCategory('done')).toBe('done');
  });

  it('maps Jira’s own "No Category" to todo', () => {
    // Category id 1, key `undefined`, painted grey by Jira itself — the same
    // family as To Do's blue-grey, so this agrees with what the user sees.
    expect(toStatusCategory('undefined')).toBe('todo');
  });

  it('maps anything unrecognised to todo rather than guessing', () => {
    expect(toStatusCategory('brand-new-bucket')).toBe('todo');
    expect(toStatusCategory(undefined)).toBe('todo');
    expect(toStatusCategory(null)).toBe('todo');
    expect(toStatusCategory(4)).toBe('todo');
  });
});

describe('toIssue — a complete issue', () => {
  it('maps every field the ticket card renders', () => {
    expect(toIssue(issue(), SITE)).toEqual({
      key: 'HIVE-68',
      summary: 'Jira REST client and IPC read verbs',
      status: 'In Progress',
      statusCategory: 'in-progress',
      issueType: 'Story',
      priority: 'Medium',
      assignee: 'Yunid Bauza',
      updated: '2026-08-07T00:41:13.497-0400',
      url: `https://${SITE}/browse/HIVE-68`,
    });
  });

  it('builds the browse URL from the site it was given', () => {
    expect(toIssue(issue(), 'other.atlassian.net')?.url).toBe(
      'https://other.atlassian.net/browse/HIVE-68',
    );
  });
});

describe('toIssue — every status category', () => {
  const categories: [string, string][] = [
    ['new', 'todo'],
    ['indeterminate', 'in-progress'],
    ['done', 'done'],
    ['undefined', 'todo'],
  ];

  for (const [key, expected] of categories) {
    it(`maps ${key} to ${expected}`, () => {
      const raw = withField('status', {
        name: 'Whatever',
        statusCategory: { key },
      });
      expect(toIssue(raw, SITE)?.statusCategory).toBe(expected);
    });
  }

  it('keeps a status name Jira invented, verbatim', () => {
    const raw = withField('status', {
      name: 'Awaiting deploy',
      statusCategory: { key: 'indeterminate' },
    });
    const mapped = toIssue(raw, SITE);
    expect(mapped?.status).toBe('Awaiting deploy');
    expect(mapped?.statusCategory).toBe('in-progress');
  });

  it('keeps a status name with unusual characters', () => {
    const raw = withField('status', {
      name: 'Blocked — waiting on QA / legal (P1)',
      statusCategory: { key: 'new' },
    });
    expect(toIssue(raw, SITE)?.status).toBe(
      'Blocked — waiting on QA / legal (P1)',
    );
  });

  it('falls back to todo when statusCategory is missing entirely', () => {
    const raw = withField('status', { name: 'Odd' });
    expect(toIssue(raw, SITE)?.statusCategory).toBe('todo');
  });
});

describe('toIssue — legitimately absent fields', () => {
  it('reads a missing assignee as null', () => {
    expect(toIssue(withField('assignee', null), SITE)?.assignee).toBeNull();
    expect(toIssue(withField('assignee', undefined), SITE)?.assignee).toBeNull();
  });

  it('reads an absent priority as null', () => {
    expect(toIssue(withField('priority', null), SITE)?.priority).toBeNull();
    expect(toIssue(withField('priority', undefined), SITE)?.priority).toBeNull();
  });

  it('reads an assignee with no display name as null', () => {
    const raw = withField('assignee', { accountId: 'x' });
    expect(toIssue(raw, SITE)?.assignee).toBeNull();
  });

  it('defaults an empty summary rather than rejecting the issue', () => {
    // A draft can genuinely have none. Empty is renderable; absent is not.
    expect(toIssue(withField('summary', ''), SITE)?.summary).toBe('');
    expect(toIssue(withField('summary', undefined), SITE)?.summary).toBe('');
  });

  it('defaults an unknown issue type', () => {
    expect(toIssue(withField('issuetype', undefined), SITE)?.issueType).toBe(
      'Issue',
    );
  });
});

describe('toIssue — a malformed entry costs itself and nothing else', () => {
  it('answers null for a non-object', () => {
    expect(toIssue(null, SITE)).toBeNull();
    expect(toIssue('HIVE-68', SITE)).toBeNull();
    expect(toIssue([], SITE)).toBeNull();
    expect(toIssue(undefined, SITE)).toBeNull();
  });

  it('answers null when there is no key', () => {
    const raw = issue();
    delete raw.key;
    expect(toIssue(raw, SITE)).toBeNull();
  });

  it('answers null when there are no fields', () => {
    const raw = issue();
    delete raw.fields;
    expect(toIssue(raw, SITE)).toBeNull();
  });

  it('answers null when the status has no name', () => {
    expect(toIssue(withField('status', { id: '1' }), SITE)).toBeNull();
    expect(toIssue(withField('status', undefined), SITE)).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    const nasty: unknown[] = [
      {},
      { key: 'HIVE-1' },
      { key: 'HIVE-1', fields: 'nope' },
      { key: 'HIVE-1', fields: { status: 7 } },
      { key: 'HIVE-1', fields: { status: { name: 'A', statusCategory: 3 } } },
      JSON.parse('{"__proto__": {"key": "X"}}'),
    ];
    for (const raw of nasty) {
      expect(() => toIssue(raw, SITE)).not.toThrow();
    }
  });
});

/**
 * The rule that would be quietly broken by a "just pass the raw issue through,
 * we might need it later" change.
 */
describe('no raw payload survives', () => {
  it('drops every field the app did not ask for', () => {
    const serialised = JSON.stringify(toIssue(issue(), SITE));

    for (const leaked of [
      'self',
      'expand',
      'avatarUrls',
      'emailAddress',
      'accountId',
      'private@example.com',
      'colorName',
      'versionedRepresentations',
    ]) {
      expect(serialised).not.toContain(leaked);
    }
  });

  it('returns exactly the nine declared keys, no more', () => {
    expect(Object.keys(toIssue(issue(), SITE) ?? {}).sort()).toEqual([
      'assignee',
      'issueType',
      'key',
      'priority',
      'status',
      'statusCategory',
      'summary',
      'updated',
      'url',
    ]);
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  parseAgent,
  readFrontmatter,
} from '../../../../electron/main/agents/definition';

/**
 * The ticket's own example, verbatim.
 *
 * It is the fixture precisely because it is hostile: three different readings
 * of `#` appear in it, and a parser that gets any one of them wrong still
 * looks correct on a simpler file.
 */
const GOOD = `---
name: slack-watcher
description: Watches #incorp-dev and my mentions; drafts replies about shipped work.
icon: ChatCircleDots                # a Phosphor name, as projects use
model: sonnet
effort: medium
wake:
  every: 5m                         # omit for event/manual-only; floor 1m
  on: [ledger, slack.mention, slack.channel:#incorp-dev]
  quiet: 23:00-07:00                # no scheduled wakes; events still wake
skills: [jira-writer, release-notes]
mcp: [slack]
tools: [Read, Grep, WebFetch]
autonomy: ask
limits:
  turns: 40
  budget_usd: 0.50
  rotate_after: 50
---
You are the Slack watcher for Yunid. On every wake, read your ledger inbox first…
`;

const BASE = {
  folder: 'slack-watcher',
  skillNames: ['jira-writer', 'release-notes'],
  integrations: ['slack'],
};

const problems = (source: string, over: Partial<typeof BASE> = {}) => {
  const result = parseAgent(source, { ...BASE, ...over });

  if ('def' in result) throw new Error('expected problems, got a definition');

  return result.problems;
};

const definition = (source: string, over: Partial<typeof BASE> = {}) => {
  const result = parseAgent(source, { ...BASE, ...over });

  if ('problems' in result) {
    throw new Error(`expected a definition: ${JSON.stringify(result.problems)}`);
  }

  return result.def;
};

describe('the comment rule', () => {
  it('keeps a single-space # inside a value', () => {
    expect(definition(GOOD).description).toBe(
      'Watches #incorp-dev and my mentions; drafts replies about shipped work.',
    );
  });

  it('strips a column-aligned trailing comment', () => {
    expect(definition(GOOD).icon).toBe('ChatCircleDots');
  });

  it('keeps a # that has no space before it, inside a list', () => {
    expect(definition(GOOD).wake.on).toEqual([
      'ledger',
      'slack.mention',
      'slack.channel:#incorp-dev',
    ]);
  });

  it('drops a whole-line comment', () => {
    const source = GOOD.replace(
      'name: slack-watcher',
      '# a note\nname: slack-watcher',
    );

    expect(definition(source).name).toBe('slack-watcher');
  });
});

describe('readFrontmatter', () => {
  it('fails closed when the fence never closes', () => {
    expect(readFrontmatter('---\nname: x\n')).toBeNull();
  });

  it('fails closed when the file does not open with a fence', () => {
    expect(readFrontmatter('name: x\n---\n')).toBeNull();
  });

  it('returns the body after the closing fence', () => {
    expect(readFrontmatter(GOOD)?.body.trim()).toBe(
      'You are the Slack watcher for Yunid. On every wake, read your ledger inbox first…',
    );
  });

  it('addresses a nested key by its dotted path', () => {
    expect(readFrontmatter(GOOD)?.fields.get('wake.every')?.value).toBe('5m');
  });

  it('records the line each field sits on, for the patcher', () => {
    expect(readFrontmatter(GOOD)?.fields.get('name')?.line).toBe(1);
  });
});

describe('parseAgent — the good file', () => {
  it('reads every field', () => {
    const def = definition(GOOD);

    expect(def.name).toBe('slack-watcher');
    expect(def.model).toBe('sonnet');
    expect(def.effort).toBe('medium');
    expect(def.wake.everyMs).toBe(300_000);
    expect(def.wake.quiet).toEqual({ from: '23:00', to: '07:00' });
    expect(def.skills).toEqual(['jira-writer', 'release-notes']);
    expect(def.mcp).toEqual(['slack']);
    expect(def.tools).toEqual(['Read', 'Grep', 'WebFetch']);
    expect(def.autonomy).toBe('ask');
    expect(def.limits).toEqual({ turns: 40, budgetUsd: 0.5, rotateAfter: 50 });
  });

  it('keeps the body', () => {
    expect(definition(GOOD).body).toContain('You are the Slack watcher');
  });
});

describe('parseAgent — refusals', () => {
  it('refuses an unknown key, naming it', () => {
    expect(problems(GOOD.replace('autonomy: ask', 'autonmy: ask'))).toContainEqual(
      { field: 'autonmy', reason: 'Unknown key. Remove it or fix the spelling.' },
    );
  });

  it('refuses a wake interval under the floor, naming the floor', () => {
    const found = problems(GOOD.replace('every: 5m', 'every: 30s'));

    expect(found).toHaveLength(1);
    expect(found[0]?.field).toBe('wake.every');
    expect(found[0]?.reason).toContain('5m');
  });

  it('refuses a sub-minute interval that is otherwise well formed', () => {
    // `1m` is the floor, so a valid duration can still be too fast: this is
    // the rule the shape check cannot express.
    const found = problems(GOOD.replace('every: 5m', 'every: 0m'));

    expect(found).toEqual([
      { field: 'wake.every', reason: 'Cannot be faster than 1m.' },
    ]);
  });

  it('refuses a reserved name', () => {
    const source = GOOD.replace('name: slack-watcher', 'name: overmind');

    expect(problems(source, { folder: 'overmind' })).toContainEqual({
      field: 'name',
      reason: 'overmind is reserved.',
    });
  });

  it('refuses a name that does not match its folder', () => {
    expect(problems(GOOD, { folder: 'something-else' })).toContainEqual({
      field: 'name',
      reason: 'Must match the folder name, something-else.',
    });
  });

  it('refuses a name that is also a skill', () => {
    expect(
      problems(GOOD, { skillNames: ['slack-watcher', 'jira-writer', 'release-notes'] }),
    ).toContainEqual({ field: 'name', reason: 'A skill already uses this name.' });
  });

  it('refuses a skill that does not exist, naming it', () => {
    expect(problems(GOOD, { skillNames: ['jira-writer'] })).toContainEqual({
      field: 'skills',
      reason: 'release-notes is not in ~/.hive/skills.',
    });
  });

  it('refuses an unknown integration, naming it', () => {
    expect(problems(GOOD.replace('mcp: [slack]', 'mcp: [discord]'))).toContainEqual(
      { field: 'mcp', reason: 'discord is not a known integration.' },
    );
  });

  it('refuses an autonomy outside the union', () => {
    expect(
      problems(GOOD.replace('autonomy: ask', 'autonomy: whatever')),
    ).toContainEqual({ field: 'autonomy', reason: 'Must be one of: ask, act.' });
  });

  it('refuses quiet hours that are not HH:MM-HH:MM', () => {
    expect(problems(GOOD.replace('quiet: 23:00-07:00', 'quiet: 11pm-7am'))[0]?.field).toBe(
      'wake.quiet',
    );
  });

  it('refuses a non-positive limit', () => {
    expect(problems(GOOD.replace('turns: 40', 'turns: 0'))).toContainEqual({
      field: 'limits.turns',
      reason: 'Must be a positive number.',
    });
  });

  it('refuses an empty tool name', () => {
    const source = GOOD.replace(
      'tools: [Read, Grep, WebFetch]',
      'tools: [Read, , Grep]',
    );

    expect(problems(source)[0]?.field).toBe('tools');
  });

  it('refuses a missing required field, naming it', () => {
    expect(problems(GOOD.replace(/^icon: .*$/m, ''))).toContainEqual({
      field: 'icon',
      reason: 'Required.',
    });
  });

  it('refuses a file with no closing fence, as a whole-file problem', () => {
    expect(problems('---\nname: slack-watcher\n')).toEqual([
      { field: '', reason: 'AGENT.md must open and close with a --- line.' },
    ]);
  });

  it('reports every bad field at once, not just the first', () => {
    const source = GOOD.replace('every: 5m', 'every: 30s').replace(
      'autonomy: ask',
      'autonomy: whatever',
    );

    expect(problems(source).map((problem) => problem.field)).toEqual([
      'wake.every',
      'autonomy',
    ]);
  });
});

describe('parseAgent — defaults and the manual-only case', () => {
  const MINIMAL = `---
name: quiet-one
description: Does nothing on a schedule.
icon: Ghost
---
Wait to be asked.
`;

  const alone = { folder: 'quiet-one', skillNames: [] };

  it('saves with no every and no on, as manual-only', () => {
    const def = definition(MINIMAL, alone);

    expect(def.wake.everyMs).toBeUndefined();
    expect(def.wake.on).toEqual([]);
  });

  it('fills the documented defaults', () => {
    const def = definition(MINIMAL, alone);

    expect(def.autonomy).toBe('ask');
    expect(def.limits).toEqual({ turns: 40, budgetUsd: 0.5, rotateAfter: 50 });
    expect(def.skills).toEqual([]);
    expect(def.tools).toEqual([]);
  });

  it('reads daily as a full day', () => {
    const source = MINIMAL.replace(
      'icon: Ghost',
      'icon: Ghost\nwake:\n  every: daily',
    );

    expect(definition(source, alone).wake.everyMs).toBe(86_400_000);
  });

  it('reads an hour suffix', () => {
    const source = MINIMAL.replace(
      'icon: Ghost',
      'icon: Ghost\nwake:\n  every: 2h',
    );

    expect(definition(source, alone).wake.everyMs).toBe(7_200_000);
  });

  it('accepts an empty list', () => {
    const source = MINIMAL.replace('icon: Ghost', 'icon: Ghost\nskills: []');

    expect(definition(source, alone).skills).toEqual([]);
  });
});

/**
 * The calendar wake mode.
 *
 * `every:` measures from the last wake; `at:` fires on the clock. They are two
 * modes rather than two settings, which is why naming both is refused instead
 * of resolved — see `WakeSpec`.
 */
describe('parseAgent — the calendar wake mode', () => {
  /** GOOD with its `every:` line swapped for whatever the calendar needs. */
  const calendar = (lines: string) =>
    GOOD.replace(
      '  every: 5m                         # omit for event/manual-only; floor 1m\n',
      lines,
    );

  it('reads times and days', () => {
    const def = definition(
      calendar('  at: [09:00, 17:00]\n  days: [mon, wed, fri]\n'),
    );

    expect(def.wake.at).toEqual(['09:00', '17:00']);
    expect(def.wake.days).toEqual(['mon', 'wed', 'fri']);
    expect(def.wake.everyMs).toBeUndefined();
  });

  it('sorts times, so "the next one today" is a scan', () => {
    expect(definition(calendar('  at: [17:00, 09:00]\n')).wake.at).toEqual([
      '09:00',
      '17:00',
    ]);
  });

  /*
    Two definitions that mean the same schedule must not be able to disagree
    about what they mean.
  */
  it('puts days back in week order and drops duplicates', () => {
    expect(
      definition(calendar('  at: [09:00]\n  days: [fri, mon, mon]\n')).wake.days,
    ).toEqual(['mon', 'fri']);
  });

  /*
    A duplicate time is worse than untidy: the form draws one chip per time, so
    two copies shared a React key, and toggling either filtered out both —
    emptying the list, tripping the "cannot remove the last time" guard, and
    leaving the pair undeletable from the form.
  */
  it('drops a duplicated time, as days already drops a duplicated day', () => {
    expect(definition(calendar('  at: [07:30, 07:30, 09:00]\n')).wake.at).toEqual([
      '07:30',
      '09:00',
    ]);
  });

  it('treats at: without days: as every day', () => {
    const def = definition(calendar('  at: [09:00]\n'));

    expect(def.wake.at).toEqual(['09:00']);
    expect(def.wake.days).toBeUndefined();
  });

  it('refuses days: with no time, which names no wake', () => {
    expect(problems(calendar('  days: [mon]\n'))).toContainEqual({
      field: 'wake.at',
      reason: 'Give at least one time, like [09:00] — days alone name no wake.',
    });
  });

  it('refuses every: and at: together, rather than picking a winner', () => {
    expect(
      problems(calendar('  every: 5m\n  at: [09:00]\n')),
    ).toContainEqual({
      field: 'wake.every',
      reason: 'Use every: or at:, not both — they are two ways to schedule.',
    });
  });

  it('refuses a time that is not a time', () => {
    expect(problems(calendar('  at: [9am]\n'))).toContainEqual({
      field: 'wake.at',
      reason: 'Must be a list of local times, like [09:00, 17:00].',
    });
  });

  it('refuses an empty time list', () => {
    expect(problems(calendar('  at: []\n'))).toContainEqual({
      field: 'wake.at',
      reason: 'Must be a list of local times, like [09:00, 17:00].',
    });
  });

  it('refuses a day that is not a day', () => {
    expect(
      problems(calendar('  at: [09:00]\n  days: [mon, funday]\n')).map(
        (problem) => problem.field,
      ),
    ).toContain('wake.days');
  });

  it('still reads an interval-only definition', () => {
    const def = definition(GOOD);

    expect(def.wake.everyMs).toBe(300_000);
    expect(def.wake.at).toBeUndefined();
    expect(def.wake.days).toBeUndefined();
  });
});

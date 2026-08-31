import { describe, expect, it, vi } from 'vitest';

import type { LedgerPostRequest } from '@shared/ledger-contract';

import { createPermissions } from '../../../../electron/main/agents/permissions';

const ask = (id: string, from: string, rungs: unknown) => ({
  id, ts: 1, from, to: 'overmind', kind: 'ask' as const,
  body: 'Allow Bash?\ngit push',
  meta: { kind: 'permission', tool: 'Bash', rungs },
});

const answer = (id: string, thread: string, body: string) => ({
  id, ts: 2, from: 'overmind', to: 'drone', kind: 'answer' as const, thread, body,
});

const RUNGS = [
  { id: 'allow-once', label: 'once', caption: 'c' },
  { id: 'allow-family', label: 'git *', caption: 'c', rule: 'Bash(git *)' },
  { id: 'allow-tool', label: 'all Bash', caption: 'c', rule: 'Bash' },
];

const SOURCE = '---\nname: drone\ntools: [Read]\n---\n\nBody.\n';

const deps = (entries: unknown[], overrides = {}) => ({
  entries: () => entries as never,
  append: vi.fn((_request: LedgerPostRequest) => undefined),
  read: vi.fn(async () => SOURCE),
  // Typed with both params (even though the default resolution ignores them)
  // so `.mock.calls[n]![1]` below resolves against a 2-element tuple instead
  // of the `[]` TS would otherwise infer from a zero-arg mock body.
  write: vi.fn(async (_name: string, _source: string) => ({ ok: true as const })),
  ...overrides,
});

describe('grantsFor', () => {
  it('returns the tool for an unconsumed allow-once and marks it consumed', () => {
    const d = deps([ask('a1', 'drone', RUNGS), answer('n1', 'a1', 'allow-once')]);
    expect(createPermissions(d).grantsFor('drone')).toEqual(['Bash']);
    expect(d.append).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'event',
        to: 'drone',
        thread: 'a1',
        meta: expect.objectContaining({ granted: 'a1' }),
      }),
    );
  });

  it('does not return a grant that was already consumed', () => {
    const d = deps([
      ask('a1', 'drone', RUNGS),
      answer('n1', 'a1', 'allow-once'),
      { id: 'e1', ts: 3, from: 'overmind', kind: 'event', meta: { granted: 'a1' } },
    ]);
    expect(createPermissions(d).grantsFor('drone')).toEqual([]);
    expect(d.append).not.toHaveBeenCalled();
  });

  it('ignores another agent\'s grants, and unanswered asks', () => {
    const d = deps([
      ask('a1', 'other', RUNGS), answer('n1', 'a1', 'allow-once'),
      ask('a2', 'drone', RUNGS),
    ]);
    expect(createPermissions(d).grantsFor('drone')).toEqual([]);
  });

  it('ignores a permanent answer, which took the other road', () => {
    const d = deps([ask('a1', 'drone', RUNGS), answer('n1', 'a1', 'allow-family')]);
    expect(createPermissions(d).grantsFor('drone')).toEqual([]);
  });
});

describe('isPermissionAnswer', () => {
  it('is true for an answer to a permission ask', () => {
    const d = deps([ask('a1', 'drone', RUNGS)]);
    expect(
      createPermissions(d).isPermissionAnswer(answer('n1', 'a1', 'allow-family') as never),
    ).toBe(true);
  });

  it('is false for an answer to an ordinary ask', () => {
    const ordinary = {
      id: 'o1', ts: 1, from: 'drone', to: 'overmind', kind: 'ask' as const,
      body: 'may I have a review?',
    };
    const d = deps([ordinary]);
    expect(
      createPermissions(d).isPermissionAnswer(answer('n1', 'o1', 'sure') as never),
    ).toBe(false);
  });

  it('is false for a non-answer entry', () => {
    const d = deps([ask('a1', 'drone', RUNGS)]);
    expect(
      createPermissions(d).isPermissionAnswer(ask('a1', 'drone', RUNGS) as never),
    ).toBe(false);
  });
});

describe('onAnswer', () => {
  it('appends the family rule to tools: and records it', async () => {
    const d = deps([ask('a1', 'drone', RUNGS)]);
    await createPermissions(d).onAnswer(answer('n1', 'a1', 'allow-family') as never);

    expect(d.write).toHaveBeenCalledWith('drone', expect.stringContaining('Bash(git *)'));
    expect(d.write.mock.calls[0]![1]).toContain('Read');
    expect(d.append).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'drone',
        thread: 'a1',
        body: 'granted Bash(git *) to drone',
        meta: expect.objectContaining({ granted: 'a1', rule: 'Bash(git *)' }),
      }),
    );
  });

  it('writes the bare tool for allow-tool', async () => {
    const d = deps([ask('a1', 'drone', RUNGS)]);
    await createPermissions(d).onAnswer(answer('n1', 'a1', 'allow-tool') as never);
    expect(d.write.mock.calls[0]![1]).toMatch(/tools:.*\bBash\b/);
  });

  it('writes nothing for allow-once or deny', async () => {
    for (const body of ['allow-once', 'deny']) {
      const d = deps([ask('a1', 'drone', RUNGS)]);
      await createPermissions(d).onAnswer(answer('n1', 'a1', body) as never);
      expect(d.write).not.toHaveBeenCalled();
    }
  });

  it('is a no-op when the rule is already granted', async () => {
    const d = deps([ask('a1', 'drone', RUNGS)], {
      read: vi.fn(async () => '---\nname: drone\ntools: [Read, Bash(git *)]\n---\n\nBody.\n'),
    });
    await createPermissions(d).onAnswer(answer('n1', 'a1', 'allow-family') as never);
    expect(d.write).not.toHaveBeenCalled();
    expect(d.append).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'drone',
        thread: 'a1',
        meta: expect.objectContaining({ granted: 'a1' }),
      }),
    );
  });

  it('records a refusal rather than swallowing it', async () => {
    const d = deps([ask('a1', 'drone', RUNGS)], {
      write: vi.fn(async () => ({ ok: false as const, problems: [{ field: 'tools', reason: 'bad' }] })),
    });
    await createPermissions(d).onAnswer(answer('n1', 'a1', 'allow-family') as never);
    expect(d.append).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'drone',
        thread: 'a1',
        body: 'could not grant Bash(git *) to drone: bad',
        meta: expect.objectContaining({ grantFailed: 'a1' }),
      }),
    );
  });

  it('records a refusal, with to/thread, when there is no definition on disk', async () => {
    const d = deps([ask('a1', 'drone', RUNGS)], {
      read: vi.fn(async () => null),
    });
    await createPermissions(d).onAnswer(answer('n1', 'a1', 'allow-family') as never);
    expect(d.write).not.toHaveBeenCalled();
    expect(d.append).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'drone',
        thread: 'a1',
        body: 'could not grant Bash(git *) to drone: no definition',
        meta: expect.objectContaining({ grantFailed: 'a1' }),
      }),
    );
  });

  it('refuses a rung the ask never offered, and records the refusal', async () => {
    const d = deps([ask('a1', 'drone', RUNGS)]);
    await createPermissions(d).onAnswer(answer('n1', 'a1', 'allow-everything') as never);
    expect(d.write).not.toHaveBeenCalled();
    expect(d.append).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'drone',
        thread: 'a1',
        meta: expect.objectContaining({ grantFailed: 'a1' }),
      }),
    );
  });

  it('refuses when the ask\'s own rungs are unreadable, and records the refusal', async () => {
    const d = deps([ask('a1', 'drone', 'not-an-array')]);
    await createPermissions(d).onAnswer(answer('n1', 'a1', 'allow-family') as never);
    expect(d.write).not.toHaveBeenCalled();
    expect(d.append).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'drone',
        thread: 'a1',
        meta: expect.objectContaining({ grantFailed: 'a1' }),
      }),
    );
  });

  it('preserves existing tools when the source has a trailing comment on tools:', async () => {
    const d = deps([ask('a1', 'drone', RUNGS)], {
      read: vi.fn(async () => '---\nname: drone\ntools: [Read, Grep]        # narrow set\n---\n\nBody.\n'),
    });
    await createPermissions(d).onAnswer(answer('n1', 'a1', 'allow-family') as never);

    const written = d.write.mock.calls[0]![1];
    expect(written).toContain('Read');
    expect(written).toContain('Grep');
    expect(written).toContain('Bash(git *)');
  });
});

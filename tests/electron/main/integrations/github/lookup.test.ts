// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { PrRecord } from '../../../../../electron/shared/github-contract';
import { lookupPr } from '../../../../../electron/main/integrations/github/lookup';

const record = (over: Partial<PrRecord> = {}): PrRecord => ({
  number: 214,
  title: 'feat: a thing',
  url: 'https://github.com/acme/the-hive/pull/214',
  repo: 'the-hive',
  owner: 'acme',
  branch: 'feat/thing',
  state: 'open',
  findings: 2,
  checks: 'passing',
  updatedAt: '2026-09-11T10:00:00Z',
  ...over,
});

describe('lookupPr (HIVE-173)', () => {
  const sweep = { ok: true as const, value: { prs: [record(), record({ number: 9, owner: 'other' })], repos: 2 } };

  it('finds the record by number and whole slug, case-insensitively', () => {
    expect(lookupPr(sweep, { repo: 'Acme/The-Hive', number: 214 })).toEqual({ pr: record() });
    expect(lookupPr(sweep, { repo: 'other/the-hive', number: 9 })).toEqual({ pr: record({ number: 9, owner: 'other' }) });
  });

  it('answers no record with a reason for another owner, another number, or a failed sweep', () => {
    expect(lookupPr(sweep, { repo: 'other/the-hive', number: 214 })).toEqual({
      pr: null,
      reason: 'other/the-hive#214 is not in the sweep of 2 configured repositories',
    });
    expect(lookupPr({ ...sweep, value: { ...sweep.value, repos: 1 } }, { repo: 'acme/the-hive', number: 1 }).reason).toMatch(/1 configured repository$/);
    expect(
      lookupPr({ ok: false, error: { kind: 'not-installed', message: 'GitHub CLI (`gh`) was not found on this machine.' } }, { repo: 'acme/the-hive', number: 214 }),
    ).toEqual({ pr: null, reason: 'GitHub CLI (`gh`) was not found on this machine.' });
  });
});

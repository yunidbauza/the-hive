import type { PrRecord } from '@shared/github-contract';

/**
 * A PR as it crosses IPC, with every field defaulted.
 *
 * The fixtures this replaces used to supply these rows to the app itself, which
 * is exactly the problem — they showed up in the product. Here they are what
 * they always should have been: a builder in `tests/support/`, so a test can
 * say what it is about (`prRecord({ state: 'merged' })`) instead of restating
 * ten fields it does not care about.
 */
export function prRecord(overrides: Partial<PrRecord> = {}): PrRecord {
  return {
    number: 482,
    title: 'Hero: semantic token refactor',
    url: 'https://github.com/acme/apfm-web/pull/482',
    repo: 'apfm-web',
    owner: 'acme',
    branch: 'feat/hero-refresh',
    state: 'open',
    findings: 2,
    checks: 'passing',
    updatedAt: '2026-08-09T12:00:00Z',
    ...overrides,
  };
}

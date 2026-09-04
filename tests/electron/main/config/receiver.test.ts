// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../../../electron/main/config/parse';
import { DEFAULT_RECEIVER } from '../../../../electron/shared/config-contract';

/**
 * The receiver block's defaulting (HIVE-131).
 *
 * `ConfigSnapshot.receiver` is documented as always fully resolved, so the
 * contract under test is that a file naming nothing still answers with the
 * default — the same guarantee `jira.test.ts` makes for its block. The spread
 * here is the one `loadConfig` and `writeConfig` both perform; asserting it
 * against the parser's output is what proves the two agree.
 */

const resolved = (parsed: { receiver?: { hostAlias?: string } }) => ({
  ...DEFAULT_RECEIVER,
  ...parsed.receiver,
});

const doc = (extra: object) =>
  JSON.stringify({ version: 2, projects: [], ...extra });

describe('receiver resolution', () => {
  it('defaults to the Docker Desktop alias', () => {
    expect(DEFAULT_RECEIVER.hostAlias).toBe('host.docker.internal');
  });

  it('a file with no block resolves to the default', () => {
    expect(resolved(parseConfig(doc({}), 'config'))).toEqual({
      hostAlias: 'host.docker.internal',
    });
  });

  it('a file naming an alias overrides the default', () => {
    const parsed = parseConfig(
      doc({ receiver: { hostAlias: 'host.containers.internal' } }),
      'config',
    );

    expect(resolved(parsed)).toEqual({ hostAlias: 'host.containers.internal' });
  });

  it('a rejected alias falls back to the default rather than an empty string', () => {
    const parsed = parseConfig(doc({ receiver: { hostAlias: '' } }), 'config');

    expect(resolved(parsed)).toEqual({ hostAlias: 'host.docker.internal' });
  });

  it('a dropped block falls back to the default', () => {
    const parsed = parseConfig(doc({ receiver: 'nope' }), 'config');

    expect(resolved(parsed)).toEqual({ hostAlias: 'host.docker.internal' });
  });

  it('a version 1 file still loads and gets the default', () => {
    const parsed = parseConfig(
      JSON.stringify({ version: 1, projects: [{ id: 'a', path: '~/a' }] }),
      'config',
    );

    expect(parsed.fatal).toBe(false);
    expect(resolved(parsed)).toEqual({ hostAlias: 'host.docker.internal' });
  });
});

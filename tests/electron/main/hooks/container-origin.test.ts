// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { withHostAlias } from '../../../../electron/main/hooks/container-origin';

/**
 * The container substitution (HIVE-131).
 *
 * A pure string transform, so these tests need no server and no config. The
 * bare-origin case is the one that matters most: `HIVE_RECEIVER_URL` carries an
 * origin with no path, and `mcp-host/host.ts:52` appends its own paths to it, so
 * a gained trailing slash would produce `…//ledger` and 404 every ledger call.
 */

describe('withHostAlias', () => {
  it('swaps the host of a bare origin and gains no trailing slash', () => {
    expect(withHostAlias('http://127.0.0.1:63999', 'host.docker.internal')).toBe(
      'http://host.docker.internal:63999',
    );
  });

  it('keeps the port and the path', () => {
    expect(
      withHostAlias(
        'http://127.0.0.1:63999/hook/metrics',
        'host.docker.internal',
      ),
    ).toBe('http://host.docker.internal:63999/hook/metrics');
  });

  it('keeps a query and a fragment', () => {
    expect(withHostAlias('http://127.0.0.1:80/a?b=1#c', 'alias')).toBe(
      'http://alias:80/a?b=1#c',
    );
  });

  it('handles a URL with no port', () => {
    expect(withHostAlias('http://127.0.0.1/hook', 'alias')).toBe(
      'http://alias/hook',
    );
  });

  it('accepts https as well as http', () => {
    expect(withHostAlias('https://127.0.0.1:8443/x', 'alias')).toBe(
      'https://alias:8443/x',
    );
  });

  it('returns a non-URL unchanged rather than throwing', () => {
    expect(withHostAlias('not a url', 'alias')).toBe('not a url');
    expect(withHostAlias('', 'alias')).toBe('');
  });
});

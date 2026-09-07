// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfig, setReceiver } from '../../../../electron/main/config';
import { parseConfig } from '../../../../electron/main/config/parse';
import {
  CONFIG_PATH_ENV,
  DEFAULT_BIND,
  DEFAULT_RECEIVER,
} from '../../../../electron/shared/config-contract';

/**
 * The receiver block's defaulting (HIVE-131).
 *
 * `ConfigSnapshot.receiver` is documented as always fully resolved, so the
 * contract under test is that a file naming nothing still answers with the
 * default — the same guarantee `jira.test.ts` makes for its block. The spread
 * here is the one `loadConfig` and `writeConfig` both perform; asserting it
 * against the parser's output is what proves the two agree.
 */

const resolved = (parsed: {
  receiver?: {
    hostAlias?: string;
    bind?: { host?: string; port?: number; allowedOrigins?: readonly string[] };
  };
}) => ({
  ...DEFAULT_RECEIVER,
  ...parsed.receiver,
  bind: { ...DEFAULT_BIND, ...parsed.receiver?.bind },
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
      bind: DEFAULT_BIND,
    });
  });

  it('a file naming an alias overrides the default', () => {
    const parsed = parseConfig(
      doc({ receiver: { hostAlias: 'host.containers.internal' } }),
      'config',
    );

    expect(resolved(parsed)).toEqual({
      hostAlias: 'host.containers.internal',
      bind: DEFAULT_BIND,
    });
  });

  it('a rejected alias falls back to the default rather than an empty string', () => {
    const parsed = parseConfig(doc({ receiver: { hostAlias: '' } }), 'config');

    expect(resolved(parsed)).toEqual({ hostAlias: 'host.docker.internal', bind: DEFAULT_BIND });
  });

  it('a dropped block falls back to the default', () => {
    const parsed = parseConfig(doc({ receiver: 'nope' }), 'config');

    expect(resolved(parsed)).toEqual({ hostAlias: 'host.docker.internal', bind: DEFAULT_BIND });
  });

  it('a version 1 file still loads and gets the default', () => {
    const parsed = parseConfig(
      JSON.stringify({ version: 1, projects: [{ id: 'a', path: '~/a' }] }),
      'config',
    );

    expect(parsed.fatal).toBe(false);
    expect(resolved(parsed)).toEqual({ hostAlias: 'host.docker.internal', bind: DEFAULT_BIND });
  });
});

/**
 * HIVE-134's nested `bind` block, read but not yet resolved — that is Task 3.
 * `parsed.receiver?.bind` is `optionalBind`'s raw, per-field-salvaged output;
 * `resolved(parsed).bind` is what the block becomes once `DEFAULT_BIND` is
 * merged under it, which is the only way to see a dropped field's fallback
 * from this layer.
 */
describe('the bind block', () => {
  it('defaults to loopback when the file names no bind', () => {
    const parsed = parseConfig(doc({ receiver: { hostAlias: 'gateway' } }), 'config');

    expect(resolved(parsed).bind).toEqual(DEFAULT_BIND);
    expect(parsed.fatal).toBe(false);
  });

  /* The acceptance criterion a hand-written bind used to fail. */
  it('no longer calls a hand-written bind an unknown key', () => {
    const parsed = parseConfig(
      doc({
        receiver: {
          bind: {
            host: '172.17.0.1',
            port: 63999,
            allowedOrigins: ['http://localhost:5173'],
          },
        },
      }),
      'config',
    );

    expect(parsed.receiver?.bind).toEqual({
      host: '172.17.0.1',
      port: 63999,
      allowedOrigins: ['http://localhost:5173'],
    });
    expect(parsed.errors).toEqual([]);
  });

  it('reports an unknown key inside bind without losing the block', () => {
    const parsed = parseConfig(
      doc({ receiver: { bind: { host: '172.17.0.1', enabled: true } } }),
      'config',
    );

    expect(parsed.receiver?.bind?.host).toBe('172.17.0.1');
    expect(parsed.errors.join(' ')).toContain('unknown key "enabled"');
  });

  /*
    Per-field salvage, the discipline `optionalNotifications` uses: one bad
    field is no reason to silently restore the default for the other two, which
    is a change the user did not make and would not see.
  */
  it('keeps the good fields when one is wrong', () => {
    const parsed = parseConfig(
      doc({ receiver: { bind: { host: '10.0.0.5?', port: 63999 } } }),
      'config',
    );

    expect(resolved(parsed).bind.host).toBe('127.0.0.1');
    expect(resolved(parsed).bind.port).toBe(63999);
    expect(parsed.errors.join(' ')).toContain('receiver.bind.host');
  });

  it('refuses a port outside the range and an origin that is not one', () => {
    const parsed = parseConfig(
      doc({
        receiver: { bind: { port: 70000, allowedOrigins: ['http://ok.test', 'nope'] } },
      }),
      'config',
    );

    expect(resolved(parsed).bind.port).toBe(0);
    // A bad entry costs that entry, not the list — `commanders`' rule.
    expect(resolved(parsed).bind.allowedOrigins).toEqual(['http://ok.test']);
    expect(parsed.errors.join(' ')).toContain('receiver.bind.port');
    expect(parsed.errors.join(' ')).toContain('receiver.bind.allowedOrigins[1]');
  });

  it('drops a bind that is not an object', () => {
    const parsed = parseConfig(doc({ receiver: { bind: '172.17.0.1' } }), 'config');

    expect(resolved(parsed).bind).toEqual(DEFAULT_BIND);
    expect(parsed.errors.join(' ')).toContain('receiver.bind: expected an object');
    expect(parsed.fatal).toBe(false);
  });
});

/**
 * The writer, tested against real files — because every property worth proving
 * here is a property of the *file*, the way `jira.test.ts` argues it.
 *
 * The sibling-key case is the one that matters most and that the e2e cannot
 * reach: `setReceiver`'s doc comment promises that a key this build has not
 * heard of survives a save, and the deferred opt-in `bind` block is exactly
 * that key. A user who hand-writes it before the follow-up story ships must not
 * lose it the first time they touch the alias field.
 */

const originalConfigPath = process.env[CONFIG_PATH_ENV];
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-receiver-'));
  path = join(dir, 'config.json');
  process.env[CONFIG_PATH_ENV] = path;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
  else process.env[CONFIG_PATH_ENV] = originalConfigPath;
});

const seed = (text: string): void => {
  writeFileSync(path, text);
  reloadConfig();
};

const onDisk = (): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

describe('setReceiver', () => {
  it('creates the block on a file that has none', () => {
    seed('{\n  "version": 2\n}\n');

    const snapshot = setReceiver({ hostAlias: 'host.containers.internal' });

    expect(snapshot.receiver).toEqual({
      hostAlias: 'host.containers.internal',
      bind: DEFAULT_BIND,
    });
    expect(onDisk().receiver).toEqual({ hostAlias: 'host.containers.internal' });
  });

  it('leaves the key absent until something is actually set', () => {
    seed('{\n  "version": 2\n}\n');

    // Reading is not writing: the default is applied in memory only.
    expect(onDisk().receiver).toBeUndefined();
  });

  /**
   * The promise `setReceiver`'s doc comment makes, and the reason it spreads the
   * block rather than rebuilding it.
   */
  it('preserves a sibling key this build does not know', () => {
    seed(
      '{\n  "version": 2,\n  "receiver": { "hostAlias": "gateway", "bind": { "host": "0.0.0.0" } }\n}\n',
    );

    setReceiver({ hostAlias: 'host.docker.internal' });

    expect(onDisk().receiver).toEqual({
      hostAlias: 'host.docker.internal',
      bind: { host: '0.0.0.0' },
    });
  });

  it('preserves unrelated top-level keys and hand-written comments', () => {
    seed(
      '{\n  "//mine": "a comment",\n  "version": 2,\n  "futureKey": "unknown",\n  "receiver": { "hostAlias": "gateway" }\n}\n',
    );

    setReceiver({ hostAlias: 'host.docker.internal' });

    const after = onDisk();
    expect(after['//mine']).toBe('a comment');
    expect(after.futureKey).toBe('unknown');
    expect(after.receiver).toEqual({ hostAlias: 'host.docker.internal' });
  });

  /**
   * A block the reader already complained about is replaced rather than merged
   * into — merging onto a string would produce something neither the user nor
   * the parser meant.
   */
  it('replaces a non-object block rather than merging into it', () => {
    seed('{\n  "version": 2,\n  "receiver": "nope"\n}\n');

    setReceiver({ hostAlias: 'gateway' });

    expect(onDisk().receiver).toEqual({ hostAlias: 'gateway' });
  });
});

describe('setReceiver and the bind block', () => {
  it('creates a bind on a file that has none', () => {
    seed('{\n  "version": 2\n}\n');

    const snapshot = setReceiver({ bind: { host: '172.17.0.1' } });

    // Resolved in memory…
    expect(snapshot.receiver.bind).toEqual({
      host: '172.17.0.1',
      port: 0,
      allowedOrigins: [],
    });
    // …but only what was asked for is written.
    expect(onDisk().receiver).toEqual({ bind: { host: '172.17.0.1' } });
  });

  it('merges into an existing bind rather than replacing it', () => {
    seed(
      '{\n  "version": 2,\n  "receiver": { "bind": { "host": "172.17.0.1", "port": 63999 } }\n}\n',
    );

    setReceiver({ bind: { allowedOrigins: ['http://localhost:5173'] } });

    expect(onDisk().receiver).toEqual({
      bind: {
        host: '172.17.0.1',
        port: 63999,
        allowedOrigins: ['http://localhost:5173'],
      },
    });
  });

  it('leaves the bind alone when only the alias is set', () => {
    seed('{\n  "version": 2,\n  "receiver": { "bind": { "host": "172.17.0.1" } }\n}\n');

    setReceiver({ hostAlias: 'host.containers.internal' });

    expect(onDisk().receiver).toEqual({
      hostAlias: 'host.containers.internal',
      bind: { host: '172.17.0.1' },
    });
  });

  /* The retreat the Settings switch takes when it is turned off. */
  it('writes loopback back over an exposed bind', () => {
    seed('{\n  "version": 2,\n  "receiver": { "bind": { "host": "172.17.0.1" } }\n}\n');

    const snapshot = setReceiver({ bind: { host: '127.0.0.1' } });

    expect(snapshot.receiver.bind.host).toBe('127.0.0.1');
    expect(onDisk().receiver).toEqual({ bind: { host: '127.0.0.1' } });
  });

  it('preserves a sibling inside bind that this build does not know', () => {
    seed(
      '{\n  "version": 2,\n  "receiver": { "bind": { "host": "172.17.0.1", "futureKey": 1 } }\n}\n',
    );

    setReceiver({ bind: { port: 63999 } });

    expect(onDisk().receiver).toEqual({
      bind: { host: '172.17.0.1', futureKey: 1, port: 63999 },
    });
  });
});

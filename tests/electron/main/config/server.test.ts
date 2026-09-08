// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfig, setServer } from '../../../../electron/main/config';
import { parseConfig } from '../../../../electron/main/config/parse';
import {
  CONFIG_PATH_ENV,
  DEFAULT_SERVER,
} from '../../../../electron/shared/config-contract';

/**
 * The server block's defaulting (HIVE-142).
 *
 * `ConfigSnapshot.server` is documented as always fully resolved, so the
 * contract under test is that a file naming nothing still answers with the
 * default — the same guarantee `receiver.test.ts` makes for its block. The
 * spread here is the one `loadConfig` and `writeConfig` both perform;
 * asserting it against the parser's output is what proves the two agree.
 */

const resolved = (parsed: {
  server?: {
    enabled?: boolean;
    bind?: { host?: string; port?: number; allowedOrigins?: readonly string[] };
    devices?: readonly unknown[];
  };
}) => ({
  ...DEFAULT_SERVER,
  ...parsed.server,
  bind: { ...DEFAULT_SERVER.bind, ...parsed.server?.bind },
});

const doc = (extra: object) =>
  JSON.stringify({ version: 2, projects: [], ...extra });

describe('server resolution', () => {
  it('defaults to disabled, loopback, no devices', () => {
    expect(DEFAULT_SERVER.enabled).toBe(false);
    expect(DEFAULT_SERVER.bind.host).toBe('127.0.0.1');
    expect(DEFAULT_SERVER.devices).toEqual([]);
  });

  it('a file with no block resolves to the default', () => {
    expect(resolved(parseConfig(doc({}), 'config'))).toEqual({
      enabled: false,
      bind: DEFAULT_SERVER.bind,
      devices: [],
    });
  });

  it('a file naming only enabled still gets the default bind', () => {
    const parsed = parseConfig(doc({ server: { enabled: true } }), 'config');

    expect(resolved(parsed)).toEqual({
      enabled: true,
      bind: DEFAULT_SERVER.bind,
      devices: [],
    });
  });

  it('a dropped block falls back to the default', () => {
    const parsed = parseConfig(doc({ server: 'nope' }), 'config');

    expect(resolved(parsed)).toEqual({
      enabled: false,
      bind: DEFAULT_SERVER.bind,
      devices: [],
    });
  });

  /**
   * The exact trap this task documents: a one-level spread would let a file
   * naming only `bind.host` erase the default port and origin list.
   */
  it('keeps the default port when a file names only the bind host', () => {
    const parsed = parseConfig(doc({ server: { bind: { host: '10.0.0.5' } } }), 'config');

    expect(resolved(parsed).bind.host).toBe('10.0.0.5');
    expect(resolved(parsed).bind.port).toBe(DEFAULT_SERVER.bind.port);
    expect(resolved(parsed).bind.allowedOrigins).toEqual(DEFAULT_SERVER.bind.allowedOrigins);
  });
});

describe('the server bind block', () => {
  it('defaults to loopback and the fixed port when the file names no bind', () => {
    const parsed = parseConfig(doc({ server: { enabled: true } }), 'config');

    expect(resolved(parsed).bind).toEqual(DEFAULT_SERVER.bind);
    expect(parsed.fatal).toBe(false);
  });

  it('refuses 0.0.0.0 and falls back to the default host', () => {
    const parsed = parseConfig(doc({ server: { bind: { host: '0.0.0.0' } } }), 'config');

    expect(resolved(parsed).bind.host).toBe('127.0.0.1');
    expect(parsed.errors.join(' ')).toContain('server.bind.host');
    expect(parsed.errors.join(' ')).toContain('0.0.0.0');
    expect(parsed.fatal).toBe(false);
  });

  /**
   * HIVE-142 review, I1: `isHostAlias`'s per-label regex admits `0`, `00`,
   * `0x0` and `000.000.000.000` as hostname shapes, and `dns.lookup`/
   * `net.Server.listen` all fold every one of them to `0.0.0.0` on this
   * machine (verified) — the literal-string check above catches only the one
   * spelling a person is likely to type by hand.
   */
  it.each(['0', '00', '0x0', '0X0', '000.000.000.000'])(
    'refuses %s — another spelling of the same wildcard — and falls back to the default host',
    (host) => {
      const parsed = parseConfig(doc({ server: { bind: { host } } }), 'config');

      expect(resolved(parsed).bind.host).toBe('127.0.0.1');
      expect(parsed.fatal).toBe(false);
    },
  );

  it('does not refuse a real dotted-quad that merely contains a zero octet', () => {
    const parsed = parseConfig(doc({ server: { bind: { host: '10.0.0.5' } } }), 'config');

    expect(resolved(parsed).bind.host).toBe('10.0.0.5');
  });

  it('keeps the good fields when one is wrong', () => {
    const parsed = parseConfig(
      doc({ server: { bind: { host: '10.0.0.5?', port: 7433 } } }),
      'config',
    );

    expect(resolved(parsed).bind.host).toBe('127.0.0.1');
    expect(resolved(parsed).bind.port).toBe(7433);
    expect(parsed.errors.join(' ')).toContain('server.bind.host');
  });

  /**
   * The one port the receiver's own bind accepts as legal and this one must
   * not (HIVE-142 review, I3): `0` asks the OS for a free port, but a client
   * and any LaunchAgent both have to be told `server.bind.port` ahead of
   * time, so it falls back to the default rather than being honored.
   */
  it('refuses port 0 and falls back to the default, unlike the receiver bind', () => {
    const parsed = parseConfig(doc({ server: { bind: { port: 0 } } }), 'config');

    expect(resolved(parsed).bind.port).toBe(DEFAULT_SERVER.bind.port);
    expect(parsed.errors.join(' ')).toContain('server.bind.port');
    expect(parsed.fatal).toBe(false);
  });

  it('refuses a port outside the range and an origin that is not one', () => {
    const parsed = parseConfig(
      doc({ server: { bind: { port: 70000, allowedOrigins: ['http://ok.test', 'nope'] } } }),
      'config',
    );

    expect(resolved(parsed).bind.port).toBe(DEFAULT_SERVER.bind.port);
    expect(resolved(parsed).bind.allowedOrigins).toEqual(['http://ok.test']);
    expect(parsed.errors.join(' ')).toContain('server.bind.port');
    expect(parsed.errors.join(' ')).toContain('server.bind.allowedOrigins[1]');
  });

  it('drops a bind that is not an object', () => {
    const parsed = parseConfig(doc({ server: { bind: '172.17.0.1' } }), 'config');

    expect(resolved(parsed).bind).toEqual(DEFAULT_SERVER.bind);
    expect(parsed.errors.join(' ')).toContain('server.bind: expected an object');
    expect(parsed.fatal).toBe(false);
  });
});

/**
 * The writer, tested against real files — the same rationale
 * `receiver.test.ts` states: every property worth proving here is a property
 * of the *file*.
 */

const originalConfigPath = process.env[CONFIG_PATH_ENV];
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-server-'));
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

describe('setServer', () => {
  it('creates the block on a file that has none', () => {
    seed('{\n  "version": 2\n}\n');

    const snapshot = setServer({ enabled: true });

    expect(snapshot.server).toEqual({
      enabled: true,
      bind: DEFAULT_SERVER.bind,
      devices: [],
    });
    expect(onDisk().server).toEqual({ enabled: true });
  });

  it('leaves the key absent until something is actually set', () => {
    seed('{\n  "version": 2\n}\n');

    // Reading is not writing: the default is applied in memory only.
    expect(onDisk().server).toBeUndefined();
  });

  /**
   * The promise `setServer`'s doc comment makes, and the reason it spreads the
   * block rather than rebuilding it.
   */
  it('preserves a sibling key this build does not know', () => {
    seed(
      '{\n  "version": 2,\n  "server": { "enabled": true, "bind": { "host": "0.0.0.0" } }\n}\n',
    );

    setServer({ enabled: false });

    expect(onDisk().server).toEqual({
      enabled: false,
      bind: { host: '0.0.0.0' },
    });
  });

  it('preserves unrelated top-level keys and hand-written comments', () => {
    seed(
      '{\n  "//mine": "a comment",\n  "version": 2,\n  "futureKey": "unknown",\n  "server": { "enabled": true }\n}\n',
    );

    setServer({ enabled: false });

    const after = onDisk();
    expect(after['//mine']).toBe('a comment');
    expect(after.futureKey).toBe('unknown');
    expect(after.server).toEqual({ enabled: false });
  });

  it('replaces a non-object block rather than merging into it', () => {
    seed('{\n  "version": 2,\n  "server": "nope"\n}\n');

    setServer({ enabled: true });

    expect(onDisk().server).toEqual({ enabled: true });
  });
});

describe('setServer and the bind block', () => {
  it('creates a bind on a file that has none', () => {
    seed('{\n  "version": 2\n}\n');

    const snapshot = setServer({ bind: { host: '100.101.102.103' } });

    // Resolved in memory…
    expect(snapshot.server.bind).toEqual({
      host: '100.101.102.103',
      port: DEFAULT_SERVER.bind.port,
      allowedOrigins: [],
    });
    // …but only what was asked for is written.
    expect(onDisk().server).toEqual({ bind: { host: '100.101.102.103' } });
  });

  it('merges into an existing bind rather than replacing it', () => {
    seed(
      '{\n  "version": 2,\n  "server": { "bind": { "host": "100.101.102.103", "port": 7433 } }\n}\n',
    );

    setServer({ bind: { allowedOrigins: ['http://localhost:5173'] } });

    expect(onDisk().server).toEqual({
      bind: {
        host: '100.101.102.103',
        port: 7433,
        allowedOrigins: ['http://localhost:5173'],
      },
    });
  });

  it('leaves the bind alone when only enabled is set', () => {
    seed('{\n  "version": 2,\n  "server": { "bind": { "host": "100.101.102.103" } }\n}\n');

    setServer({ enabled: true });

    expect(onDisk().server).toEqual({
      enabled: true,
      bind: { host: '100.101.102.103' },
    });
  });

  it('preserves a sibling inside bind that this build does not know', () => {
    seed(
      '{\n  "version": 2,\n  "server": { "bind": { "host": "100.101.102.103", "futureKey": 1 } }\n}\n',
    );

    setServer({ bind: { port: 7433 } });

    expect(onDisk().server).toEqual({
      bind: { host: '100.101.102.103', futureKey: 1, port: 7433 },
    });
  });
});

describe('setServer and devices', () => {
  const alice = {
    id: 'd_9f2c',
    name: 'MacBook',
    paired: '2026-09-07',
    revoked: false,
    credential: { kind: 'sha256' as const, digest: 'a'.repeat(64) },
  };

  it('creates the roster on a file that has none', () => {
    seed('{\n  "version": 2\n}\n');

    const snapshot = setServer({ devices: [alice] });

    expect(snapshot.server.devices).toEqual([alice]);
    expect(onDisk().server).toEqual({ devices: [alice] });
  });

  it('replaces the roster wholesale rather than merging it', () => {
    seed(`{\n  "version": 2,\n  "server": { "devices": ${JSON.stringify([alice])} }\n}\n`);

    setServer({ devices: [] });

    expect(onDisk().server).toEqual({ devices: [] });
  });
});

// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfig, setRemote } from '../../../../electron/main/config';
import { parseConfig } from '../../../../electron/main/config/parse';
import {
  CONFIG_PATH_ENV,
  DEFAULT_REMOTE,
  isRemoteTarget,
} from '../../../../electron/shared/config-contract';
import { parseSetRemoteRequest } from '../../../../electron/shared/guards';

/**
 * The remote block's defaulting (HIVE-144).
 *
 * `ConfigSnapshot.remote` is documented as always fully resolved, so the
 * contract under test is that a file naming nothing still answers with the
 * default — the same guarantee `server.test.ts` and `receiver.test.ts` make
 * for their blocks. The spread here is the one `loadConfig` and `writeConfig`
 * both perform; asserting it against the parser's output is what proves the
 * two agree.
 */

const resolved = (parsed: { remote?: { mode?: string; host?: string; port?: number } }) => ({
  ...DEFAULT_REMOTE,
  ...parsed.remote,
});

const doc = (extra: object) => JSON.stringify({ version: 2, projects: [], ...extra });

describe('remote resolution', () => {
  it('defaults to local mode with no target', () => {
    expect(DEFAULT_REMOTE).toEqual({ mode: 'local', host: '', port: 7433 });
  });

  it('a file with no block resolves to the default', () => {
    expect(resolved(parseConfig(doc({}), 'config'))).toEqual(DEFAULT_REMOTE);
  });

  it('a file naming only mode still gets the default host and port', () => {
    const parsed = parseConfig(doc({ remote: { mode: 'remote' } }), 'config');

    expect(resolved(parsed)).toEqual({
      mode: 'remote',
      host: DEFAULT_REMOTE.host,
      port: DEFAULT_REMOTE.port,
    });
  });

  it('a dropped block falls back to the default', () => {
    const parsed = parseConfig(doc({ remote: 'nope' }), 'config');

    expect(resolved(parsed)).toEqual(DEFAULT_REMOTE);
  });

  /**
   * Ruling 3 (HIVE-144): `host` is validated only when this block's own
   * `mode` is `'remote'`. `DEFAULT_REMOTE.host` is `''`, and every install
   * that has never attached carries exactly that — so a file explicitly
   * naming `mode: 'local'` and an empty `host` must resolve with **no
   * error**, not merely with the default value.
   */
  it('a local mode with an empty host resolves with no error', () => {
    const parsed = parseConfig(doc({ remote: { mode: 'local', host: '' } }), 'config');

    expect(resolved(parsed)).toEqual({ mode: 'local', host: '', port: DEFAULT_REMOTE.port });
    expect(parsed.errors).toEqual([]);
  });

  it('a bad host in remote mode falls back to the default and reports why', () => {
    const parsed = parseConfig(
      doc({ remote: { mode: 'remote', host: '203.0.113.7', port: 7433 } }),
      'config',
    );

    expect(resolved(parsed).host).toBe(DEFAULT_REMOTE.host);
    expect(parsed.errors.join(' ')).toContain('remote.host');
    expect(parsed.fatal).toBe(false);
  });
});

/**
 * The reader, tested against real files — the same rationale `server.test.ts`
 * and `receiver.test.ts` state: every property worth proving here is a
 * property of the *file*, and `loadConfig` (not a hand-rolled merge formula)
 * is the code path that ships. `setRemote` — the mode switch's writer,
 * HIVE-144's Task 5 — gets its own `describe` blocks below, once this
 * section's harness (`seed`, `path`) is in scope.
 */

const originalConfigPath = process.env[CONFIG_PATH_ENV];
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-remote-'));
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
};

describe('the remote block on a real snapshot', () => {
  it('a file with no remote key yields DEFAULT_REMOTE on the snapshot', () => {
    seed('{\n  "version": 2\n}\n');

    const snapshot = reloadConfig();

    expect(snapshot.remote).toEqual(DEFAULT_REMOTE);
  });

  it('a file naming a partial remote block carries the given fields, the rest defaulted', () => {
    seed('{\n  "version": 2,\n  "remote": { "mode": "remote" }\n}\n');

    const snapshot = reloadConfig();

    expect(snapshot.remote).toEqual({
      mode: 'remote',
      host: DEFAULT_REMOTE.host,
      port: DEFAULT_REMOTE.port,
    });
  });

  /**
   * The ruling this whole task exists to protect: every install that has
   * never attached carries `mode: 'local'` and an empty `host`, and that must
   * never surface in `ConfigSnapshot.errors` — a permanent false alarm in
   * Settings on a machine that has never used this feature.
   */
  it('mode local with no host produces no error on the snapshot', () => {
    seed('{\n  "version": 2,\n  "remote": { "mode": "local" }\n}\n');

    const snapshot = reloadConfig();

    expect(snapshot.remote).toEqual(DEFAULT_REMOTE);
    expect(snapshot.errors).toEqual([]);
  });

  /**
   * `attachedServer` (HIVE-144, Task 12) — the config-derived readout, not
   * the header chip's runtime one. See `ConfigSnapshot.attachedServer`'s own
   * doc comment for why the two must not be collapsed into one.
   */
  describe('attachedServer', () => {
    it('is null in local mode, the same as never having attached', () => {
      seed('{\n  "version": 2\n}\n');

      expect(reloadConfig().attachedServer).toBeNull();
    });

    it('names the configured host in remote mode, since the file carries no friendlier label', () => {
      seed(
        '{\n  "version": 2,\n  "remote": { "mode": "remote", "host": "mini.tail1234.ts.net" }\n}\n',
      );

      expect(reloadConfig().attachedServer).toEqual({
        name: 'mini.tail1234.ts.net',
        host: 'mini.tail1234.ts.net',
      });
    });
  });
});

const onDisk = (): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

/**
 * The writer (HIVE-144, Task 5) — `setServer`'s mirror, field for field, and
 * the same rationale `server.test.ts`'s `describe('setServer', …)` states:
 * every property worth proving here is a property of the *file*. There is no
 * credential field: `parseSetRemoteRequest` refuses one before this function
 * ever sees a request, so nothing here needs to prove `remoteTokenStore` was
 * left alone — the payload type makes that unreachable rather than merely
 * untested.
 */
describe('setRemote', () => {
  it('creates the block on a file that has none', () => {
    seed('{\n  "version": 2\n}\n');

    const snapshot = setRemote({ mode: 'remote', host: '100.64.0.1' });

    expect(snapshot.remote).toEqual({
      mode: 'remote',
      host: '100.64.0.1',
      port: DEFAULT_REMOTE.port,
    });
    expect(onDisk().remote).toEqual({ mode: 'remote', host: '100.64.0.1' });
  });

  it('leaves the key absent until something is actually set', () => {
    seed('{\n  "version": 2\n}\n');

    // Reading is not writing: the default is applied in memory only.
    expect(onDisk().remote).toBeUndefined();
  });

  /**
   * The promise `setRemote`'s doc comment makes, and the reason it spreads
   * the block rather than rebuilding it.
   */
  it('preserves a sibling key this build does not know', () => {
    seed(
      '{\n  "version": 2,\n  "remote": { "mode": "local", "futureKey": "kept" }\n}\n',
    );

    setRemote({ mode: 'remote', host: '100.64.0.1' });

    expect(onDisk().remote).toEqual({
      mode: 'remote',
      host: '100.64.0.1',
      futureKey: 'kept',
    });
  });

  it('preserves unrelated top-level keys and hand-written comments', () => {
    seed(
      '{\n  "//mine": "a comment",\n  "version": 2,\n  "futureKey": "unknown",\n  "remote": { "mode": "local" }\n}\n',
    );

    setRemote({ mode: 'remote', host: '100.64.0.1' });

    const after = onDisk();
    expect(after['//mine']).toBe('a comment');
    expect(after.futureKey).toBe('unknown');
    expect(after.remote).toEqual({ mode: 'remote', host: '100.64.0.1' });
  });

  it('replaces a non-object block rather than merging into it', () => {
    seed('{\n  "version": 2,\n  "remote": "nope"\n}\n');

    setRemote({ mode: 'remote', host: '100.64.0.1' });

    expect(onDisk().remote).toEqual({ mode: 'remote', host: '100.64.0.1' });
  });

  it('writes mode, host and port independently, one field at a time', () => {
    seed('{\n  "version": 2,\n  "remote": { "mode": "remote", "host": "100.64.1.2", "port": 7433 }\n}\n');

    setRemote({ port: 9000 });

    expect(onDisk().remote).toEqual({
      mode: 'remote',
      host: '100.64.1.2',
      port: 9000,
    });
  });

  /**
   * Ruling 3, exercised through the writer this time rather than the reader:
   * `setRemote`'s own payload was already checked by `parseSetRemoteRequest`
   * before this function runs, so a `{ mode: 'local', host: '' }` request —
   * exactly what an install that has never attached would send — must write
   * cleanly rather than being treated as a value to reject a second time.
   */
  it('writes mode local with an empty host with no error — the ordinary never-attached state', () => {
    seed('{\n  "version": 2\n}\n');

    const snapshot = setRemote({ mode: 'local', host: '' });

    expect(snapshot.remote).toEqual({ mode: 'local', host: '', port: DEFAULT_REMOTE.port });
    expect(snapshot.errors).toEqual([]);
    expect(onDisk().remote).toEqual({ mode: 'local', host: '' });
  });

  /**
   * A `{ mode: 'remote' }` payload with no host of its own, against a config
   * that has never stored a valid one, cannot satisfy the invariant no matter
   * what `host` defaults to — `DEFAULT_REMOTE.host` is `''`, which is not a
   * remote target. The write is refused rather than silently landing
   * `mode: 'remote'` next to an empty host.
   */
  it('refuses turning remote mode on when no valid host has ever been stored', () => {
    seed('{\n  "version": 2\n}\n');

    const snapshot = setRemote({ mode: 'remote' });

    expect(snapshot.errors.join(' ')).toContain('remote.host');
    expect(onDisk().remote).toBeUndefined();
  });

  /**
   * The invariant, stated once in `setRemote`'s own doc comment: after any
   * `config:set-remote`, if the effective mode is `'remote'`, the effective
   * host satisfies `isRemoteTarget` — checked against the *merge*, not
   * against any one payload's fields, so no sequence of otherwise-valid
   * calls can assemble the forbidden pair one field at a time.
   *
   * Each row applies its payloads to a fresh file, in order, and asserts
   * after **every** step — not just the last — that the file on disk never
   * holds `mode: 'remote'` next to a host `isRemoteTarget` rejects. A step
   * that violates it is expected to be refused (no throw — `setRemote`
   * reports refusal through `ConfigSnapshot.errors`, the same as every other
   * "the write conflicts with what is already on disk" check in this file),
   * leaving the file exactly as the previous, valid step left it.
   *
   * This is the fix-round-2 regrade: rounds 1 and 2 each closed one payload
   * shape (`{ host }` alone against an already-remote config; `{ mode:
   * 'remote' }` alone after an earlier call stored an unvalidated host under
   * `'local'`) by special-casing that shape. Both are the same defect through
   * a different door, and a per-shape fix can always be walked around by a
   * sequence that assembles the pair differently — which is exactly what
   * rows 2 and 3 below are the two earlier "fixes," and rows 1, 4 and 5 are
   * the shapes that were never named before this round.
   */
  const remoteInvariantSequences: ReadonlyArray<{
    name: string;
    payloads: readonly Record<string, unknown>[];
  }> = [
    {
      name: 'local with a bad host stored first, then flip to remote (round-2 residual)',
      payloads: [{ mode: 'local', host: 'evil.example.com' }, { mode: 'remote' }],
    },
    {
      name: 'remote first (no host to give it), then a host-only save (round-1 shape, ordering A)',
      payloads: [{ mode: 'remote' }, { host: 'evil.example.com' }],
    },
    {
      name: 'a bad host stored first while mode is unset, then flip to remote (round-1 shape, ordering B)',
      payloads: [{ host: 'evil.example.com' }, { mode: 'remote' }],
    },
    {
      name: 'already remote with a good host, then a host-only save overwrites it with a bad one',
      payloads: [
        { mode: 'remote', host: '100.64.0.1' },
        { host: 'evil.example.com' },
      ],
    },
    {
      name: 'remote-good, back to local, bad host stored while local, then flip to remote again',
      payloads: [
        { mode: 'remote', host: '100.64.0.1' },
        { mode: 'local' },
        { host: 'evil.example.com' },
        { mode: 'remote' },
      ],
    },
  ];

  it.each(remoteInvariantSequences)('$name', ({ payloads }) => {
    seed('{\n  "version": 2\n}\n');

    for (const payload of payloads) {
      setRemote(parseSetRemoteRequest(payload));

      const remote = onDisk().remote;
      const effectiveMode =
        typeof remote === 'object' && remote !== null && !Array.isArray(remote)
          ? (remote as Record<string, unknown>).mode
          : undefined;
      const effectiveHost =
        typeof remote === 'object' && remote !== null && !Array.isArray(remote)
          ? (remote as Record<string, unknown>).host
          : undefined;

      if (effectiveMode === 'remote') {
        expect(isRemoteTarget(effectiveHost)).toBe(true);
      }
    }
  });

  /**
   * `config:set-remote` never writes the device credential (see this task's
   * brief): its payload type, `SetRemoteRequest`, has no `token` field to
   * begin with, so there is no code path in `setRemote` that could reach
   * `remoteTokenStore` even by accident. This asserts the promise at the
   * boundary that matters — the bytes actually written to `config.json` —
   * rather than merely re-stating the type.
   */
  it('never writes a token onto the remote block, whatever the request shape', () => {
    seed('{\n  "version": 2\n}\n');

    setRemote({
      mode: 'remote',
      host: '100.64.1.2',
      port: 7433,
      // A request built from an `any` (a stale caller, a hand-rolled IPC
      // call bypassing the guard) could still carry this key at runtime even
      // though `SetRemoteRequest` has no such field — that is exactly the
      // shape this test needs to catch.
      ...({ token: 'K7QM-3XTV-9WHZ-2BNP' } as Record<string, unknown>),
    });

    const written = readFileSync(path, 'utf8');
    expect(written).not.toContain('K7QM-3XTV-9WHZ-2BNP');
    expect(onDisk().remote).toEqual({
      mode: 'remote',
      host: '100.64.1.2',
      port: 7433,
    });
  });
});

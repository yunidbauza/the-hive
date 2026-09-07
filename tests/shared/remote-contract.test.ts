import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CH, EVENT_CHANNELS, type Channel } from '@shared/ipc-contract';
import {
  CHANNEL_AUTHORIZATION,
  FRAME_KIND,
  REMOTE_PROTOCOL_VERSION,
  authorizationOf,
  frameKindOf,
  isAuthorized,
} from '@shared/remote-contract';

/**
 * The contract's two maps, checked against the thing they claim to describe
 * (HIVE-141).
 *
 * A map keyed by `CH` cannot be missing a channel — `satisfies Record<Channel,
 * …>` makes that a compile error, and the `@ts-expect-error` case below proves
 * it. What a type cannot prove is that the *values* are right: nothing stops
 * `pty:write` being classified `read`, or a push being called a `call`. So this
 * file reads `electron/preload/index.ts` and derives the answer, rather than
 * restating it and agreeing with itself.
 *
 * Reading a source file in a unit test is unusual and deliberate. The bridge is
 * the only place that knows which verb a channel actually uses; a fixture would
 * be a third copy to keep in sync, and it would go stale in exactly the silence
 * this test exists to break.
 */

const PRELOAD = readFileSync(
  join(process.cwd(), 'electron/preload/index.ts'),
  'utf8',
);

/** `CH` keys used with a given `ipcRenderer` verb in the bridge. */
const bridgeKeys = (pattern: RegExp): ReadonlySet<string> =>
  new Set([...PRELOAD.matchAll(pattern)].map((match) => match[1]));

const invoked = bridgeKeys(/ipcRenderer\.invoke\(\s*CH\.([A-Za-z0-9]+)/g);
const sent = bridgeKeys(/ipcRenderer\.send\(\s*CH\.([A-Za-z0-9]+)/g);
const subscribed = bridgeKeys(/subscribe<[^>]*>\(\s*CH\.([A-Za-z0-9]+)/g);

const entries = Object.entries(CH) as ReadonlyArray<[string, Channel]>;

describe('remote contract: coverage', () => {
  it('classifies every channel exactly once for frame kind', () => {
    expect(entries).toHaveLength(114);
    expect(Object.keys(FRAME_KIND).sort()).toEqual([...Object.values(CH)].sort());
  });

  it('classifies every channel exactly once for authorization', () => {
    expect(Object.keys(CHANNEL_AUTHORIZATION).sort()).toEqual(
      [...Object.values(CH)].sort(),
    );
  });

  it('has no channel classified by only one of the two maps', () => {
    expect(Object.keys(FRAME_KIND).sort()).toEqual(
      Object.keys(CHANNEL_AUTHORIZATION).sort(),
    );
  });
});

describe('remote contract: frame kinds match the preload bridge', () => {
  it.each(entries)('%s is classified as the bridge uses it', (key, channel) => {
    const expected = invoked.has(key)
      ? 'call'
      : sent.has(key)
        ? 'notify'
        : subscribed.has(key)
          ? 'event'
          : null;

    expect(expected, `${key} is not used by any verb in the bridge`).not.toBeNull();
    expect(frameKindOf(channel)).toBe(expected);
  });

  it('splits 86 call, 6 notify and 22 event', () => {
    const tally = { call: 0, notify: 0, event: 0 };
    for (const kind of Object.values(FRAME_KIND)) tally[kind] += 1;

    expect(tally).toEqual({ call: 86, notify: 6, event: 22 });
  });

  /**
   * The correction that reading the bridge forced.
   *
   * `EVENT_CHANNELS` is not the set of pushed channels — it is 18 of the 22.
   * `slack:socket-status` and the three `notifications:*` pushes are subscribed
   * without being listed there. A remote client that forwarded only
   * `EVENT_CHANNELS` would show an empty inbox on a busy server, so the
   * asymmetry is asserted rather than left to be rediscovered.
   */
  it('covers EVENT_CHANNELS and the four pushes it omits', () => {
    for (const channel of EVENT_CHANNELS) expect(frameKindOf(channel)).toBe('event');

    const listed: ReadonlySet<string> = new Set(EVENT_CHANNELS);
    const pushed = Object.entries(FRAME_KIND)
      .filter(([, kind]) => kind === 'event')
      .map(([channel]) => channel);

    expect(pushed.filter((channel) => !listed.has(channel)).sort()).toEqual([
      'notifications:dismissed',
      'notifications:new',
      'notifications:read',
      'slack:socket-status',
    ]);
  });
});

describe('remote contract: authorization', () => {
  /** The five the ticket pins, and the reason the table exists at all. */
  it.each([
    CH.ptySpawn,
    CH.ptyWrite,
    CH.fsWriteFile,
    CH.configSetRuntime,
    CH.agentsRun,
  ])('%s is execute', (channel) => {
    expect(authorizationOf(channel)).toBe('execute');
  });

  it('grades the 114 as 61 read, 37 mutate and 16 execute', () => {
    const tally = { read: 0, mutate: 0, execute: 0 };
    for (const authz of Object.values(CHANNEL_AUTHORIZATION)) tally[authz] += 1;

    expect(tally).toEqual({ read: 61, mutate: 37, execute: 16 });
  });

  it('grades every push as read — a client observes an event, never causes one', () => {
    for (const [channel, kind] of Object.entries(FRAME_KIND)) {
      if (kind !== 'event') continue;
      expect(authorizationOf(channel as Channel)).toBe('read');
    }
  });

  it('never grades a read-classified channel as one that writes to disk', () => {
    expect(authorizationOf(CH.fsReadFile)).toBe('read');
    expect(authorizationOf(CH.fsWriteFile)).not.toBe('read');
  });
});

describe('remote contract: default deny', () => {
  it.each([
    'pty:spwan',
    'config:set-everything',
    '',
    '__proto__',
    'constructor',
    'toString',
  ])('refuses the unlisted channel %j', (channel) => {
    expect(authorizationOf(channel)).toBeNull();
    expect(frameKindOf(channel)).toBeNull();
    expect(isAuthorized(channel, 'execute')).toBe(false);
  });

  /**
   * `__proto__` and `toString` are in that list for a reason: a lookup written
   * as `MAP[channel] ?? deny` would answer `[Function: toString]` for the last
   * one and inherit its way past the gate. `Object.hasOwn` is what makes the
   * deny real, and this asserts the property rather than the implementation.
   */
  it('does not inherit a classification from Object.prototype', () => {
    expect(Object.hasOwn(FRAME_KIND, 'toString')).toBe(false);
    expect(isAuthorized('toString', 'execute')).toBe(false);
  });
});

describe('remote contract: the authorization ladder', () => {
  it('lets execute cover mutate and read', () => {
    expect(isAuthorized(CH.configGet, 'execute')).toBe(true);
    expect(isAuthorized(CH.configSetJira, 'execute')).toBe(true);
    expect(isAuthorized(CH.ptySpawn, 'execute')).toBe(true);
  });

  it('lets mutate cover read but not execute', () => {
    expect(isAuthorized(CH.configGet, 'mutate')).toBe(true);
    expect(isAuthorized(CH.configSetJira, 'mutate')).toBe(true);
    expect(isAuthorized(CH.ptySpawn, 'mutate')).toBe(false);
  });

  it('lets read cover only read', () => {
    expect(isAuthorized(CH.configGet, 'read')).toBe(true);
    expect(isAuthorized(CH.configSetJira, 'read')).toBe(false);
    expect(isAuthorized(CH.fsWriteFile, 'read')).toBe(false);
  });
});

describe('remote contract: the version handshake', () => {
  it('is a positive integer, so a mismatch is orderable', () => {
    expect(Number.isInteger(REMOTE_PROTOCOL_VERSION)).toBe(true);
    expect(REMOTE_PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('remote contract: an unclassified channel is a compile error', () => {
  it('rejects a map that omits a channel', () => {
    // @ts-expect-error — a Record<Channel, …> missing 113 of its 114 keys. This
    // line is the acceptance criterion: delete the directive and `pnpm
    // type-check` must fail, which is what proves the maps above cannot go
    // stale when `CH` grows.
    const partial: Record<Channel, 'read'> = { [CH.configGet]: 'read' };

    expect(partial[CH.configGet]).toBe('read');
  });
});

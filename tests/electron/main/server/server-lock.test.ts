import { describe, expect, it } from 'vitest';

import {
  claimServerLock,
  hasActiveServerLock,
  type ServerLockIo,
} from '../../../../electron/main/server/server-lock';

const LOCK_PATH = '/tmp/the-hive-server.lock';

function harness(
  contents: string | undefined,
  livePids: readonly number[] = [],
  recoveryGuardHeld = false,
  recoveryIdentity = '42:current',
) {
  let stored = contents;
  let recoveryStored = recoveryGuardHeld
    ? `{"pid":42,"identity":"${recoveryIdentity}"}`
    : undefined;
  const writes: string[] = [];
  const removed: string[] = [];
  const io: ServerLockIo & {
    createRecoveryGuard: (path: string, contents?: string) => void;
    removeRecoveryGuard: (path: string) => void;
    processIdentity: (pid: number) => string | null;
  } = {
    create: (_path, next) => {
      if (stored !== undefined) {
        const cause = new Error('already exists') as NodeJS.ErrnoException;
        cause.code = 'EEXIST';
        throw cause;
      }
      stored = next;
      writes.push(next);
    },
    read: (path) => {
      const target = path.endsWith('.recovery') ? recoveryStored : stored;
      if (target === undefined) {
        const cause = new Error('not found') as NodeJS.ErrnoException;
        cause.code = 'ENOENT';
        throw cause;
      }
      return target;
    },
    remove: (path) => {
      if (path.endsWith('.recovery')) recoveryStored = undefined;
      else {
        stored = undefined;
        removed.push(LOCK_PATH);
      }
    },
    createRecoveryGuard: (_path, next = '') => {
      if (recoveryStored !== undefined) {
        const cause = new Error('already exists') as NodeJS.ErrnoException;
        cause.code = 'EEXIST';
        throw cause;
      }
      recoveryStored = next;
    },
    removeRecoveryGuard: () => {
      recoveryStored = undefined;
    },
    processIdentity: (pid) =>
      pid === 99 || livePids.includes(pid) ? `${String(pid)}:current` : null,
  };
  return { io, writes, removed, contents: () => stored };
}

describe('server lock', () => {
  it('reports a lock owned by a live server as active', () => {
    const { io } = harness('{"pid":42,"identity":"42:current"}', [42]);

    expect(hasActiveServerLock(LOCK_PATH, io)).toBe(true);
  });

  it('replaces a stale lock before claiming server ownership', () => {
    const { io, writes, removed, contents } = harness('{"pid":42,"identity":"42:old"}');

    const claim = claimServerLock(LOCK_PATH, 99, io);

    expect(claim.kind).toBe('claimed');
    expect(removed).toEqual([LOCK_PATH]);
    expect(writes).toEqual(['{"pid":99,"identity":"99:current"}']);
    expect(contents()).toBe('{"pid":99,"identity":"99:current"}');
  });

  it('does not replace a stale lock while another claimant is recovering it', () => {
    const { io, contents, removed } = harness('{"pid":42,"identity":"42:old"}', [42], true);

    expect(claimServerLock(LOCK_PATH, 99, io)).toEqual({ kind: 'active' });
    expect(contents()).toBe('{"pid":42,"identity":"42:old"}');
    expect(removed).toEqual([]);
  });

  it('fails closed for a malformed lock', () => {
    const { io } = harness('not-json');

    expect(hasActiveServerLock(LOCK_PATH, io)).toBe(true);
  });

  it('reclaims a recovery guard whose owner PID was reused', () => {
    const { io, contents } = harness('{"pid":42,"identity":"42:old"}', [42], true, '42:old');

    expect(claimServerLock(LOCK_PATH, 99, io).kind).toBe('claimed');
    expect(contents()).toBe('{"pid":99,"identity":"99:current"}');
  });

  it('does not mistake a reused PID for the lock owner', () => {
    const { io } = harness('{"pid":42,"identity":"42:old"}', [42]);

    expect(hasActiveServerLock(LOCK_PATH, io)).toBe(false);
  });

  it('releases only the lock it claimed', () => {
    const { io, removed } = harness(undefined);
    const claim = claimServerLock(LOCK_PATH, 99, io);

    expect(claim.kind).toBe('claimed');
    if (claim.kind === 'claimed') claim.release();

    expect(removed).toEqual([LOCK_PATH]);
  });
});

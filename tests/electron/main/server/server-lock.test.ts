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
) {
  let stored = contents;
  let guardHeld = recoveryGuardHeld;
  const writes: string[] = [];
  const removed: string[] = [];
  const io: ServerLockIo & {
    createRecoveryGuard: (path: string) => void;
    removeRecoveryGuard: (path: string) => void;
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
    read: () => {
      if (stored === undefined) {
        const cause = new Error('not found') as NodeJS.ErrnoException;
        cause.code = 'ENOENT';
        throw cause;
      }
      return stored;
    },
    remove: () => {
      stored = undefined;
      removed.push(LOCK_PATH);
    },
    createRecoveryGuard: () => {
      if (guardHeld) {
        const cause = new Error('already exists') as NodeJS.ErrnoException;
        cause.code = 'EEXIST';
        throw cause;
      }
      guardHeld = true;
    },
    removeRecoveryGuard: () => {
      guardHeld = false;
    },
    isProcessAlive: (pid) => livePids.includes(pid),
  };
  return { io, writes, removed, contents: () => stored };
}

describe('server lock', () => {
  it('reports a lock owned by a live server as active', () => {
    const { io } = harness('{"pid":42}', [42]);

    expect(hasActiveServerLock(LOCK_PATH, io)).toBe(true);
  });

  it('replaces a stale lock before claiming server ownership', () => {
    const { io, writes, removed, contents } = harness('{"pid":42}');

    const claim = claimServerLock(LOCK_PATH, 99, io);

    expect(claim.kind).toBe('claimed');
    expect(removed).toEqual([LOCK_PATH]);
    expect(writes).toEqual(['{"pid":99}']);
    expect(contents()).toBe('{"pid":99}');
  });

  it('does not replace a stale lock while another claimant is recovering it', () => {
    const { io, contents, removed } = harness('{"pid":42}', [], true);

    expect(claimServerLock(LOCK_PATH, 99, io)).toEqual({ kind: 'active' });
    expect(contents()).toBe('{"pid":42}');
    expect(removed).toEqual([]);
  });

  it('fails closed for a malformed lock', () => {
    const { io } = harness('not-json');

    expect(hasActiveServerLock(LOCK_PATH, io)).toBe(true);
  });

  it('releases only the lock it claimed', () => {
    const { io, removed } = harness(undefined);
    const claim = claimServerLock(LOCK_PATH, 99, io);

    expect(claim.kind).toBe('claimed');
    if (claim.kind === 'claimed') claim.release();

    expect(removed).toEqual([LOCK_PATH]);
  });
});

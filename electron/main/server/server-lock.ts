import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { configPath } from '../config/paths';

export interface ServerLockIo {
  create: (path: string, contents: string) => void;
  read: (path: string) => string;
  remove: (path: string) => void;
  createRecoveryGuard: (path: string) => void;
  removeRecoveryGuard: (path: string) => void;
  isProcessAlive: (pid: number) => boolean;
}

export type ServerLockClaim =
  | { kind: 'claimed'; release: () => void }
  | { kind: 'active' };

function errorCode(cause: unknown): string | undefined {
  return typeof cause === 'object' && cause !== null && 'code' in cause
    ? (cause as NodeJS.ErrnoException).code
    : undefined;
}

function defaultIo(): ServerLockIo {
  return {
    create(path, contents) {
      mkdirSync(dirname(path), { recursive: true });
      const descriptor = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(descriptor, contents, 'utf8');
      } finally {
        closeSync(descriptor);
      }
    },
    read: (path) => readFileSync(path, 'utf8'),
    remove: (path) => unlinkSync(path),
    createRecoveryGuard(path) {
      mkdirSync(dirname(path), { recursive: true });
      const descriptor = openSync(path, 'wx', 0o600);
      closeSync(descriptor);
    },
    removeRecoveryGuard: (path) => unlinkSync(path),
    isProcessAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (cause) {
        if (errorCode(cause) === 'ESRCH') return false;
        throw cause;
      }
    },
  };
}

function lockPid(contents: string): number | null {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      typeof parsed.pid === 'number' &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0
    ) {
      return parsed.pid;
    }
  } catch {
    return null;
  }
  return null;
}

export function serverLockPath(): string {
  return join(dirname(configPath()), 'server.lock');
}

export function hasActiveServerLock(path: string, io: ServerLockIo = defaultIo()): boolean {
  let contents: string;
  try {
    contents = io.read(path);
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') return false;
    throw cause;
  }

  const pid = lockPid(contents);
  return pid === null || io.isProcessAlive(pid);
}

export function claimServerLock(
  path: string = serverLockPath(),
  pid: number = process.pid,
  io: ServerLockIo = defaultIo(),
): ServerLockClaim {
  const contents = JSON.stringify({ pid });
  const recoveryGuardPath = `${path}.recovery`;

  try {
    io.createRecoveryGuard(recoveryGuardPath);
  } catch (cause) {
    if (errorCode(cause) === 'EEXIST') return { kind: 'active' };
    throw cause;
  }

  const releaseRecoveryGuard = (): void => {
    try {
      io.removeRecoveryGuard(recoveryGuardPath);
    } catch (cause) {
      if (errorCode(cause) !== 'ENOENT') throw cause;
    }
  };

  let result: ServerLockClaim | undefined;
  try {
    let exists = true;
    try {
      io.read(path);
    } catch (cause) {
      if (errorCode(cause) === 'ENOENT') exists = false;
      else throw cause;
    }

    if (exists) {
      if (hasActiveServerLock(path, io)) {
        result = { kind: 'active' };
      } else {
        io.remove(path);
      }
    }

    if (result === undefined) {
      try {
        io.create(path, contents);
      } catch (cause) {
        if (errorCode(cause) === 'EEXIST') result = { kind: 'active' };
        else throw cause;
      }
    }

    result ??= {
      kind: 'claimed',
      release: () => {
        try {
          if (io.read(path) === contents) io.remove(path);
        } catch (cause) {
          if (errorCode(cause) !== 'ENOENT') throw cause;
        }
      },
    };
  } catch (cause) {
    releaseRecoveryGuard();
    throw cause;
  }
  releaseRecoveryGuard();
  if (result === undefined) throw new Error('server lock claim did not resolve');
  return result;
}
